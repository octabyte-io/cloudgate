import { z } from 'zod';
import {
  CLOUDGATE_DIRECTORY_REQUIREMENT,
  DEFAULT_CLOUDGATE_DIRECTORY,
  isValidCloudgateDirectory,
} from './cloudgate-directory';
import { isTrustProxyValue, TRUST_PROXY_REQUIREMENT } from './trust-proxy';
import {
  checkInstanceModeBoot,
  instanceModeEnv,
} from '../../instance-mode/instance-mode';

/**
 * Whether a string is already the origin a browser would send for it: the
 * URL parser's own `origin` drops a default port, lower-cases the host, and
 * carries no path, query, or credentials, so an entry that survives this
 * round-trip is one better-auth can actually match a request against.
 */
const isBrowserOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      value === url.origin
    );
  } catch {
    return false;
  }
};

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters long'),
  BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters long'),
  BETTER_AUTH_URL: z.url().optional(),
  // Browser origins better-auth trusts on top of BETTER_AUTH_URL's own,
  // comma-separated — `https://console.example.com,http://192.168.1.20:3000`.
  // Empty by default, which is the shipped arrangement: one dashboard, served
  // from the origin BETTER_AUTH_URL names. Set this for a second one — a staging
  // host, a LAN address alongside localhost, a client that does not proxy
  // /api/auth/* — since BETTER_AUTH_URL cannot be moved to reach it (it is also
  // the base of every link better-auth generates) and the runtime allowlist that
  // could have added it is behind the enterprise licence.
  //
  // Each entry has to be exactly what a browser puts in `Origin`: a scheme, a
  // host, and a port only when it is not the scheme's default. better-auth
  // normalizes the header and compares it to the entry verbatim, so a path, a
  // trailing slash, a `:443`, or an upper-case host is an entry that matches
  // nothing — the same undiagnosable "Invalid origin" this key exists to end.
  // Refused here, at boot, rather than at someone's first failed sign-in.
  TRUSTED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(
      z.array(
        z.string().refine(isBrowserOrigin, {
          message:
            'must be an origin a browser would send, such as https://console.example.com — scheme and host only, with no path, no trailing slash and no default port',
        }),
      ),
    ),
  // Origins allowed to call this API from a browser (main.ts's enableCors),
  // comma-separated — `https://console.example.com,https://ops.example.com`.
  // A wildcard is not legal alongside credentials and the session is a cookie,
  // so every authenticated call is credentialed and every origin has to be
  // named.
  //
  // Empty by default, which means *no* cross-origin browser client: the
  // shipped arrangement serves the browser from the frontend's own origin and
  // rewrites /api/auth/* and /backend/* through to here
  // (frontend/next.config.ts), so requests are same-origin and CORS never
  // applies. Set this only for a browser client served from somewhere else —
  // and name that origin in TRUSTED_ORIGINS too, or it will reach the REST
  // routes and still be refused at sign-in.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  // Where Traefik proxies this instance's own console when a domain is
  // assigned on /settings/instance. Only read by
  // traefik/config/web-server.ts's resolveConsoleUpstream, which documents the
  // order these are consulted in.
  //
  // CLOUDGATE_PUBLIC_HOST is `deploy/install.sh`'s one required input — the
  // address operators and browsers reach this instance on. CONSOLE_PORT is that
  // script's console port, 3000 unless it was overridden. A Self-hosted
  // install writes neither into the backend's env file, and need not:
  // BETTER_AUTH_URL is set to `http://<public host>:<console port>` and is
  // documented there as the console's origin, so it stands in for both. The
  // Hosted install writes CLOUDGATE_PUBLIC_HOST (`deploy/hosted.sh`), for
  // servers/server-address-guard.ts to refuse the box's NATed public address;
  // its CLOUDGATE_CONSOLE_URL outranks it for the console's upstream.
  //
  // CLOUDGATE_CONSOLE_URL is the escape hatch for a deployment that is not the
  // native one — set it to `http://cloudgate:3000` for the containerised shape,
  // where the console is a container on cloudgate-network.
  CLOUDGATE_PUBLIC_HOST: z.string().optional(),
  CONSOLE_PORT: z.coerce.number().int().positive().optional(),
  CLOUDGATE_CONSOLE_URL: z.url().optional(),
  // This API's own public origin — the console's NEXT_PUBLIC_API_URL, where a
  // browser dials the WebSockets the console does not proxy. Only advertised,
  // never dialled by this process: `GET /settings/about` hands it to
  // the Cloudgate CLI, which reaches REST through the console's /backend
  // rewrite but needs this for log streams. `deploy/install.sh` writes it; when
  // unset the answer says null and streaming commands cannot run.
  CLOUDGATE_API_URL: z.url().optional(),
  // Transactional mail (MailService) — optional; sends fail with a clear
  // error until MAIL_PROVIDER is set.
  MAIL_PROVIDER: z.enum(['smtp', 'resend']).optional(),
  MAIL_FROM_ADDRESS: z.string().optional(),
  SMTP_SERVER: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  // Docker image tag this instance runs (update checks / reload-server).
  RELEASE_TAG: z.string().optional(),
  // Root of this instance's own directory tree — deployment logs, source
  // trees, SSH keys, Traefik config, schedules.
  // /etc/cloudgate by default, which needs a privileged setup step; point it
  // somewhere writable to run the backend as an ordinary user.
  //
  // Only this host's tree moves. Paths sent to a remote Server stay at
  // /etc/cloudgate, because that is what the setup script created there — see
  // REMOTE_CLOUDGATE_DIRECTORY in ./cloudgate-directory.
  //
  // Validated rather than trusted: it is the containment boundary the
  // log-streaming gateway checks a path against (realtime/ws.utils.ts), so '/'
  // or a relative path here would widen what an authenticated caller can read.
  CLOUDGATE_DIRECTORY: z
    .string()
    .default(DEFAULT_CLOUDGATE_DIRECTORY)
    .refine(isValidCloudgateDirectory, CLOUDGATE_DIRECTORY_REQUIREMENT),
  // Which Template catalogue this instance reads (ADR-0062, ADR-0072): the
  // address of one `catalogue.zip`. Unset means the official one, the newest
  // `octabyte-io/cg-templates` release (`DEFAULT_TEMPLATES_URL` in
  // `templates/catalogue-source.ts`, where the default is applied, because
  // whether this key was set at all is what decides the old key's meaning
  // below). `off` turns templates off; the catalogue routes then answer a
  // coded 503.
  //
  // **A key rather than a request field because it once was a request field.**
  // A caller-named catalogue host was a caller-directed fetch out of the
  // platform host and a template the caller authored outright. Which catalogue
  // an instance trusts is decided once, here, by whoever installed it.
  //
  // http/https only: `file:` would make the catalogue the platform host's own
  // filesystem.
  CLOUDGATE_TEMPLATES_URL: z
    .union([z.literal('off'), z.url({ protocol: /^https?$/ })], {
      error: 'must be off or an http or https address of a catalogue.zip',
    })
    .optional(),
  // The `template.toml` reader's old setting, the base of a `meta.json` tree.
  // It is no longer read as an address (ADR-0066), only detected: while it is
  // set and CLOUDGATE_TEMPLATES_URL is not, templates are off and the startup
  // log and the templates screen say what to set, so an operator who pointed
  // it at an internal mirror is never silently switched to GitHub. Any text
  // is accepted, so the old value never stops an install from starting.
  CLOUDGATE_TEMPLATES_BASE_URL: z.string().optional(),
  // Which license server `/settings/license` activates, validates and
  // deactivates an enterprise key against — `LicenseApiClient` posts
  // `${base}/licenses/{activate,validate,deactivate}` to it.
  //
  // It defaults to the hosted one, which is what it was once hard-coded to, so
  // an existing install reads exactly as it did. What the key buys is
  // a self-hosted install that runs its own license service, and a way out of
  // an outage of the hosted one: on one build the activation
  // path answered an nginx 404, so no key could be activated at all and — with
  // no override — there was nothing an operator could do about it. A fix made
  // that legible (the console says the server answered HTTP 404 and that this
  // is not a decision about the key); this is the move it left missing.
  //
  // http/https only, and a trailing slash is trimmed rather than refused:
  // `//licenses` is a different path on a strict server.
  LICENSE_SERVER_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://licenses-api.cloudgate.dev')
    .transform((value) => value.replace(/\/+$/, '')),
  // Hosted mode (ADR-0049): the field comes from the instance-mode module,
  // the only code that reads it, and `validateEnv` runs that module's boot
  // check first. Off when unset.
  ...instanceModeEnv,
  // Public origin of the dashboard, for Stripe's checkout return URLs.
  // Billing falls back to http://localhost:3000 when it is unset; the Hosted
  // instance refuses to boot without it.
  SITE_URL: z.string().optional(),
  // Stripe (hosted billing). Ignored on a Self-hosted instance; the Hosted
  // instance refuses to boot without the key, the webhook secret and the three
  // price ids below.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // The Starter and Business plans' monthly prices and the Add-on's
  // (ADR-0054), the only three prices checkout sells. Required in hosted mode.
  STARTER_PLAN_PRICE_ID: z.string().optional(),
  BUSINESS_PLAN_PRICE_ID: z.string().optional(),
  ADD_ON_PRICE_ID: z.string().optional(),
  // Cloudflare Turnstile on the public sign-up form: the site key the
  // console's widget renders with (served on `GET /auth/sign-up-open`) and the
  // secret better-auth's captcha plugin verifies with. Required in hosted
  // mode, unread when self-hosted.
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  // Bought Servers (ADR-0071), Hosted instance only and unread when
  // self-hosted. Optional, unlike the Stripe settings: without both tokens the
  // instance starts and simply offers no *Buy a Server*. The EUR account's
  // read & write token makes and changes every machine; the empty USD
  // account's read-only token is only asked for prices, because the
  // provider's USD list is its own list rather than a conversion.
  HETZNER_EUR_API_TOKEN: z.string().optional(),
  HETZNER_USD_API_TOKEN: z.string().optional(),
  // The Octabyte domain a Bought Server's reverse DNS is named under,
  // `<short server id>.<domain>`, so the provider's name never shows on a
  // lookup. Optional: unset leaves the provider's default reverse DNS, and
  // the Operator page warns about it.
  BOUGHT_SERVER_REVERSE_DNS_DOMAIN: z.string().optional(),
  // Ports/version for the platform's own Traefik (settings traefik setup).
  TRAEFIK_PORT: z.coerce.number().int().positive().optional(),
  TRAEFIK_SSL_PORT: z.coerce.number().int().positive().optional(),
  TRAEFIK_HTTP3_PORT: z.coerce.number().int().positive().optional(),
  TRAEFIK_VERSION: z.string().optional(),
  // OpenTofu and the providers deploy/install.sh installed and checked, for
  // Cloud accounts (ADR-0030): the binary, and the folder a Cloud run's
  // CLI config makes the only place providers come from. The versions the
  // checkout expects are in cloud-accounts/tofu/tofu-environment.ts.
  OPENTOFU_VERSION: z.string().optional(),
  OPENTOFU_BINARY: z.string().optional(),
  OPENTOFU_PROVIDER_MIRROR: z.string().optional(),
  AWS_PROVIDER_VERSION: z.string().optional(),
  GOOGLE_PROVIDER_VERSION: z.string().optional(),
  // The Session Manager plugin deploy/install.sh installed and checked: the
  // tunnel a Stack VM on AWS is reached through (ADR-0070). Unset, the one on
  // PATH (`stack-vm/session-manager-tunnel.ts`).
  SESSION_MANAGER_PLUGIN: z.string().optional(),
  // The database login a Cloud run's `tofu` uses for the Infrastructure state
  // (ADR-0036): it reaches only the `infrastructure_state` schema, never
  // Cloudgate's own tables. install.sh creates it and writes this.
  INFRASTRUCTURE_STATE_DATABASE_URL: z.string().optional(),
  // The json-file retention cap Cloudgate puts on every container it creates —
  // Docker's own `max-size` and `max-file`, spelled the way `docker run
  // --log-opt` spells them. Nothing set either, so every container ran
  // unbounded; Traefik's INFO log makes it chatty and an ACME retry loop can then fill
  // the platform host's disk, which takes down every workload on it.
  //
  // Defaults are 10m × 3 = 30 MB per container, in ./container-logs — enough to
  // hold a window of an ACME loop, small enough that a hundred containers
  // cannot fill a modest host. Raise the size on a host with room, or set it
  // very small to make a noisy container harmless.
  //
  // Strings, not numbers: `max-size` carries a Docker unit suffix (`10m`,
  // `512k`, `1g`) and validating that here would duplicate the daemon's own
  // parser, which refuses a bad value at container-create time with a message
  // that names it. `deploy/install.sh` carries the same two defaults and writes
  // them into /etc/default/cloudgate-backend, so the Traefik that script starts
  // and the containers this process creates carry the same ceiling.
  CONTAINER_LOG_MAX_SIZE: z.string().optional(),
  CONTAINER_LOG_MAX_FILE: z.string().optional(),

  // Which hops in front of Nest are allowed to name the caller, in Express's own
  // `trust proxy` syntax: `loopback`, `uniquelocal`, `linklocal`, an IP or CIDR
  // list (`10.0.0.0/8,192.168.1.5`), or a hop count (`1`).
  //
  // **Unset is the shipped arrangement and the safe one.** Nothing is trusted,
  // so Express's `req.ip` is the socket peer and no caller can choose the
  // address their session records. That is what makes the value
  // `AuthController.toWebRequest` hands better-auth trustworthy in the first
  // place.
  //
  // Set it when something really is in front — Traefik, nginx, a cloud load
  // balancer — because until then better-auth records the *hop*, not the person:
  // it reads `x-forwarded-for` and only that, and it discards a chain longer
  // than one entry unless the hops are named here
  // (`@better-auth/core` `dist/utils/ip.mjs:188`). Both halves are fed from this
  // one key by `trust-proxy.ts`, so they cannot be configured to disagree.
  //
  // **Give the proxy's address or range, not a hop count.** A forwarded
  // header is believed only when this key names an address *and* the connection
  // it arrived on came from inside it: `AuthController.toWebRequest` appends the
  // socket peer to the chain, so better-auth's own walk stops at that peer
  // whenever it is not one of the hops named here, and the address recorded is
  // the one nobody can forge. A hop count names a position rather than an
  // address, so it leaves nothing to check a peer against and lands in the same
  // branch as unset: the chain is replaced by the socket peer. Nothing is ever
  // refused over it — a request from an undeclared peer is served, its claim
  // simply ignored, because this key governs every `/api/auth/*` route and a
  // refusal would take sign-in down on a misconfiguration.
  //
  // Syntax is all that is checked here, and fit is what goes wrong: a range can
  // name a proxy nothing goes through, or one that can be walked around, and
  // both look exactly like a working install. `AuthController` says so instead
  // — once at boot for a hop count, whose limiter consequence is decidable from
  // this value alone, and once per peer when a forwarded header arrives from
  // outside the declared range. Warnings, not refusals: see there for why
  // a count is still accepted.
  //
  // A hardcoded `true` was the tempting default and is the dangerous one: it
  // would let any caller set their own recorded address with a header, and an
  // audit column that lies is worse than one that is blank. Hence a key with a
  // safe default, and hence the entries being refused at boot rather than at
  // somebody's first sign-in — a typo here is silently *no* trust, which looks
  // exactly like a working install until the column turns out to hold the load
  // balancer's address on every row.
  //
  // Blank passes, and has to: `deploy/env/cloudgate-backend.example` ships
  // `TRUST_PROXY=` the way it ships `TRUSTED_ORIGINS=`, and systemd hands a bare
  // key through as an empty string rather than omitting it — refusing that would
  // abort boot on the shipped file.
  TRUST_PROXY: z
    .string()
    .optional()
    .refine(
      (value) =>
        value === undefined || value.trim() === '' || isTrustProxyValue(value),
      TRUST_PROXY_REQUIREMENT,
    ),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Used by ConfigModule.forRoot({ validate }) — throws at startup on bad env.
 * The instance-mode boot check runs first (ADR-0049): a stale setting or an
 * incomplete hosted configuration is refused before anything else is read.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  checkInstanceModeBoot(config);
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}
