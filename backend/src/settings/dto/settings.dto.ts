import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { hostSchema } from '../../domains/dto/domain.dto';

/** `POST /settings/ip` body. */
export class UpdateServerIpDto extends createZodDto(
  z.object({ serverIp: z.string() }),
) {}

/** `POST /settings/builds-concurrency` body: 1 to 100 concurrent builds. */
export class UpdateBuildsConcurrencyDto extends createZodDto(
  z.object({ buildsConcurrency: z.number().int().min(1).max(100) }),
) {}

/**
 * `POST /settings/requested-preview-max-ttl` body: the longest a Requested
 * preview may be asked or extended for, from a minute to a week. The
 * week is a bound on a typo rather than a policy — the policy is the operator's
 * number, 24 hours until they change it.
 */
export class UpdateRequestedPreviewMaxTtlDto extends createZodDto(
  z.object({
    requestedPreviewMaxTtlMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
  }),
) {}

/**
 * `POST /settings/cloud-runs-concurrency` body: the Cloud run pool limit,
 * 1 to 20. Each run is a `tofu` of ~0.8 GB on this host, so the bound
 * is lower than builds'.
 */
export class UpdateCloudRunsConcurrencyDto extends createZodDto(
  z.object({ cloudRunsConcurrency: z.number().int().min(1).max(20) }),
) {}

/**
 * `POST /settings/cloud-run-time-limit` body: the Cloud run time limit in
 * minutes, from 5 minutes to a day.
 */
export class UpdateCloudRunTimeLimitDto extends createZodDto(
  z.object({
    cloudRunTimeLimitMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
  }),
) {}

/** Raw YAML for one of the platform host's named Traefik files. */
export class TraefikConfigDto extends createZodDto(
  z.object({ traefikConfig: z.string().min(1) }),
) {}

/** `POST /settings/traefik/file` body: a path under the Traefik directory. */
export class ModifyTraefikFileDto extends createZodDto(
  z.object({
    path: z.string().min(1),
    traefikConfig: z.string().min(1),
    // `.nullish()`, not `.optional()`: a row on the platform host carries
    // `serverId: null`, so `null` is the value a client reads off the resource
    // and sends back — ADR-0008's "no server row" contract. `.optional()`
    // answered 400 to the API's own output; widening keeps every payload that
    // was already accepted.
    serverId: z.string().nullish(),
  }),
) {}

/** `GET /settings/traefik/file` query (the service confines the path). */
export class ReadTraefikFileQueryDto extends createZodDto(
  z.object({
    path: z.string().min(1),
    serverId: z.string().nullish(),
  }),
) {}

/**
 * The optional serverId many endpoints take; absent names the platform host.
 * `.nullish()` here and at every other serverId in this file: see the note on
 * `ModifyTraefikFileDto` above.
 */
export class ServerIdQueryDto extends createZodDto(
  z.object({ serverId: z.string().nullish() }),
) {}

/** `POST /settings/traefik/requests` body: on/off, and an optional serverId. */
export class ToggleRequestsDto extends createZodDto(
  z.object({ enable: z.boolean(), serverId: z.string().nullish() }),
) {}

/**
 * The console's own hostname: `hostSchema`'s rule, plus the empty string, which
 * is how the console domain is *unassigned*.
 *
 * **Robustness rather than a security fix, said here so a later reader does not
 * re-derive it or file it as one.** The value lands raw in the console router's
 * rule — ``Host(`<host>`)``, `traefik/config/web-server.ts:124`, `:128`, `:141`
 * — which is the sink closed for a Domain's `host` and `path`. But
 * `SettingsService.assignDomain` is behind `requireInstanceAuthority`, and the same
 * settings surface already hands that caller `traefik.yml` itself to read and
 * write (`settings/traefik-files.service.ts`), so a caller carrying instance
 * authority forging a router rule on the instance they administer escalates
 * nothing — the argument used when declining to guess entrypoint names.
 * This sentence said `requireOwnerOrAdmin` once, which is the gate H-63
 * moved that method off: the conclusion is unchanged and the reason is
 * *stronger* under the real gate, but the cited name was one an organization's
 * owner satisfies, and on a multi-Organization install that is a different set
 * of callers — the exact confusion found in two routes actually shipping.
 * What the rule buys is **feedback**: a
 * malformed or typo'd host was stored and written into `dynamic/cloudgate.yml`,
 * Traefik dropped the router as an invalid rule, and the console silently
 * stopped answering on that name with nothing telling the operator why. Holding
 * the console's hostname to the rule every tenant hostname already passes is one
 * import (§2.4) and removes the whole class.
 *
 * **`''` stays valid, and this schema is shaped around that.**
 * `updateServerTraefik` calls `removeConfig('cloudgate')` for a falsy host,
 * *deleting* `dynamic/cloudgate.yml` — that is the documented way an operator
 * unassigns the console domain, and the console's own card says so in its
 * footer. `null` is deliberately not admitted: the field has never been nullable,
 * the console sends `""` for a cleared box, and no other caller reaches the
 * route.
 *
 * **Why a `transform` and not `z.union([hostSchema, z.literal('')])`.** The union
 * reads worst on exactly the input this exists for. zod 4 drops the issues of a
 * branch whose pipe aborted, so a host with a leading space collapses to a single
 * `invalid_union` issue reading "Invalid input", which names nothing a person can
 * act on. Applying `hostSchema` inside the transform forwards its own messages
 * verbatim, one per failure, so a console host and a Domain's host are refused in
 * the same words for the same string. Order is load-bearing twice: the empty case
 * short-circuits *before* `hostSchema`, so its 'Add a hostname' arm is
 * unreachable here rather than contradicting the cleared box; and the accepted
 * value is `hostSchema`'s output, not the input, so whatever it normalises — its
 * trim today — is not quietly dropped on the way through.
 *
 * **Exported because `SettingsService` needs this rule, not a copy of it
 * (H-25).** The rule was first put on the request and nothing else, and
 * `updateServerTraefik` takes its host from the caller rather than from the
 * row — so a host stored *before* this schema existed is never shown to it
 * again, and the ``Host(`…`)`` it was written into `dynamic/cloudgate.yml` as
 * stays there until an admin happens to re-run `assignDomain`. That is the
 * mirror image of X05-1: there the poisoned value was re-emitted by
 * every write, here it is emitted once and then never revisited by any write
 * at all, which is worse to detect and no better to live with.
 * `SettingsService.sweepConsoleHost` is the seam that closes it, and it applies
 * *this* schema — the `''` arm included, because an unassigned console host is
 * the ordinary state of a default install and must not read as poisoned.
 */
export const consoleHostSchema = z.string().transform((value, ctx) => {
  if (value === '') return '';
  const checked = hostSchema.safeParse(value);
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message });
    }
    return z.NEVER;
  }
  return checked.data;
});

/** `POST /settings/assign-domain` body: the console's domain and its TLS. */
export class AssignDomainDto extends createZodDto(
  z.object({
    host: consoleHostSchema,
    certificateType: z.enum(['letsencrypt', 'none', 'custom']),
    letsEncryptEmail: z
      .union([z.email(), z.literal('')])
      .optional()
      .nullable(),
    https: z.boolean().optional(),
  }),
) {}

/** `POST /settings/docker-cleanup` body. */
export class UpdateDockerCleanupDto extends createZodDto(
  z.object({
    enableDockerCleanup: z.boolean(),
    serverId: z.string().nullish(),
  }),
) {}

/** `POST /settings/log-cleanup` body; a null expression stops rotation. */
export class UpdateLogCleanupDto extends createZodDto(
  z.object({ cronExpression: z.string().nullable() }),
) {}

/** `POST /settings/traefik/dashboard` body. */
export class ToggleDashboardDto extends createZodDto(
  z.object({
    enableDashboard: z.boolean().optional(),
    serverId: z.string().nullish(),
  }),
) {}

/** `POST /settings/traefik/env` body: Traefik's env as KEY=value lines. */
export class WriteTraefikEnvDto extends createZodDto(
  z.object({ env: z.string(), serverId: z.string().nullish() }),
) {}

/**
 * One DNS credential's value: what Traefik's env carries for the provider.
 * No newline and no NUL, because the value becomes one `KEY=value` entry of a
 * container's env and either would split it or end it.
 */
const dnsCredentialValue = z
  .string()
  .min(1, 'a credential value cannot be empty')
  .max(4096)
  .refine((value) => !/[\n\r\0]/.test(value), {
    message: 'a credential value cannot contain a newline or NUL',
  });

/**
 * `PUT /settings/traefik/dns-challenge` body: a machine's lego DNS provider and
 * the env credentials it reads.
 *
 * `credentials` omitted keeps the stored map — the console cannot read the
 * values back (ADR-0019), so a provider change must not make it re-enter them —
 * and a provided map replaces the whole set, so a key left out of it is gone.
 * The keys are env-variable names in the shape every lego provider documents
 * them, which also keeps a key from being read as anything but a name.
 */
export const putDnsChallengeSchema = z.object({
  serverId: z.string().nullish(),
  provider: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/, 'provider must be a lego provider code'),
  credentials: z
    .record(
      z
        .string()
        .regex(
          /^[A-Z][A-Z0-9_]{0,127}$/,
          'a credential key must be an upper-case env variable name',
        ),
      dnsCredentialValue,
    )
    .refine((map) => Object.keys(map).length > 0, {
      message: 'credentials cannot be empty; omit them to keep the stored ones',
    })
    .refine((map) => Object.keys(map).length <= 32, {
      message: 'at most 32 credentials',
    })
    .optional(),
});
export class PutDnsChallengeDto extends createZodDto(putDnsChallengeSchema) {}

/**
 * A branding asset URL. `GET /settings/whitelabeling` is public and its answer
 * is rendered into `<img src>` / `<link href>` on the sign-in screen, so the
 * scheme is constrained to http(s) or a root-relative path: `javascript:` and
 * `data:` URLs have no legitimate use here and are exactly what an operator
 * account would reach for to script another tenant's login page.
 */
const brandingUrl = z
  .string()
  .max(2048)
  .refine((value) => /^(https?:\/\/|\/)/.test(value), {
    message: 'Must be an http(s) URL or a root-relative path',
  });

/** A CSS hex colour, the form a colour picker emits. */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex colour');

/**
 * White-labeling. Every field is optional and nullable: omitting a
 * key leaves the stored value alone, sending null clears it.
 *
 * No `.default()` anywhere — a default would make these fields *required* on
 * the DTO's output type.
 */
export class UpdateWhitelabelingDto extends createZodDto(
  z.object({
    appName: z.string().max(120).nullable().optional(),
    logoUrl: brandingUrl.nullable().optional(),
    faviconUrl: brandingUrl.nullable().optional(),
    primaryColor: hexColor.nullable().optional(),
    accentColor: hexColor.nullable().optional(),
    /**
     * Operator-authored CSS, destined for every console page.
     *
     * Served to anonymous visitors inside a `<style>` block, which is what the
     * `</` refusal is for: a closing tag would end the block and start a
     * `<script>` one.
     *
     * **The answer asked to be recorded either way, now that the question is
     * answerable.** The ticket asked whether instance authority is a sufficient
     * gate for arbitrary CSS on every console page. The check came back the other
     * way — the write was gated organization-level on a one-row, whole-instance
     * table, so any second licensed Organization's owner re-branded the whole
     * instance — and that fix moved it to
     * `SettingsService.requireInstanceAuthority` plus `requireInstanceLicense`.
     * So the original question was never answered.
     *
     * **It is sufficient, and the reason is that it grants nothing new.** The
     * same caller already holds every surface that can rewrite the console
     * outright: `POST /settings/traefik/web-server-config` hands them
     * `dynamic/cloudgate.yml`, the console's own router file;
     * `POST /settings/traefik/config` hands them the static `traefik.yml`; and
     * `POST /settings/assign-domain` decides the hostname the console answers
     * on. A caller who can re-point the console's router does not need CSS to
     * decide what a visitor sees, which is `consoleHostSchema`'s argument above.
     * **The gate is therefore not where the risk lives.**
     *
     * **What the gate says nothing about is the read, and that half is
     * deliberate.** `GET /settings/whitelabeling` is `@Public()` — the sign-in
     * screen is the first page a white-labelled instance has to get right and
     * it is reached with no session — and `getSanitizedWebServerSettings` hands
     * the whole blob to any authenticated user, which
     * `test/coding-standards/web-server-settings-projection.spec.ts` classifies
     * as plain on purpose. So this value is not confidential and never was: the
     * risk here is injection and UI redress, not disclosure.
     *
     * **The renderer is `frontend/src/components/console/branding-style.tsx`,
     * and it applies this value to the signed-in console only.** The
     * auth layout renders it with `customCss={false}`, so the sign-in, sign-up,
     * two-step and reset screens — the ones an anonymous visitor types a
     * password into — never load it. It is a React `<style>` child, not an
     * attribute or a JS string, and `normalizeBranding` refuses `</` a second
     * time before it is rendered, so the refusal below is the one it relies on.
     *
     * **What the refusal above is and is not worth, so the renderer's author
     * does not over-trust it.** Against a raw `<style>` body it is airtight for
     * the HTML tokenizer: the only exit from RAWTEXT is a literal `</style`, and
     * CSS `\3c` escapes are not decoded there. It buys **nothing** if the value
     * is ever interpolated into an attribute or a JS string, and it says nothing
     * about `@import`, `url()` exfiltration through an attribute selector, or a
     * `position: fixed` overlay on the login form. Those four are the
     * renderer's, and the cap is 50,000 characters rather than a defence.
     *
     * **The missing second layer is a CSP, and the console's pages have
     * none** (verified 2026-09-09): no `helmet` in either `package.json`, no
     * `Content-Security-Policy` in `frontend/src`, and in `backend/src` only
     * the one the Trace store proxy serves the store's UI under (not a
     * console page), no `headers()` in `frontend/next.config.ts` — it declares `rewrites()` and
     * nothing else — and `frontend/server.mjs` adds only `x-forwarded-for`. That
     * absence is what makes this one refusal load-bearing on its own. The
     * renderer shipped without one; keeping custom CSS off the doors is
     * what it did instead, and a CSP is still the open second layer.
     */
    customCss: z
      .string()
      .max(50_000)
      .refine((value) => !value.includes('</'), {
        message: 'Custom CSS may not contain "</"',
      })
      .nullable()
      .optional(),
    errorPages: z
      .object({
        notFoundMessage: z.string().max(500).nullable().optional(),
        serverErrorMessage: z.string().max(500).nullable().optional(),
        supportUrl: brandingUrl.nullable().optional(),
      })
      .optional(),
  }),
) {}

/** `POST /settings/traefik/ports` body: Traefik's additional ports. */
export class UpdateTraefikPortsDto extends createZodDto(
  z.object({
    serverId: z.string().nullish(),
    additionalPorts: z.array(
      z.object({
        targetPort: z.number(),
        publishedPort: z.number(),
        protocol: z.enum(['tcp', 'udp', 'sctp']),
      }),
    ),
  }),
) {}
