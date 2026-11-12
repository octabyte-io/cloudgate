import { addDomainToConfig } from './domain';
import type { FileConfig } from './file-types';
import { createPathMiddlewares } from './middleware';
import type { TraefikDomain } from './types';

/** One Domain of a `stack` Compose, with the service inside the file it routes to. */
export type ComposeStackDomain = TraefikDomain & { serviceName: string };

/**
 * The Swarm service `docker stack deploy -c … <appName>` makes of one service in
 * the file: `<appName>_<service>`. The whole name rather than the bare service
 * alias Swarm also gives it, because two stacks on `cloudgate-network` can both
 * call a service `web`, and only the prefixed name resolves to one of them.
 */
export const composeStackServiceHost = (
  appName: string,
  serviceName: string,
): string => `${appName}_${serviceName}`;

/**
 * The file-provider config that routes a `stack` Compose's Domains.
 *
 * Swarm keeps `deploy.labels` on the service object, not on its task
 * containers, and the only providers a Server's `traefik.yml` turns on are
 * `docker` (containers) and `file`, so a label-routed stack was never routed.
 * It is routed here the way an Application is: {@link addDomainToConfig} per
 * Domain, so HTTPS, the certificate choice, `redirect-to-https`, the path
 * middlewares and a Domain's own `middlewares` come out exactly as they do for
 * an Application Domain, and the router and service names are
 * `traefik/config/names.ts`' own.
 *
 * What differs is only the backend, {@link composeStackServiceHost} on the
 * Domain's `port`, and what an Application has that a Compose does not:
 * redirects and basic-auth users are Application rows, and a Compose Domain
 * cannot be put behind forward auth (`ForwardAuthService.findApplicationDomain`
 * refuses it), so the flag is never read here — a router naming a gate this
 * file does not define would be dropped by Traefik.
 *
 * Traefik reaches the service over whichever network it shares with it — the
 * shared overlay, or the stack's own for an isolated deployment — because the
 * deploy joins every routed service to that network and connects Traefik to it
 * (`getBuildComposeCommand`); the name resolves on either.
 */
export const createComposeStackTraefikConfig = (
  appName: string,
  domains: readonly ComposeStackDomain[],
): FileConfig => {
  const app = { appName, redirects: [], security: [] };
  const config: FileConfig = { http: { routers: {}, services: {} } };
  const middlewares = {};
  for (const domain of domains) {
    const routed = { ...domain, forwardAuthEnabled: false };
    addDomainToConfig(
      config,
      app,
      routed,
      composeStackServiceHost(appName, domain.serviceName),
    );
    Object.assign(middlewares, createPathMiddlewares(appName, routed));
  }
  if (Object.keys(middlewares).length > 0 && config.http) {
    config.http.middlewares = middlewares;
  }
  return config;
};
