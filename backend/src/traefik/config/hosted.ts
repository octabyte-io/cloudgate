import { GATEWAY_PATH } from '../../ai-models/ai-model-endpoint';
import { REALTIME_GATEWAY_PATHS } from '../../realtime/gateway-paths';
import type { FileConfig, HttpRouter } from './file-types';

/**
 * The Hosted instance's own routing: one hostname, HTTPS with a Let's
 * Encrypt certificate, the six WebSocket gateways to the API and everything
 * else to the console.
 *
 * Written by `deploy/install.sh`'s hosted path, through the
 * `hosted-traefik-config` command, into `dynamic/hosted.yml` — its own file
 * rather than `dynamic/cloudgate.yml`, which Settings > Web server owns and
 * removes when the console's domain is cleared. Every router and service here
 * is named `hosted-*`, so a Web server save naming the same host adds routers
 * of its own beside these rather than colliding with them (Traefik drops a
 * router two files define).
 *
 * Why the sockets need routing of their own: the console proxies REST and
 * `/api/auth/*` to the backend, but not WebSockets, and they authenticate by
 * the session cookie alone — so the browser must dial them on the console's
 * own origin, where Traefik hands them to the backend.
 *
 * The Gateway's `/ai/` prefix goes to the backend too, as Settings > Web
 * server routes it: through the console's rewrite a long stream is cut
 * after 240 s of silence.
 */
export interface HostedTraefikSettings {
  /** The one hostname the Hosted instance answers on. */
  host: string;
  /** The console's listener as Traefik's container reaches it. */
  consoleUrl: string;
  /** The backend's listener as Traefik's container reaches it. */
  apiUrl: string;
}

export const HOSTED_CONFIG_NAME = 'hosted';

const CONSOLE_SERVICE = `${HOSTED_CONFIG_NAME}-console`;
const API_SERVICE = `${HOSTED_CONFIG_NAME}-api`;

/**
 * Exact paths, not prefixes: a gateway answers on its path alone (the query
 * string carries its parameters, and Traefik's `Path` ignores the query), and
 * a prefix such as `/terminal` would also take any console page starting with
 * those letters.
 */
export const REALTIME_RULE = REALTIME_GATEWAY_PATHS.map(
  (path) => `Path(\`${path}\`)`,
).join(' || ');

const GATEWAY_RULE = `PathPrefix(\`${GATEWAY_PATH}/\`)`;

export function createHostedTraefikConfig(
  settings: HostedTraefikSettings,
): FileConfig {
  const host = `Host(\`${settings.host}\`)`;
  const routers: Record<string, HttpRouter> = {};

  // Traefik ranks a longer rule first, so the two path routers win over the
  // console's bare `Host` rule without a priority.
  const route = (name: string, rule: string, service: string) => {
    routers[name] = {
      rule,
      service,
      entryPoints: ['web'],
      middlewares: ['redirect-to-https'],
    };
    routers[`${name}-secure`] = {
      rule,
      service,
      entryPoints: ['websecure'],
      tls: { certResolver: 'letsencrypt' },
    };
  };
  route(
    `${HOSTED_CONFIG_NAME}-realtime`,
    `${host} && (${REALTIME_RULE})`,
    API_SERVICE,
  );
  route(
    `${HOSTED_CONFIG_NAME}-gateway`,
    `${host} && ${GATEWAY_RULE}`,
    API_SERVICE,
  );
  route(`${HOSTED_CONFIG_NAME}-console`, host, CONSOLE_SERVICE);

  return {
    http: {
      routers,
      services: {
        [CONSOLE_SERVICE]: {
          loadBalancer: {
            servers: [{ url: settings.consoleUrl }],
            passHostHeader: true,
          },
        },
        [API_SERVICE]: {
          loadBalancer: {
            servers: [{ url: settings.apiUrl }],
            passHostHeader: true,
          },
        },
      },
    },
  };
}
