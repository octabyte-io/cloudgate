import type { FileConfig, HttpRouter, HttpService } from './file-types';
import {
  domainRouterName,
  domainSecureRouterName,
  domainServiceName,
} from './names';
import { pathRuleClause } from './path-rule';
import type { TraefikApp, TraefikDomain } from './types';

/**
 * Traefik requires ASCII host rules, so internationalized domain names are
 * converted to punycode (e.g. "тест.рф" → "xn--e1aybc.xn--p1ai").
 */
const toPunycode = (host: string): string => {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host;
  }
};

/**
 * The backend one Domain's router forwards to: `upstream` on the Domain's port.
 * `upstream` is the Swarm service name Traefik resolves on the network it shares
 * with it — an Application's `appName`, or a `stack` Compose service's
 * `<appName>_<service>` (`compose-stack.ts`).
 */
export const createServiceConfig = (
  upstream: string,
  domain: TraefikDomain,
): HttpService => ({
  loadBalancer: {
    servers: [{ url: `http://${upstream}:${domain.port || 80}` }],
    passHostHeader: true,
  },
});

export const createRouterConfig = (
  app: TraefikApp,
  domain: TraefikDomain,
  entryPoint: string,
): HttpRouter => {
  const { appName } = app;
  const {
    host,
    https,
    uniqueConfigKey,
    certificateType,
    path,
    stripPath,
    internalPath,
  } = domain;

  const routerConfig: HttpRouter = {
    rule: `Host(\`${toPunycode(host)}\`)${pathRuleClause(path)}`,
    service: domainServiceName(appName, uniqueConfigKey),
    middlewares: [],
    entryPoints: [entryPoint],
  };

  // Web router with HTTPS only redirects — all other middlewares run on
  // the websecure router where the request actually lands.
  const isRedirectRouter =
    entryPoint === 'web' && https && !domain.customEntrypoint;
  if (isRedirectRouter) {
    routerConfig.middlewares?.push('redirect-to-https');
  } else {
    // stripPrefix must come before addPrefix so Traefik strips the public
    // path first, then prepends the internal path.
    if (stripPath && path && path !== '/') {
      routerConfig.middlewares?.push(
        `stripprefix-${appName}-${uniqueConfigKey}`,
      );
    }
    if (internalPath && internalPath !== '/' && internalPath !== path) {
      routerConfig.middlewares?.push(`addprefix-${appName}-${uniqueConfigKey}`);
    }

    // Preview-deployment wildcard subdomains must not inherit the parent
    // app's redirect rules (e.g. www-redirect).
    if (domain.domainType !== 'preview') {
      for (const redirect of app.redirects) {
        routerConfig.middlewares?.push(
          `redirect-${appName}-${redirect.uniqueConfigKey}`,
        );
      }
    }

    if (app.security.length > 0) {
      routerConfig.middlewares?.push(`auth-${appName}`);
    }

    // Forward-auth gate before custom middlewares so authentication runs
    // first; -errors must precede it so a 401 from the auth check is
    // rewritten to a 302 redirect to the login page.
    if (domain.forwardAuthEnabled) {
      const name = `forward-auth-${appName}-${uniqueConfigKey}`;
      routerConfig.middlewares?.push(`${name}-errors`, name);
    }

    if (domain.middlewares && domain.middlewares.length > 0) {
      routerConfig.middlewares?.push(...domain.middlewares);
    }
  }

  if (entryPoint === 'websecure' || (domain.customEntrypoint && https)) {
    if (certificateType === 'letsencrypt') {
      routerConfig.tls = { certResolver: 'letsencrypt' };
    } else if (certificateType === 'custom' && domain.customCertResolver) {
      routerConfig.tls = { certResolver: domain.customCertResolver };
    } else if (certificateType === 'stored') {
      // TLS with no resolver: Traefik serves the certificate from
      // Settings → Certificates whose names cover the host, matched by SNI.
      routerConfig.tls = {};
    }
  }

  return routerConfig;
};

/**
 * Merges one domain's routers + service into an existing config without
 * touching routers owned by other domains of the app. `upstream` defaults to
 * the app's own Swarm service; see {@link createServiceConfig}.
 */
export const addDomainToConfig = (
  config: FileConfig,
  app: TraefikApp,
  domain: TraefikDomain,
  upstream: string = app.appName,
): FileConfig => {
  const { appName } = app;
  const { uniqueConfigKey } = domain;

  const routerName = domainRouterName(appName, uniqueConfigKey);
  const routerNameSecure = domainSecureRouterName(appName, uniqueConfigKey);
  const serviceName = domainServiceName(appName, uniqueConfigKey);

  config.http = config.http || { routers: {}, services: {} };
  config.http.routers = config.http.routers || {};
  config.http.services = config.http.services || {};

  config.http.routers[routerName] = createRouterConfig(app, domain, 'web');

  if (domain.https) {
    config.http.routers[routerNameSecure] = createRouterConfig(
      app,
      domain,
      'websecure',
    );
  } else {
    delete config.http.routers[routerNameSecure];
  }

  config.http.services[serviceName] = createServiceConfig(upstream, domain);

  return config;
};

/**
 * Deletes the routers + service a domain owns; everything else in the
 * config is left untouched. The writer removes the whole file when no
 * routers remain.
 */
export const removeDomainFromConfig = (
  config: FileConfig,
  appName: string,
  uniqueConfigKey: number,
): FileConfig => {
  const routerName = domainRouterName(appName, uniqueConfigKey);
  const routerNameSecure = domainSecureRouterName(appName, uniqueConfigKey);
  const serviceName = domainServiceName(appName, uniqueConfigKey);

  delete config.http?.routers?.[routerName];
  delete config.http?.routers?.[routerNameSecure];
  delete config.http?.services?.[serviceName];

  return config;
};
