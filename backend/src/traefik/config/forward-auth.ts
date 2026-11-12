import type { FileConfig, HttpMiddleware } from './file-types';
import type { CertificateType } from './types';

/** Traefik service name fronting the SSO proxy container. */
export const FORWARD_AUTH_TRAEFIK_SERVICE = 'forward-auth-proxy';
/** Container name/port of the oauth2-proxy the forward-auth phase deploys. */
export const FORWARD_AUTH_SERVICE_NAME = 'cloudgate-forward-auth';
export const FORWARD_AUTH_PORT = 4180;

export interface AuthGate {
  authDomain: string;
  https: boolean;
}

export interface AuthDomainConfig extends AuthGate {
  certificateType: CertificateType;
  customCertResolver?: string | null;
}

export const forwardAuthMiddlewareName = (
  appName: string,
  uniqueConfigKey: number,
): string => `forward-auth-${appName}-${uniqueConfigKey}`;

/**
 * Per-domain SSO gate: the forwardAuth check plus an errors middleware
 * that rewrites its 401 to a 302 redirect to the proxy's login page. The
 * router must list `-errors` before the main middleware.
 */
export const createForwardAuthMiddlewares = (
  appName: string,
  uniqueConfigKey: number,
  authGate: AuthGate,
): Record<string, HttpMiddleware> => {
  const name = forwardAuthMiddlewareName(appName, uniqueConfigKey);
  const scheme = authGate.https ? 'https' : 'http';

  return {
    [name]: {
      forwardAuth: {
        address: `${scheme}://${authGate.authDomain}/oauth2/auth`,
        trustForwardHeader: true,
        authResponseHeaders: [
          'X-Auth-Request-User',
          'X-Auth-Request-Email',
          'X-Auth-Request-Preferred-Username',
          'Authorization',
        ],
      },
    },
    [`${name}-errors`]: {
      errors: {
        status: ['401-403'],
        service: FORWARD_AUTH_TRAEFIK_SERVICE,
        query: '/oauth2/sign_in?rd={url}',
        statusRewrites: { '401': 302 },
      },
    },
  };
};

/**
 * Central auth-domain config: routes /oauth2/* on the org's auth domain
 * to the SSO proxy, at high priority so app routers never shadow it.
 */
export const buildAuthDomainRouter = (cfg: AuthDomainConfig): FileConfig => {
  const config: FileConfig = {
    http: {
      routers: {
        'forward-auth-oauth': {
          rule: `Host(\`${cfg.authDomain}\`) && PathPrefix(\`/oauth2/\`)`,
          service: FORWARD_AUTH_TRAEFIK_SERVICE,
          entryPoints: [cfg.https ? 'websecure' : 'web'],
          priority: 1000,
        },
      },
      services: {
        [FORWARD_AUTH_TRAEFIK_SERVICE]: {
          loadBalancer: {
            servers: [
              {
                url: `http://${FORWARD_AUTH_SERVICE_NAME}:${FORWARD_AUTH_PORT}`,
              },
            ],
            passHostHeader: true,
          },
        },
      },
    },
  };

  const router = config.http!.routers!['forward-auth-oauth'];
  if (cfg.https) {
    if (cfg.certificateType === 'letsencrypt') {
      router.tls = { certResolver: 'letsencrypt' };
    } else if (cfg.certificateType === 'custom' && cfg.customCertResolver) {
      router.tls = { certResolver: cfg.customCertResolver };
    } else {
      router.tls = {};
    }
  }

  return config;
};
