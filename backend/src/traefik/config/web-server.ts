import { GATEWAY_PATH } from '../../ai-models/ai-model-endpoint';
import type { FileConfig } from './file-types';
import type { CertificateType } from './types';

/**
 * The name of the console's own config file, without the extension —
 * `dynamic/cloudgate.yml`.
 *
 * Exported for H-61 rather than left as a local literal: the file has
 * three readers now — `SettingsService.updateServerTraefik` writes it,
 * `TraefikWriterService` names it, and `config/names.ts` indexes the routers
 * inside it so a rejection there is recognised. `settings.service.ts` still
 * passes the string, so this is one spelling gaining callers rather than a
 * rename (§1.4).
 */
export const CONSOLE_CONFIG_NAME = 'cloudgate';

/**
 * The two routers that put this console on a hostname.
 *
 * Exported for the same reason `names.ts` exports the Application router
 * builders: the index that maps Traefik's `routerName=` back to something a
 * person can act on has to agree with the generator **to the byte**, and a
 * second copy of a template string is exactly where that stops being true.
 * These are constants rather than functions because the console has one name.
 */
export const CONSOLE_ROUTER = `${CONSOLE_CONFIG_NAME}-router-app`;
export const CONSOLE_SECURE_ROUTER = `${CONSOLE_CONFIG_NAME}-router-app-secure`;

const ROUTER = CONSOLE_ROUTER;
const ROUTER_SECURE = CONSOLE_SECURE_ROUTER;
const SERVICE = `${CONSOLE_CONFIG_NAME}-service-app`;

/**
 * The Gateway's own routers on the console's host (the gateway ADR):
 * `/ai/<AI model>/v1/*` straight to the backend, not through the console's
 * Next rewrite, which cuts a request after 240 s of silence and would cut a
 * long stream.
 */
export const GATEWAY_ROUTER = `${CONSOLE_CONFIG_NAME}-router-gateway`;
export const GATEWAY_SECURE_ROUTER = `${CONSOLE_CONFIG_NAME}-router-gateway-secure`;
const GATEWAY_SERVICE = `${CONSOLE_CONFIG_NAME}-service-gateway`;

/**
 * The Gateway's path. `/ai` is no console page, and the backend's REST routes
 * are the console's under its `/backend` rewrite, so the whole prefix is the
 * Gateway's (the spec's "Gateway path").
 */
const GATEWAY_PATH_RULE = `PathPrefix(\`${GATEWAY_PATH}/\`)`;

/** `deploy/install.sh`'s `CONSOLE_PORT` default — the Next console's listener. */
export const DEFAULT_CONSOLE_PORT = 3000;

/** Last resort when nothing in the environment names an address. */
const FALLBACK_CONSOLE_HOST = '127.0.0.1';

const SCHEME_DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

export interface WebServerSettings {
  host: string;
  https: boolean;
  certificateType?: CertificateType | null;
  /**
   * Where Traefik proxies the console — a full origin, not a port. See
   * {@link resolveConsoleUpstream}; this used to be a bare port pasted onto a
   * hardcoded `cloudgate` container hostname.
   */
  consoleUrl: string;
  /**
   * Where Traefik sends the Gateway's calls: the backend's own listener (see
   * {@link resolveGatewayUpstream}). Absent, no Gateway router is written.
   */
  gatewayUrl?: string;
}

/** The environment keys {@link resolveConsoleUpstream} reads. */
export interface ConsoleUpstreamEnv {
  /** Explicit override — a whole origin, e.g. `http://cloudgate:3000`. */
  CLOUDGATE_CONSOLE_URL?: string | null;
  /** The address operators and browsers reach this instance on. */
  CLOUDGATE_PUBLIC_HOST?: string | null;
  /**
   * The port the console process listens on. Typed loosely because
   * `ConfigService.get` hands back the raw `process.env` string for a key it
   * did not validate at boot.
   */
  CONSOLE_PORT?: number | string | null;
  /** The console's origin — what the install contract already sets it to. */
  BETTER_AUTH_URL?: string | null;
}

const parseUrl = (value?: string | null): URL | null => {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/** A bare IPv6 literal is only legal in a URL inside brackets. */
const bracketed = (host: string): string =>
  host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

/**
 * The origin Traefik should send console traffic to.
 *
 * This used to be `http://cloudgate:${PORT}` — the name of a container
 * that exists only in a containerised deployment, on `PORT`
 * (the *API*'s 4000) rather than the console's 3000. On the native install this
 * project ships (`deploy/install.sh`) there is no such container, so
 * `dynamic/cloudgate.yml` 502s; and even in a container shape it named the
 * wrong listener whenever UI and API are split.
 *
 * The native install is now the default, resolved from what that install
 * already puts in the backend's environment:
 *
 * 1. `CLOUDGATE_CONSOLE_URL`, verbatim, when the operator names one. This is
 *    the escape hatch for any other shape — set it to `http://cloudgate:3000`
 *    to get the old containerised target back.
 * 2. `CLOUDGATE_PUBLIC_HOST` + `CONSOLE_PORT`, the install script's own inputs.
 * 3. Whatever of those two is missing is taken from `BETTER_AUTH_URL`, which
 *    `deploy/install.sh` sets to `http://<public host>:<console port>` — it is
 *    documented there as "the CONSOLE's origin, not this service's", so it is
 *    the one value guaranteed to be present and to name the console.
 *
 * Note the address has to be reachable *from inside the Traefik container*,
 * which is why the public host is the right answer and a loopback address is
 * not — `127.0.0.1` there is Traefik itself. It remains the last-resort
 * fallback only because there is nothing better to guess.
 */
export const resolveConsoleUpstream = (env: ConsoleUpstreamEnv): string => {
  const explicit = env.CLOUDGATE_CONSOLE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const consoleOrigin = parseUrl(env.BETTER_AUTH_URL);
  const scheme = consoleOrigin?.protocol === 'https:' ? 'https:' : 'http:';
  const host =
    env.CLOUDGATE_PUBLIC_HOST?.trim() ||
    consoleOrigin?.hostname ||
    FALLBACK_CONSOLE_HOST;
  const configuredPort = Number(env.CONSOLE_PORT) || undefined;
  const port =
    configuredPort ??
    (consoleOrigin
      ? Number(consoleOrigin.port) || SCHEME_DEFAULT_PORTS[scheme]
      : undefined) ??
    DEFAULT_CONSOLE_PORT;

  return `${scheme}//${bracketed(host)}:${port}`;
};

/**
 * The backend's own origin as Traefik reaches it, for the Gateway's router:
 * the console upstream's host, on the backend's `PORT`, over plain
 * HTTP, which is what the backend listens on. The console and the backend
 * run on one host (`deploy/install.sh`), so the host {@link
 * resolveConsoleUpstream} found reachable from Traefik's container is the
 * backend's too.
 */
export const resolveGatewayUpstream = (
  consoleUpstream: string,
  backendPort: number,
): string => {
  const host = parseUrl(consoleUpstream)?.hostname || FALLBACK_CONSOLE_HOST;
  return `http://${bracketed(host)}:${backendPort}`;
};

/**
 * Routers + service exposing Cloudgate's own UI/API through Traefik.
 * Merges into the existing config so routers of other config files'
 * concerns (none today) and manual tweaks to the web router survive a
 * host change.
 */
export const createWebServerConfig = (
  config: FileConfig,
  settings: WebServerSettings,
): FileConfig => {
  config.http = config.http || { routers: {}, services: {} };
  config.http.routers = config.http.routers || {};
  config.http.services = config.http.services || {};

  const router = config.http.routers[ROUTER] || {
    rule: `Host(\`${settings.host}\`)`,
    service: SERVICE,
    entryPoints: ['web'],
  };
  router.rule = `Host(\`${settings.host}\`)`;
  config.http.routers[ROUTER] = router;

  config.http.services[SERVICE] = {
    loadBalancer: {
      servers: [{ url: settings.consoleUrl }],
      passHostHeader: true,
    },
  };

  if (settings.https) {
    router.middlewares = ['redirect-to-https'];
    config.http.routers[ROUTER_SECURE] = {
      rule: `Host(\`${settings.host}\`)`,
      service: SERVICE,
      entryPoints: ['websecure'],
      ...(settings.certificateType === 'letsencrypt'
        ? { tls: { certResolver: 'letsencrypt' } }
        : {}),
    };
  } else {
    delete config.http.routers[ROUTER_SECURE];
    router.middlewares = [];
  }

  writeGatewayRouters(config, settings);
  return config;
};

/**
 * The Gateway's two routers, beside the console's on the same host and entry
 * points, but on a rule naming only its paths. Traefik ranks a longer
 * rule first, so they win over the console's `Host` rule without a priority.
 */
function writeGatewayRouters(
  config: FileConfig,
  settings: WebServerSettings,
): void {
  const routers = config.http!.routers!;
  const services = config.http!.services!;
  if (!settings.gatewayUrl) {
    delete routers[GATEWAY_ROUTER];
    delete routers[GATEWAY_SECURE_ROUTER];
    delete services[GATEWAY_SERVICE];
    return;
  }
  const rule = `Host(\`${settings.host}\`) && ${GATEWAY_PATH_RULE}`;
  routers[GATEWAY_ROUTER] = {
    rule,
    service: GATEWAY_SERVICE,
    entryPoints: ['web'],
    middlewares: settings.https ? ['redirect-to-https'] : [],
  };
  if (settings.https) {
    routers[GATEWAY_SECURE_ROUTER] = {
      rule,
      service: GATEWAY_SERVICE,
      entryPoints: ['websecure'],
      ...(settings.certificateType === 'letsencrypt'
        ? { tls: { certResolver: 'letsencrypt' } }
        : {}),
    };
  } else {
    delete routers[GATEWAY_SECURE_ROUTER];
  }
  services[GATEWAY_SERVICE] = {
    loadBalancer: { servers: [{ url: settings.gatewayUrl }] },
  };
}
