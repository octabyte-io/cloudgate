import { Injectable, Logger } from '@nestjs/common';
import type { CreateServiceOptions } from 'dockerode';
import { serviceLogDriver } from '../../common/config/container-logs';
import { RemoteDockerFactory } from '../../docker/remote-docker.factory';
import { readSwarmServiceHealth } from '../../docker/swarm-service-health';
import type { SwarmServiceHealth } from '../../docker/swarm-service-health';
import { CLOUDGATE_NETWORK } from '../../servers/server-audit';
import { FORWARD_AUTH_SERVICE_NAME } from '../../traefik/config/forward-auth';
import { buildForwardAuthEnv, FORWARD_AUTH_IMAGE } from './forward-auth.utils';
import type { ForwardAuthEnvOptions } from './forward-auth.utils';

export interface SetupForwardAuthOptions extends ForwardAuthEnvOptions {
  serverId?: string | null;
}

/**
 * What a probe of the proxy found on a target — the shared Swarm read's shape,
 * kept under this name because that is what the proxy's callers ask for.
 *
 * The read itself moved to `docker/swarm-service-health.ts`: it was one of two
 * copies, and the deployment engine's convergence poll would have been a third.
 * The `?? 1` for an absent `Replicas` — a global service wants one task per
 * Server, not none — is this file's reading, and it is the one that won.
 */
export type ForwardAuthProxyHealth = SwarmServiceHealth;

/**
 * The oauth2-proxy swarm service that answers /oauth2/* on a server's auth
 * domain. One per Traefik instance, always
 * under the same service name, so the Traefik generators can address it by name.
 */
@Injectable()
export class ForwardAuthProxyService {
  private readonly logger = new Logger(ForwardAuthProxyService.name);

  constructor(private readonly dockerFactory: RemoteDockerFactory) {}

  /**
   * Creates the proxy, or force-updates the running one so it picks up new env.
   * A 409 from create means something else won it in between, which is fine.
   */
  async setup(options: SetupForwardAuthOptions): Promise<void> {
    const docker = await this.dockerFactory.getRemoteDocker(options.serverId);

    const settings: CreateServiceOptions = {
      Name: FORWARD_AUTH_SERVICE_NAME,
      TaskTemplate: {
        ContainerSpec: {
          Image: FORWARD_AUTH_IMAGE,
          Env: buildForwardAuthEnv(options),
        },
        Networks: [{ Target: CLOUDGATE_NETWORK }],
        Placement: {
          Constraints: ['node.role==manager'],
        },
        // The last container Cloudgate creates that had no log ceiling.
        // It is the one most likely to need one, too — oauth2-proxy exits
        // non-zero on bad configuration and Swarm restarts it, so a misconfigured
        // provider is a crash loop writing its whole startup log per restart.
        LogDriver: serviceLogDriver(),
      },
      Mode: {
        Replicated: {
          Replicas: 1,
        },
      },
    };

    try {
      const service = docker.getService(FORWARD_AUTH_SERVICE_NAME);
      const inspect = (await service.inspect()) as {
        Version: { Index: string };
        Spec: { TaskTemplate: { ForceUpdate: number } };
      };
      await service.update({
        version: Number.parseInt(inspect.Version.Index, 10),
        ...settings,
        TaskTemplate: {
          ...settings.TaskTemplate,
          ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
        },
      });
      this.logger.log('Forward auth proxy updated');
    } catch {
      try {
        await docker.createService(settings);
        this.logger.log('Forward auth proxy started');
      } catch (error) {
        if ((error as { statusCode?: number })?.statusCode !== 409) {
          throw error;
        }
        this.logger.log('Forward auth proxy already exists, continuing');
      }
    }
  }

  /** Removes the proxy; a missing one is not an error, since absent is the goal. */
  async remove(serverId?: string | null): Promise<void> {
    const docker = await this.dockerFactory.getRemoteDocker(serverId);
    try {
      await docker.getService(FORWARD_AUTH_SERVICE_NAME).remove();
      this.logger.log('Forward auth proxy removed');
    } catch {
      // Nothing to remove.
    }
  }

  /**
   * Whether the proxy is up, read off the tasks rather than the service object.
   * `inspect()` resolves for the whole life of a service whose every task exits
   * 1, so a check that stops there reads a proxy that never came up as running
   * for ever. The tasks are the only place a swarm service admits that.
   */
  async health(serverId?: string | null): Promise<ForwardAuthProxyHealth> {
    const docker = await this.dockerFactory.getRemoteDocker(serverId);
    return readSwarmServiceHealth(docker, FORWARD_AUTH_SERVICE_NAME);
  }
}
