/**
 * Traefik v2/v3 dynamic file-provider config, trimmed to the pieces
 * Cloudgate generates; extend it when a generator needs more of Traefik's
 * schema.
 */
export interface FileConfig {
  http?: {
    routers?: Record<string, HttpRouter>;
    services?: Record<string, HttpService>;
    middlewares?: Record<string, HttpMiddleware>;
  };
  tls?: {
    certificates?: TlsCertificate[];
  };
}

export interface TlsCertificate {
  certFile: string;
  keyFile: string;
}

export interface HttpRouter {
  rule: string;
  service: string;
  entryPoints?: string[];
  middlewares?: string[];
  priority?: number;
  tls?: {
    certResolver?: string;
    /** The names to ask `certResolver` for, rather than the rule's hosts. */
    domains?: { main: string; sans?: string[] }[];
  };
}

export interface HttpLoadBalancerService {
  servers: { url: string }[];
  passHostHeader?: boolean;
}

export interface HttpService {
  loadBalancer?: HttpLoadBalancerService;
}

export interface BasicAuthMiddleware {
  users?: string[];
  removeHeader?: boolean;
}

export interface ForwardAuthMiddleware {
  address: string;
  trustForwardHeader?: boolean;
  authResponseHeaders?: string[];
}

export interface ErrorsMiddleware {
  status?: string[];
  service?: string;
  query?: string;
  /** Maps an original status to a new one (e.g. { "401": 302 }). */
  statusRewrites?: Record<string, number>;
}

export type HttpMiddleware =
  | { addPrefix: { prefix: string } }
  | { stripPrefix: { prefixes: string[]; forceSlash?: boolean } }
  /** Request headers set, or removed by an empty value. */
  | { headers: { customRequestHeaders: Record<string, string> } }
  | {
      redirectRegex: {
        regex: string;
        replacement: string;
        permanent?: boolean;
      };
    }
  | { basicAuth: BasicAuthMiddleware }
  | { forwardAuth: ForwardAuthMiddleware }
  | { errors: ErrorsMiddleware };
