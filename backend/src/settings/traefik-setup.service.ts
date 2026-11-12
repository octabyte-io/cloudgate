import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { ContainerCreateOptions, CreateServiceOptions } from 'dockerode';
import {
  containerLogConfig,
  serviceLogDriver,
} from '../common/config/container-logs';
import { compose } from '../compose/compose.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { RemoteDockerFactory } from '../docker/remote-docker.factory';
import { execByServer } from '../docker-ops/server-access';
import { RemoteExecService } from '../remote/remote-exec.service';
import { CLOUDGATE_AI_NETWORK } from '../ai-models/ai-network';
import { CLOUDGATE_NETWORK } from '../servers/server-audit';
import {
  TRAEFIK_HTTP3_PORT,
  TRAEFIK_PORT,
  TRAEFIK_SSL_PORT,
  TRAEFIK_VERSION,
} from '../servers/server-setup';
import { dnsChallengeOn } from './dns-challenge.read';
import { withDnsCredentials } from './dns-challenge.utils';
import { DockerResourceService, ResourcePort } from './docker-resource.service';
import {
  TRAEFIK_CONTAINER_DYNAMIC_DIR,
  TRAEFIK_CONTAINER_NAME,
  mainTraefikDirectory,
} from './traefik-files.service';

/**
 * Traefik's version and port knobs — defined once, in
 * `servers/server-setup.ts`, and re-exported here so this module's importers
 * keep the names they had.
 *
 * The direction of the import is the one this file already uses for
 * CLOUDGATE_NETWORK: `server-setup.ts` is a leaf of string builders that
 * imports nothing from settings. What matters is that there is one value —
 * `writeTraefikSetup` recreates the very container the setup script created, so
 * two definitions meant Traefik changed version and port set as a side effect
 * of an unrelated settings change.
 */
export { TRAEFIK_HTTP3_PORT, TRAEFIK_PORT, TRAEFIK_SSL_PORT, TRAEFIK_VERSION };

// One name, shared with the service that rotates Traefik's access log and has to
// find the same container to signal it.
const CONTAINER_NAME = TRAEFIK_CONTAINER_NAME;

/**
 * The dynamic dir as mounted on hosts: the mount **source**, which is a path on
 * the machine whose daemon resolves it — this instance's own tree under
 * CLOUDGATE_DIRECTORY for the platform host, and the tree
 * `serverSetupCommand` created for a Server. The bind *target* stays
 * {@link TRAEFIK_CONTAINER_DYNAMIC_DIR} whichever machine it is, because that is
 * the path *inside* Traefik's container that the main config's file provider
 * watches.
 *
 * **This is the third member of the set and the reason the conversion is one
 * commit.** The container mounted here is what *reads* the `traefik.yml`
 * `TraefikFilesService.writeMainConfigOn` writes and the `dynamic/*.yml`
 * `TraefikWriterService` writes, both of which resolve the addressed machine's
 * root. Under the local root a Traefik recreated on a Server was handed a
 * `traefik.yml` that host does not have — Docker creates a *directory* in place
 * of a missing bind source, so the container came up with a directory where its
 * static config should be — and a dynamic directory nothing writes into.
 */
const hostDynamicTraefikPath = (serverId?: string | null) =>
  `${mainTraefikDirectory(serverId)}/dynamic`;

export interface TraefikOptions {
  env?: string[];
  // `string | null`, not `string | undefined`: the DTO hands the platform host
  // through as an explicit `null` now rather than 400ing on it, and every
  // dispatch that reads this option tests it for truthiness, which already read
  // the two the same way.
  serverId?: string | null;
  additionalPorts?: ResourcePort[];
}

/**
 * Recreate the platform's Traefik (standalone container or swarm service)
 * with new env and port sets, then reattach isolated compose networks.
 */
@Injectable()
export class TraefikSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly dockerFactory: RemoteDockerFactory,
    private readonly dockerResources: DockerResourceService,
    private readonly remoteExec: RemoteExecService,
  ) {}

  /**
   * Recreate Traefik in the form it runs in now, then reattach networks.
   *
   * The machine's DNS-01 credentials are merged into `env` here, on every
   * recreate, and win over a same-named key in it. Here rather than at
   * each caller because every caller builds `env` from something that cannot
   * hold them — the env editor's text, or Traefik's env read back with them
   * withheld — so the one place that recreates the container is the one place
   * that can keep them on it.
   */
  async writeTraefikSetup(input: TraefikOptions): Promise<void> {
    const dns = await dnsChallengeOn(this.db, input.serverId);
    input = {
      ...input,
      env: withDnsCredentials(input.env ?? [], dns?.credentials),
    };
    const resourceType = await this.dockerResources.getDockerResourceType(
      CONTAINER_NAME,
      input.serverId,
    );

    if (resourceType === 'service') {
      await this.initializeTraefikService(input);
      await this.reconnectServicesToTraefik(input.serverId);
    } else if (resourceType === 'standalone') {
      await this.initializeStandaloneTraefik(input);
      await this.reconnectServicesToTraefik(input.serverId);
    } else {
      throw new Error('Traefik resource type not found');
    }
  }

  /** Pull Traefik's image and recreate the standalone container. */
  async initializeStandaloneTraefik({
    env,
    serverId,
    additionalPorts = [],
  }: TraefikOptions = {}): Promise<void> {
    const imageName = `traefik:v${TRAEFIK_VERSION}`;

    const exposedPorts: Record<string, object> = {
      [`${TRAEFIK_PORT}/tcp`]: {},
      [`${TRAEFIK_SSL_PORT}/tcp`]: {},
      [`${TRAEFIK_HTTP3_PORT}/udp`]: {},
    };

    const portBindings: Record<string, Array<{ HostPort: string }>> = {
      [`${TRAEFIK_PORT}/tcp`]: [{ HostPort: TRAEFIK_PORT.toString() }],
      [`${TRAEFIK_SSL_PORT}/tcp`]: [{ HostPort: TRAEFIK_SSL_PORT.toString() }],
      [`${TRAEFIK_HTTP3_PORT}/udp`]: [
        { HostPort: TRAEFIK_HTTP3_PORT.toString() },
      ],
    };

    const enableDashboard = additionalPorts.some(
      (port) => port.targetPort === 8080,
    );
    if (enableDashboard) {
      exposedPorts['8080/tcp'] = {};
      portBindings['8080/tcp'] = [{ HostPort: '8080' }];
    }

    for (const port of additionalPorts) {
      const portKey = `${port.targetPort}/${port.protocol ?? 'tcp'}`;
      exposedPorts[portKey] = {};
      portBindings[portKey] = [{ HostPort: port.publishedPort.toString() }];
    }

    const settings: ContainerCreateOptions = {
      name: CONTAINER_NAME,
      Image: imageName,
      NetworkingConfig: {
        EndpointsConfig: {
          [CLOUDGATE_NETWORK]: {},
        },
      },
      ExposedPorts: exposedPorts,
      HostConfig: {
        RestartPolicy: {
          Name: 'always',
        },
        Binds: [
          `${mainTraefikDirectory(serverId)}/traefik.yml:/etc/traefik/traefik.yml`,
          `${hostDynamicTraefikPath(serverId)}:${TRAEFIK_CONTAINER_DYNAMIC_DIR}`,
          '/var/run/docker.sock:/var/run/docker.sock',
        ],
        PortBindings: portBindings,
        // The log ceiling. This method *recreates* the container the
        // provisioning scripts created, so without it any settings change — a
        // new port, the dashboard toggle — silently dropped the ceiling those
        // scripts set and put the INFO log back on an unbounded json-file
        // driver.
        LogConfig: containerLogConfig(),
      },
      Env: env,
    };

    const docker = await this.dockerFactory.getRemoteDocker(serverId);
    try {
      await docker.pull(imageName);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      console.log('Traefik Image Pulled ✅');
    } catch (error) {
      console.log('Traefik Image Not Found: Pulling ', error);
    }
    try {
      const container = docker.getContainer(CONTAINER_NAME);
      await container.remove({ force: true });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch {
      // Container didn't exist — nothing to remove.
    }

    try {
      await docker.createContainer(settings);
      const newContainer = docker.getContainer(CONTAINER_NAME);
      await newContainer.start();
      console.log('Traefik Started ✅');
    } catch (error) {
      console.log('Traefik Not Found: Starting ', error);
    }
  }

  /** Update the `cloudgate-traefik` swarm service, or create it if missing. */
  async initializeTraefikService({
    env,
    additionalPorts = [],
    serverId,
  }: TraefikOptions): Promise<void> {
    const imageName = `traefik:v${TRAEFIK_VERSION}`;

    const settings: CreateServiceOptions = {
      Name: CONTAINER_NAME,
      TaskTemplate: {
        ContainerSpec: {
          Image: imageName,
          Env: env,
          Mounts: [
            {
              Type: 'bind',
              Source: `${mainTraefikDirectory(serverId)}/traefik.yml`,
              Target: '/etc/traefik/traefik.yml',
            },
            {
              Type: 'bind',
              Source: hostDynamicTraefikPath(serverId),
              Target: TRAEFIK_CONTAINER_DYNAMIC_DIR,
            },
            {
              Type: 'bind',
              Source: '/var/run/docker.sock',
              Target: '/var/run/docker.sock',
            },
          ],
        },
        Networks: [{ Target: CLOUDGATE_NETWORK }],
        Placement: {
          Constraints: ['node.role==manager'],
        },
        // The same ceiling as the standalone path above, under Swarm's
        // spelling of it — Name/Options rather than Type/Config.
        LogDriver: serviceLogDriver(),
      },
      Mode: {
        Replicated: {
          Replicas: 1,
        },
      },
      EndpointSpec: {
        Ports: [
          {
            TargetPort: 443,
            PublishedPort: TRAEFIK_SSL_PORT,
            PublishMode: 'host',
            Protocol: 'tcp',
          },
          {
            TargetPort: 443,
            PublishedPort: TRAEFIK_SSL_PORT,
            PublishMode: 'host',
            Protocol: 'udp',
          },
          {
            TargetPort: 80,
            PublishedPort: TRAEFIK_PORT,
            PublishMode: 'host',
            Protocol: 'tcp',
          },
          ...additionalPorts.map((port) => ({
            TargetPort: port.targetPort,
            PublishedPort: port.publishedPort,
            Protocol: port.protocol as 'tcp' | 'udp' | 'sctp' | undefined,
            PublishMode: 'host' as const,
          })),
        ],
      },
    };

    const docker = await this.dockerFactory.getRemoteDocker(serverId);
    try {
      const service = docker.getService(CONTAINER_NAME);
      const inspect = (await service.inspect()) as {
        Version: { Index: string };
        Spec: { TaskTemplate: { ForceUpdate: number } };
      };

      await service.update({
        version: Number.parseInt(inspect.Version.Index),
        ...settings,
        TaskTemplate: {
          ...settings.TaskTemplate,
          ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
        },
      });
      console.log('Traefik Updated ✅');
    } catch {
      await docker.createService(settings);
      console.log('Traefik Started ✅');
    }
  }

  /**
   * Reattach isolated compose networks to Traefik.
   *
   * **`columns: { appName: true }` is not tidiness.**
   * `compose.composeFile` became `encryptedText`, joining `env`
   * and `refreshToken` on the same table, and `encryptedText` decrypts at the
   * driver boundary — so an unnarrowed `findMany` ran AES-256-GCM over three
   * columns of *every* isolated stack on the instance to read `appName` and
   * nothing else. This is a boot path: `writeTraefikSetup` calls it on both of
   * its arms, so the cost is paid every time the platform's Traefik is
   * recreated, and it scales with the number of isolated stacks rather than
   * with anything this method is about. The second half is worse than the cost:
   * decryption *throws* on a value it cannot read (ADR 0006 has no fail-open
   * passthrough), so an unnarrowed read gave a Traefik reconnect a way to fail
   * that it structurally did not have before — on a column it never looked at.
   *
   * `appName` alone rather than a wider `Pick`: the loop below builds one
   * `docker network connect` per row and reads no other field. ADR 0015's echo
   * bullet asks *who can see this value*; a projection asks the cheaper
   * question one step earlier, which is whether anything reads it at all.
   *
   * `test/settings/traefik-reconnect-projection.spec.ts` drives the compiled
   * statement rather than the options object, because the claim is about which
   * columns Postgres is asked for — the shape a later `with:` could silently
   * widen back.
   */
  async reconnectServicesToTraefik(serverId?: string | null): Promise<void> {
    const composeResult = await this.db.query.compose.findMany({
      columns: { appName: true },
      where: and(
        ...(serverId ? [eq(compose.serverId, serverId)] : []),
        eq(compose.isolatedDeployment, true),
      ),
    });

    if (!composeResult) {
      return;
    }
    // A recreated Traefik is back on `cloudgate-ai` wherever the
    // machine has it, or the gateway's hop to its AI models is cut.
    // A machine without the network, or a Traefik already on it, is fine.
    let commands = `{ docker network inspect ${CLOUDGATE_AI_NETWORK} >/dev/null 2>&1 && docker network connect ${CLOUDGATE_AI_NETWORK} $(docker ps --filter "name=${CONTAINER_NAME}" -q) >/dev/null 2>&1; } || true\n`;

    for (const row of composeResult) {
      // `row.appName` goes in bare, and stays safe only because
      // `APP_NAME_REGEX` guards it at its mint (`db/columns.ts`'s
      // `cleanAppName`, which the template and AI deploy paths use in place of a
      // DTO); `CONTAINER_NAME` is a module constant. Quoting made that regex
      // load-bearing here without saying so.
      commands += `docker network connect ${row.appName} $(docker ps --filter "name=${CONTAINER_NAME}" -q) >/dev/null 2>&1\n`;
    }

    await execByServer(this.remoteExec, serverId, commands);
  }
}
