import { ConflictException, Injectable } from '@nestjs/common';
import { quote } from 'shell-quote';
import { execByServer } from '../docker-ops/server-access';
import { RemoteExecService } from '../remote/remote-exec.service';
import { withoutEnvKeys } from './dns-challenge.utils';

/** The image tag this instance runs: `RELEASE_TAG`, else `latest`. */
export const getCloudgateImageTag = (): string =>
  process.env.RELEASE_TAG || 'latest';

/** The service/container name this instance runs under, when it runs in one. */
export const CLOUDGATE_RESOURCE = 'cloudgate';

/**
 * What `POST /settings/reload-server` answers when this instance is not a
 * Docker service or container at all.
 *
 * `deploy/install.sh` installs Cloudgate as two systemd units on the host, so
 * both inspects miss and the restart has nothing to force. That used to travel
 * as a bare `Error`, which the exception filter turned into a 500 and the
 * console rendered as "the backend hit an error … Try again" — advice that
 * cannot work here, on the install shape this project's own installer produces.
 *
 * It is a **409 and not a 503** on purpose: the console maps 502/503/504 to
 * "the backend is not answering", which is precisely wrong for a refusal the
 * backend composed in a millisecond, and passes a 409's own words straight
 * through (`error-message.ts`). The state of this host conflicts with the
 * request, which is what a 409 says.
 */
export const NOT_A_DOCKER_INSTALL_REFUSAL =
  'Cloudgate is not a Docker service or container on this host, which is what a native install ' +
  'looks like: restart it with systemctl restart cloudgate-backend cloudgate-console, and upgrade ' +
  'it the way the Upgrades section of docs/deploy.md describes';

export type DockerResourceType = 'service' | 'standalone' | 'unknown';

export interface ResourcePort {
  targetPort: number;
  publishedPort: number;
  protocol?: string;
}

/**
 * Probing and reloading the platform's own containers/services (cloudgate,
 * traefik) and reading their env/ports, local or over SSH. Every `resourceName`
 * interpolation is `quote()`d (H-92).
 *
 * Every caller passes a literal — `'cloudgate'`, `'cloudgate-traefik'`, or
 * `traefik-setup.service.ts`'s `CONTAINER_NAME` — so there is no reachable
 * payload here and the quoting moves no emitted byte for any of them
 * (`shell-quote` returns a word needing no quoting unchanged). It is here
 * because these are shell *programs*, whose interpolations are the builder's to
 * quote (§2.9), and because the `RESOURCE_NAME=` assignment below is the shape
 * that fails worst if a caller-supplied name ever reaches it: inside `"…"` a
 * `$(…)` substitutes, so that one site executed rather than word-split. The
 * `"$RESOURCE_NAME"` *uses* were always safe; the assignment was the sink.
 */
@Injectable()
export class DockerResourceService {
  constructor(private readonly remoteExec: RemoteExecService) {}

  /** Whether the name is a swarm service, a standalone container or neither. */
  async getDockerResourceType(
    resourceName: string,
    // `string | null`, not `string | undefined`: the DTO hands the platform host
    // through as an explicit `null` now rather than 400ing on it, and every
    // dispatch below is `execByServer`'s truthiness test, which already read the
    // two the same way.
    serverId?: string | null,
  ): Promise<DockerResourceType> {
    try {
      const command = `
RESOURCE_NAME=${quote([resourceName])}
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`;
      const { stdout } = await execByServer(this.remoteExec, serverId, command);
      const result = stdout.trim();
      if (result === 'service') return 'service';
      if (result === 'standalone') return 'standalone';
      return 'unknown';
    } catch (error) {
      console.error(error);
      return 'unknown';
    }
  }

  /**
   * Force-update a swarm service (the cloudgate service gets its versioned
   * image) or restart a standalone container.
   *
   * A name that is neither is a refusal rather than a crash when the name is
   * this instance's own — see `NOT_A_DOCKER_INSTALL_REFUSAL`. Every other
   * caller keeps the original error: "no `cloudgate-traefik` here" is a broken
   * platform host and not a supported install shape, and `reloadTraefik` logs
   * it rather than showing it to anybody.
   */
  async reloadDockerResource(
    resourceName: string,
    serverId?: string | null,
    version?: string,
  ): Promise<void> {
    const resourceType = await this.getDockerResourceType(
      resourceName,
      serverId,
    );
    let command = '';
    if (resourceType === 'service') {
      if (resourceName === 'cloudgate') {
        const currentImageTag = getCloudgateImageTag();
        let imageTag = version;
        if (currentImageTag === 'canary' || currentImageTag === 'feature') {
          imageTag = currentImageTag;
        }
        command = `docker service update --force --image cloudgate/cloudgate:${imageTag} ${quote([resourceName])}`;
      } else {
        command = `docker service update --force ${quote([resourceName])}`;
      }
    } else if (resourceType === 'standalone') {
      command = `docker restart ${quote([resourceName])}`;
    } else if (resourceName === CLOUDGATE_RESOURCE && !serverId) {
      throw new ConflictException(NOT_A_DOCKER_INSTALL_REFUSAL);
    } else {
      throw new Error('Resource type not found');
    }
    await execByServer(this.remoteExec, serverId, command);
  }

  /**
   * The resource's env as KEY=value lines, less any entry whose key is in
   * `withoutKeys` — taken out of the inspected array, before the join, so a
   * value holding a newline cannot carry a withheld key past the filter.
   * Traefik's DNS-01 credentials are withheld this way.
   */
  async readEnvironmentVariables(
    resourceName: string,
    serverId?: string | null,
    withoutKeys: Iterable<string> = [],
  ): Promise<string> {
    const resourceType = await this.getDockerResourceType(
      resourceName,
      serverId,
    );
    let command = '';
    if (resourceType === 'service') {
      command = `docker service inspect ${quote([resourceName])} --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'`;
    } else if (resourceType === 'standalone') {
      command = `docker container inspect ${quote([resourceName])} --format '{{json .Config.Env}}'`;
    }
    const { stdout } = await execByServer(this.remoteExec, serverId, command);
    const result = stdout.trim();
    if (result === 'null') {
      return '';
    }
    const env = (JSON.parse(result) as string[] | null) ?? [];
    return withoutEnvKeys(env, withoutKeys).join('\n');
  }

  /**
   * Published ports of the resource, without the 80/443 pair Traefik always
   * binds. Standalone mappings keep only the first entry per port to collapse
   * IPv4/IPv6 duplicates.
   */
  async readPorts(
    resourceName: string,
    serverId?: string | null,
  ): Promise<ResourcePort[]> {
    const resourceType = await this.getDockerResourceType(
      resourceName,
      serverId,
    );
    let command = '';
    if (resourceType === 'service') {
      command = `docker service inspect ${quote([resourceName])} --format '{{json .Spec.EndpointSpec.Ports}}'`;
    } else if (resourceType === 'standalone') {
      command = `docker container inspect ${quote([resourceName])} --format '{{json .NetworkSettings.Ports}}'`;
    } else {
      throw new Error('Resource type not found');
    }
    const { stdout } = await execByServer(this.remoteExec, serverId, command);
    const result = stdout.trim();

    if (result === 'null') {
      return [];
    }

    if (resourceType === 'service') {
      const parsed = JSON.parse(result) as Array<{
        TargetPort: number;
        PublishedPort: number;
        Protocol?: string;
      }>;
      return parsed
        .map((port) => ({
          targetPort: port.TargetPort,
          publishedPort: port.PublishedPort,
          protocol: port.Protocol,
        }))
        .filter((port) => port.targetPort !== 80 && port.targetPort !== 443);
    }

    const parsed = JSON.parse(result) as Record<
      string,
      Array<{ HostPort: string }> | null
    >;
    const ports: ResourcePort[] = [];
    const seenPorts = new Set<string>();
    for (const key in parsed) {
      if (Object.hasOwn(parsed, key)) {
        const containerPortMappings = parsed[key];
        const protocol = key.split('/')[1];
        const targetPort = Number.parseInt(key.split('/')[0] ?? '0', 10);

        const firstMapping = containerPortMappings?.[0];
        if (firstMapping) {
          const publishedPort = Number.parseInt(firstMapping.HostPort, 10);
          const portKey = `${targetPort}-${publishedPort}-${protocol}`;
          if (!seenPorts.has(portKey)) {
            seenPorts.add(portKey);
            ports.push({ targetPort, publishedPort, protocol });
          }
        }
      }
    }
    return ports.filter(
      (port) => port.targetPort !== 80 && port.targetPort !== 443,
    );
  }

  /** Who holds a port: a container, a host-level listener, or nobody. */
  async checkPortInUse(
    port: number,
    serverId?: string | null,
  ): Promise<{ isInUse: boolean; conflictingContainer?: string }> {
    try {
      const dockerCommand = `docker ps -a --format '{{.Names}}' | grep -v '^cloudgate-traefik$' | while read name; do docker port "$name" 2>/dev/null | grep -q ':${port}' && echo "$name" && break; done || true`;
      const { stdout: dockerOut } = await execByServer(
        this.remoteExec,
        serverId,
        dockerCommand,
      );

      const container = dockerOut.trim();
      if (container) {
        return {
          isInUse: true,
          conflictingContainer: `container "${container}"`,
        };
      }

      // The platform runs inside a container, so an ephemeral --net=host
      // busybox probes the host's network stack with nc.
      const hostCommand = `docker run --rm --net=host busybox sh -c 'nc -z 0.0.0.0 ${port} 2>/dev/null && echo in_use || echo free'`;
      const { stdout: hostOut } = await execByServer(
        this.remoteExec,
        serverId,
        hostCommand,
      );

      if (hostOut.includes('in_use')) {
        return { isInUse: true, conflictingContainer: 'a host-level service' };
      }

      return { isInUse: false };
    } catch (error) {
      console.error('Error checking port availability:', error);
      return { isInUse: false };
    }
  }
}
