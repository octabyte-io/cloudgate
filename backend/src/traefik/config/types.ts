/**
 * Plain inputs for the config generators. Later phases (domains, security,
 * redirects tables) will feed their rows through these shapes; generators
 * stay pure — no database, filesystem, or network access.
 */
/**
 * Who supplies a router's certificate. `stored` is a certificate from Settings
 * → Certificates: TLS on with no resolver, so Traefik picks the stored
 * certificate whose names cover the host out of its `tls.certificates`.
 */
export type CertificateType = 'none' | 'letsencrypt' | 'custom' | 'stored';

export interface TraefikDomain {
  host: string;
  https: boolean;
  /** Per-app unique key suffixing router/service/middleware names. */
  uniqueConfigKey: number;
  /** Container port the service listens on (defaults to 80). */
  port?: number | null;
  /** Public path prefix matched by the router (null or "/" = whole host). */
  path?: string | null;
  /** Path prepended before proxying (addprefix middleware). */
  internalPath?: string | null;
  /** Strip the public path prefix before proxying (stripprefix middleware). */
  stripPath?: boolean | null;
  certificateType?: CertificateType | null;
  customCertResolver?: string | null;
  /** Route on a custom entrypoint instead of web/websecure. */
  customEntrypoint?: string | null;
  /** Preview-deployment domains skip app-level redirect middlewares. */
  domainType?: 'application' | 'compose' | 'preview' | 'bucket' | null;
  /** Gate the domain behind the org's SSO forward-auth proxy. */
  forwardAuthEnabled?: boolean | null;
  /** Extra middleware names attached verbatim to the router. */
  middlewares?: string[] | null;
}

export interface TraefikApp {
  appName: string;
  /** Redirect rows; only the key feeds the middleware name here. */
  redirects: { uniqueConfigKey: number }[];
  /** Basic-auth rows; non-empty attaches the auth-<appName> middleware. */
  security: { username: string }[];
}
