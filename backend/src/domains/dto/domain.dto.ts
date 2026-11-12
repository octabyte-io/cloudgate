import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { certificateTypeEnum } from '../domain.schema';

// RFC 1123 labels, at least two of them, underscores rejected.
export const VALID_HOSTNAME_REGEX =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
export const INVALID_HOSTNAME_MESSAGE =
  'Invalid domain name. Use only letters, numbers, hyphens and dots (e.g. example.com). Underscores are not allowed.';

/**
 * What a Domain's hostname may be: RFC 1123 labels, trimmed, and nothing a
 * Traefik rule expression could read as syntax.
 *
 * **Exported because other seams need this rule, not a copy of it.** A
 * Template's compose Domain host, typed at setup (`templates/setup/
 * setup-domains.ts`), and `POST /ai/deploy`'s domains reach
 * `DomainsService.create` inside an object a service built, so the global
 * pipe never sees them — and a compose domain's host is interpolated raw into a
 * router label, ``traefik.http.routers.<name>.rule=Host(`<host>`)``
 * (`compose/compose.utils.ts:80-82`), which Traefik's Docker provider parses
 * *as a rule*. A host carrying a backtick closes that `Host(...)` and appends
 * alternations of its own, so the stack answers for hostnames with no Domain
 * row at all — and since Traefik ranks routers by rule length, a long
 * injected alternation outranks the legitimate short one. Escaping the label
 * in `compose.utils.ts` instead was rejected: it is a second validation site
 * for a rule §2.4 wants stated once, and it would still admit the empty host.
 *
 * A Template's hosts are held to it at setup, so a bad one is refused before
 * the Pending setup is written rather than at Apply; the Plan's Apply then
 * hands them to `DomainsService.create` as they were checked.
 * (The `template.toml` reader, removed in #1364, applied it to a host it had
 * `${variable}`-substituted.)
 */
export const hostSchema = z
  .string()
  .min(1, { message: 'Add a hostname' })
  .refine((val) => val === val.trim(), {
    message: 'Domain name cannot have leading or trailing spaces',
  })
  .transform((val) => val.trim())
  .refine((val) => VALID_HOSTNAME_REGEX.test(val), {
    message: INVALID_HOSTNAME_MESSAGE,
  });

// The path charset: a leading slash, then unreserved /
// sub-delims / ':' / '@' / '/' / percent-escapes — RFC 3986's path characters
// minus the two that mean something to a Traefik label. Excluded on purpose:
// '`' ends a PathPrefix argument, ',' splits stripprefix.prefixes.
const VALID_PATH_REGEX =
  /^\/(?:[A-Za-z0-9\-._~!$&'()*+;=:@/]|%[0-9A-Fa-f]{2})*$/;
const PATH_LEADING_SLASH_MESSAGE = 'A path starts with /';
const INVALID_PATH_MESSAGE =
  "Invalid path. Use only letters, numbers, / and - . _ ~ ! $ & ' ( ) * + ; = : @ (e.g. /api), with %-escapes for anything else.";

/**
 * What a Domain's `path` and its `internalPath` may be: a leading slash, then
 * RFC 3986 path characters minus the two that mean something to a Traefik
 * label.
 *
 * **Exported for the reason `hostSchema` is: one rule, not a copy of it.**
 * Its seam outside a DTO is the Template check (`templates/check/
 * template-yaml.ts`): a Template's Domain `path` reaches
 * `DomainsService.create` from the Plan's Apply, past the global pipe, so
 * the check holds it to this schema and a path it refuses hides the
 * template; `storedDomainRoutingSchema` still refuses any other character
 * before Traefik is given it.
 *
 * **Three sinks, and naming them is what bounds the charset:**
 * - ``rule=…PathPrefix(`<path>`)`` in the Docker-provider router label
 *   (`compose/compose.utils.ts:81-83`), which Traefik parses *as a rule*, so a
 *   backtick closes the argument and appends alternations of its own — the same
 *   mechanism the host charset closed for `host`, and it outranks the legitimate router
 *   because Traefik prioritises by rule length.
 * - the same ``PathPrefix(`<path>`)`` in the file provider
 *   (`traefik/config/domain.ts:42-45`). Note the asymmetry that made this
 *   reachable twice over: there `host` goes through `toPunycode()` and `path`
 *   goes through nothing, so unlike `host` this value reaches both providers —
 *   compose stacks via labels, applications via the dynamic config file.
 * - `traefik.http.middlewares.<name>.stripprefix.prefixes=<path>`
 *   (`compose.utils.ts:100-104`), whose `prefixes` is a Traefik **slice**, so a
 *   `,` appends further prefixes rather than being one path. (The file provider
 *   is unaffected there — `prefixes: [path]` is a real array,
 *   `traefik/config/middleware.ts:34`.)
 *
 * **A backtick is the only character that changes what Traefik parses as a
 * rule, and that is what bounds the argument.** Both sinks reach Traefik
 * through a YAML writer — compose labels through `yaml.stringify`
 * (`compose.utils.ts:3`, `:328`), the file provider's `rule` as a YAML scalar —
 * so quotes, newlines and `#` are quoted for us and cannot forge a second
 * label or a second key. Everything else this charset excludes is hygiene, not
 * the security fix, which is why an over-narrow answer buys nothing and an
 * over-wide one is cheap to live with.
 *
 * **Must start with `/`, and that is the companion bug only a schema closes.**
 * We pin `traefik:v3.6.7` (`settings/traefik-setup.service.ts`), whose
 * `Path`/`PathPrefix` matchers require a leading slash — so `{path: "api"}` was
 * accepted, emitted ``PathPrefix(`api`)``, and had its router dropped as an
 * invalid rule: the domain silently never routed. That is this case's analogue
 * of the empty host, and the console's own copy of the rule already promised
 * it ("A path starts with /.") while validating no such thing. It gets its own
 * arm so it gets its own message, because "start it with /" is the sentence a
 * person can act on and the charset refusal is not.
 *
 * `.max(255)` is not storage — `path` is a `text` column. Traefik ranks routers
 * by rule **length**, so an unbounded path is a priority knob; a cap is one
 * line and removes the question.
 *
 * **Refuse here rather than escape at the builders.** §2.4 wants one rule in
 * one place and there are *three* sinks, so escaping is three escape sites; it
 * would also leave `path: "api"` silently unroutable forever, and it is the
 * wrong shape for the file provider, where `rule` is already YAML-safe and the
 * injection is inside Traefik's own grammar. Both of the host charset's arguments survive,
 * and the second one is stronger here.
 *
 * One schema for both fields, so `internalPath`'s old `startsWith('/')` arm in
 * `refineDomainRules` is **gone** rather than left as a second site (§2.4) —
 * the leading-slash refusal it produced is now this schema's, landing on the
 * same field. `internalPath` is owed the charset too even though
 * `addprefix.prefix=<internalPath>` (`compose.utils.ts:111-115`) is a label
 * *value* and not a rule: it is the same product concept, in the same DTO, and
 * it already carried half the rule.
 *
 * `'/'` stays valid and stays the default, and `refineDomainRules`' "strip path
 * requires a path other than /" is unaffected.
 *
 * **Four narrowings neither charset change named, recorded together because a
 * reader who finds one of them concludes the other three did not happen.** This
 * paragraph named only the first, and X05-2 is the finding that a reader
 * takes it for an exhaustive list. Every field in this DTO that was a bare
 * `z.string()` accepted `''` before the wave and answers 400 to it now — the
 * pre-fix shapes are `git show b3d7cee:backend/src/domains/dto/domain.dto.ts`:
 *
 * - `internalPath`, `z.string().optional()` → 400 `Add a path`, from this
 *   schema's `.min(1)`.
 * - `customEntrypoint`, `z.string().nullable().optional()` → 400
 *   `Invalid Traefik name…`, from {@link traefikNameSchema}'s `{1,64}`.
 * - `customCertResolver`, same shape, same refusal.
 * - `middlewares[]`, `z.array(z.string())` → 400 `Invalid middleware name…`
 *   from {@link middlewareRefSchema}, landing on the element (`middlewares.0`)
 *   rather than on the array.
 *
 * All four are the rule working, not a regression: an empty entrypoint name,
 * resolver name or middleware reference is not a value Traefik can use, exactly
 * as `addprefix.prefix=` with an empty value is a middleware that prefixes
 * nothing. `internalPath` was never a path — the console does not send the field
 * at all — so omit it instead; it is optional. **`path` is deliberately not in
 * that list**: it was already `z.string().min(1)` before the wave, so `''` was a
 * 400 then too and nothing about it moved.
 *
 * **The control that makes these `.min(1)`-shaped narrowings rather than a
 * nullability regression: `null` on `customEntrypoint` and `customCertResolver`
 * is still accepted**, because both fields carry `.nullable()` around the name
 * schema and `null` is what the console sends for "no custom resolver". Only
 * `''` moved, and only because `{1,64}` says a name has at least one character.
 *
 * Existing rows are untouched — no migration and no backfill, which is the trade
 * the host charset took. **What this paragraph used to claim, and X05-1 disproved: a
 * stored path outside the charset does *not* survive only "until someone next
 * PATCHes that domain".** `updateDomainSchema` is `.partial()`, so a PATCH that
 * does not carry `path` never shows the stored one to this schema — X05 sent
 * `{"port":3001}`, got a 200, and watched the injected ``PathPrefix`` alternation
 * be written back into the live file provider and answer for a hostname the row
 * never claimed. A PATCH was never remediation; it was maintenance.
 * {@link storedDomainRoutingSchema} is what closes that, by holding the stored
 * row to this same schema at the emitter.
 */
export const pathSchema = z
  .string()
  .min(1, { message: 'Add a path' })
  .max(255, { message: 'A path is at most 255 characters' })
  .refine((val) => val === val.trim(), {
    message: 'Path cannot have leading or trailing spaces',
  })
  .transform((val) => val.trim())
  .refine((val) => val.startsWith('/'), {
    message: PATH_LEADING_SLASH_MESSAGE,
  })
  .refine((val) => VALID_PATH_REGEX.test(val), {
    message: INVALID_PATH_MESSAGE,
  });

// The two name charsets. Cloudgate generates `traefik.yml` and
// declares only `web`/`websecure` + `letsencrypt` (`servers/server-setup.ts`),
// but writes it only when absent and lets operators edit it through the
// settings surface — so the names are operator-chosen, and the answer is a rule
// on a name's shape rather than an allowlist of the two we ship.
const TRAEFIK_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const MIDDLEWARE_REF_REGEX = /^[A-Za-z0-9_-]{1,64}(@[a-z]+)?$/;

/**
 * What a Traefik entrypoint or certificate-resolver name may be: letters,
 * numbers, `_` and `-`, at most 64 of them.
 *
 * **`customEntrypoint` lands in the Traefik label *key*, not a value**, which
 * is what makes it a different shape from `path`:
 * `routerName = ${appName}-${uniqueConfigKey}-${entrypoint}`
 * (`compose/compose.utils.ts:79`, `:185-190`) is interpolated into all four
 * label keys, and **Docker splits a label on its first `=`** — so an `=` here
 * truncates the key and everything after it becomes the value, letting the
 * caller choose which Traefik label key gets written for their own container.
 * `customCertResolver` is the plainer case: a label value
 * (`…tls.certresolver=<name>`, `compose.utils.ts:140`) and a YAML scalar
 * (`tls: { certResolver }`, `traefik/config/domain.ts:100`) naming a resolver
 * the operator declared.
 *
 * **`.` is excluded deliberately: it is Traefik's label-key separator**, and no
 * entrypoint or resolver we generate or document carries one. The accepted
 * residual, stated so the refusal is not a surprise: an operator who
 * hand-edited `traefik.yml` to name an entrypoint `web.alt` — or a resolver
 * with a `.` — has to rename it. Judged remote against the two names we
 * generate.
 *
 * **Severity, recorded once so a later reader does not re-derive it: this is a
 * validation gap, not a demonstrated cross-tenant break.** An unchecked `path` closes
 * a rule expression and can forge a router for a hostname with no Domain row;
 * this cannot. The compose labels go through `yaml.stringify`, so a newline or
 * a quote cannot forge a second label, and every payload tried through the
 * key truncation (`.priority=`, `.service=`, an unbalanced backtick to swallow
 * the tail) yields a value Traefik rejects, dropping the router. The reliable
 * effect is corrupting **your own** router: an arbitrary label key on your own
 * container, a router silently dropped.
 *
 * `null` stays accepted on both fields, and this applies to the non-null branch
 * only — `refineDomainRules` already requires a resolver when
 * `certificateType === 'custom'`, and that is the rule about presence.
 *
 * **`''` is a 400 here and was once accepted** — the second and third of
 * the four sibling empty-string narrowings {@link pathSchema} lists, written
 * down here as well because that is where a reader of *this* schema looks
 * (X05-2). Both fields were `z.string().nullable().optional()`, so `['']`
 * of a name got through; `{1,64}` is what refuses it now. It is the rule
 * working: `…tls.certresolver=` naming nothing, and a router key ending in the
 * separator, are not values Traefik can use. **`null` is not affected and must
 * not be** — it is the spelling the console sends for "no custom resolver", it
 * is still a 201, and `''` never meant that.
 */
export const traefikNameSchema = z.string().regex(TRAEFIK_NAME_REGEX, {
  message:
    'Invalid Traefik name. Use only letters, numbers, underscores and hyphens (e.g. websecure), at most 64 characters.',
});

/**
 * What one element of a Domain's `middlewares` may be: a Traefik name,
 * optionally carrying Traefik's provider suffix — `redirect-to-https@file`.
 *
 * `middlewares` is joined into a label value —
 * `…routers.X.middlewares=${middlewares.join(',')}` (`compose.utils.ts:126-130`)
 * — and pushed verbatim into the file provider's array
 * (`traefik/config/domain.ts:89-91`). Traefik's `middlewares` is a **slice**, so
 * a `,` inside one name splits it into two references; hence the same charset
 * as {@link traefikNameSchema} — the `.` exclusion included — plus the one
 * suffix a real reference needs. The built-ins are `redirect-to-https`, `stripprefix-…`,
 * `addprefix-…`, `auth-…` and `forward-auth-…-errors`, none of which needs a
 * dot either.
 *
 * A middleware name is a **reference**, not an injection: naming another
 * Service's middleware changes the behaviour of the caller's own router and
 * nobody else's, which is why the cross-tenant question the path table raised is
 * closed rather than charset-shaped.
 *
 * **`''` is a 400 here too, and it lands on the element — `middlewares.0`, not
 * `middlewares`** — the fourth of the four sibling empty-string narrowings
 * {@link pathSchema} lists, repeated here for a reader who arrives at this
 * schema first (X05-2). The field was once `z.array(z.string())`,
 * so `['auth-app', '']` was accepted and joined a reference naming nothing into
 * the label's slice. There is no `null` control to state alongside it, unlike
 * the two name fields: the array is optional and its elements are not nullable,
 * so an element is a name or the array does not carry it.
 */
export const middlewareRefSchema = z.string().regex(MIDDLEWARE_REF_REGEX, {
  message:
    'Invalid middleware name. Use only letters, numbers, underscores and hyphens, optionally with a provider suffix (e.g. redirect-to-https@file).',
});

/**
 * Every value a **stored** Domain row hands to Traefik, held to the same
 * schemas the request body is held to (X05-1).
 *
 * **The gap this closes is not the validator; it is which writes the validator
 * is reached by.** The three charsets all put their rule on the DTO, and the
 * DTO holds: X05 proved a `PATCH` re-sending a violating row's *own* stored
 * `path` is a 400. But `updateDomainSchema` is `.partial()`, so a body that does
 * not carry the field never shows the stored one to any schema —
 * `PATCH -d '{"port":3001}'` answered 200, and `regenerateTraefikConfig`
 * rewrote a stored ``/marker`) || PathPrefix(`/pwned`` alternation back into the
 * live file provider, where it went on answering for a hostname the row never
 * claimed. A row that predates the wave is therefore not a dormant leftover
 * waiting for its next edit: it is actively maintained and re-emitted, by any
 * write to *any* Domain of the same Application.
 *
 * **Six fields, because six values are interpolated into a Traefik rule or
 * label and none of them is escaped on the way.** `host` is here for the same
 * reason as the other five even though the host rule predates the path rule: `toPunycode()`
 * (`traefik/config/domain.ts:8-14`) is `new URL('http://' + host).hostname`
 * inside a `try`, and its `catch` returns **the original string** — so
 * ``x.com`) || Host(`y.com`` throws `ERR_INVALID_URL` and reaches the rule
 * verbatim, and a single-backtick host does not even throw. `serviceName` is
 * deliberately absent: it selects a service inside the compose file
 * (`compose.utils.ts`) and is never interpolated into a label.
 *
 * **Nullish, not optional, on every field.** These are `text` columns
 * (`domain.schema.ts`), so `null` is a value a legitimate row genuinely
 * carries — `path` defaults to `'/'` but nothing forbids `null`, and both
 * Traefik names are `null` on every row that never set one. The emitters all
 * branch on falsiness before interpolating, so a `null` is not a sink and must
 * not be a refusal; that is the same `null`-stays-accepted control
 * {@link traefikNameSchema} states for the wire.
 *
 * **Derived, not restated.** §2.4 wants the charset in one place and this is a
 * fifth reader of the same four schemas, not a fifth copy of them — the same
 * arrangement `hostSchema` has with a Template's setup (`setup-domains.ts`)
 * and `assertHostUnclaimed` has with `assertHostsUnclaimed`: one rule applied at
 * the extra seam that sees the value, never a second spelling of the rule. If
 * the charset changes, it changes here too, because there is nothing here to
 * change.
 *
 * See `DomainsService.assertParentRowsRoutable` for the choke point this is
 * applied at, `assertStoredRoutingSafe` for the refusal it raises, and both for
 * why a 400 was chosen over silently dropping the field.
 */
export const storedDomainRoutingSchema = z.object({
  host: hostSchema.nullish(),
  path: pathSchema.nullish(),
  internalPath: pathSchema.nullish(),
  customEntrypoint: traefikNameSchema.nullish(),
  customCertResolver: traefikNameSchema.nullish(),
  middlewares: z.array(middlewareRefSchema).nullish(),
});

/**
 * Who supplies a Domain's certificate — the column's own values, derived
 * rather than restated (§2.4): Let's Encrypt, nobody here (`none`), a
 * named Traefik resolver (`custom`), or a certificate from Settings →
 * Certificates (`stored`). `stored` is a Domain's answer only — the
 * console domain and the forward-auth target keep their own three-value enums —
 * and whether a stored certificate actually covers the host is
 * `DomainsService`'s check, since it reads rows this schema cannot see.
 */
export const certificateTypeSchema = z.enum(certificateTypeEnum.enumValues);

// The superRefine rules shared by the application and compose shapes.
const refineDomainRules = (
  input: {
    https?: boolean;
    certificateType?: string;
    customCertResolver?: string | null;
    stripPath?: boolean;
    path?: string;
  },
  ctx: z.RefinementCtx,
) => {
  if (input.https && !input.certificateType) {
    ctx.addIssue({
      code: 'custom',
      path: ['certificateType'],
      message: 'Required when https is enabled',
    });
  }
  if (input.certificateType === 'custom' && !input.customCertResolver) {
    ctx.addIssue({
      code: 'custom',
      path: ['customCertResolver'],
      message: 'Required when certificateType is custom',
    });
  }
  if (input.stripPath && (!input.path || input.path === '/')) {
    ctx.addIssue({
      code: 'custom',
      path: ['stripPath'],
      message: 'Strip path requires a path other than /',
    });
  }
  // No `internalPath` leading-slash arm: `pathSchema` is the one place that
  // rule is stated now (§2.4), and its refusal already lands on the field.
  // What is left here is only the cross-field rules, which is what a
  // `superRefine` is for.
  //
  // No parent-reference arm either, and that omission is load-bearing: see
  // {@link refineParentRefs}, which is chained onto the create shape alone
  // because this function is shared with the `.partial()` update shape that
  // carries neither id.
};

/**
 * **Exactly one** of `applicationId` or `composeId` owns a new Domain, and this
 * is what enforces it.
 *
 * Nothing did, and the shape of the hole is `DomainsService.create`'s control
 * flow rather than any of its queries. `findParentService` **is** properly
 * organization-scoped in both branches — each joins `environment` → `project`
 * and filters on `project.organizationId` — but it tests `applicationId` first
 * and *returns* on that branch, so the `composeId` branch is never reached when
 * both are present, and the insert then wrote `{ ...data, host, path }`, which
 * writes *both* foreign keys. A body carrying the caller's own `applicationId`
 * beside another organization's `composeId` therefore passed the gate on the
 * first and landed a `domain` row on the victim's Compose stack, whose Traefik
 * router is spliced into the victim's next deploy by
 * `DomainsService.findComposeDomains` (`compose/compose.utils.ts`'s
 * `addDomainsToComposeSpec`). Two guards in the same call were also evaluated
 * against the wrong parent: `assertHostUnclaimed` got the *attacker's*
 * `serverId`, so the host-claim pre-flight asked about the wrong machine's
 * Traefik, and `assertComposeServiceRoutable` read the wrong stack.
 *
 * §2.4 puts a payload shape rule on the DTO, and this is the same rule
 * landed one module over for the identical defect in `createPatchSchema` —
 * matched deliberately, message and all, rather than re-derived: two modules
 * spelling "exactly one owning service" two ways is how the next porter
 * concludes one of them means something else.
 *
 * **Chained onto `createDomainSchema` alone rather than folded into
 * {@link refineDomainRules}**, which is where a shape rule for this DTO would
 * otherwise belong: that function is shared with `updateDomainSchema`, which
 * omits both fields and is `.partial()`, so "exactly one is present" is false
 * for *every* legitimate PATCH body and a shared arm would refuse the whole
 * update surface. It sits here, next to the shared rules, so the split is
 * visible where a reader looks for the missing arm.
 *
 * The issue is emitted at a **field** path rather than the object root, because
 * `triggerDeploymentSchema`'s docblock records that an empty `path` "named
 * nothing a caller could fix". It is not the only half of the fix, and the
 * other half is not a duplicate of it: `DomainsService.create` independently
 * writes the *resolved* parent's id into a named column instead of spreading
 * the body, because a refinement guards only the fields it was written for and
 * the internal callers (`PlanApplier`'s Template and config creates,
 * `AiService.deploy`) reach `create` through the service seam, which the global pipe never sees.
 * `updateDomainSchema` is not exposed: it omits both ids and, as a plain
 * `z.object`, *strips* them off a body that sends them anyway, so a Domain
 * cannot be re-pointed at another service — pinned by a test rather than
 * trusted.
 */
const refineParentRefs = (
  input: { applicationId?: string; composeId?: string; bucketId?: string },
  ctx: z.RefinementCtx,
) => {
  // A bucket on a Server is the third parent.
  const named = [input.applicationId, input.composeId, input.bucketId].filter(
    (id) => id !== undefined,
  );
  if (named.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['applicationId'],
      message:
        'Exactly one of applicationId, composeId or bucketId must be provided',
    });
  }
};

// Create input. There is no preview branch — Phase 25 previews carry their
// own host. Two refinements, and the second one is a tenancy rule: see
// {@link refineParentRefs} for why "exactly one owning service" is
// enforced here and why it is not inside the shared {@link refineDomainRules}.
export const createDomainSchema = z
  .object({
    host: hostSchema,
    path: pathSchema.optional(),
    internalPath: pathSchema.optional(),
    stripPath: z.boolean().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    https: z.boolean().optional(),
    certificateType: certificateTypeSchema.optional(),
    customCertResolver: traefikNameSchema.nullable().optional(),
    customEntrypoint: traefikNameSchema.nullable().optional(),
    middlewares: z.array(middlewareRefSchema).optional(),
    forwardAuthEnabled: z.boolean().optional(),
    serviceName: z.string().optional(),
    domainType: z.enum(['application', 'compose']).optional(),
    // Both fields stay optional in the object and are mutually exclusive by
    // {@link refineParentRefs}, so the condition has no place in a flat
    // `required` array and is published as prose on each of them instead —
    // `createMountSchema`'s H-70 shape, and `createPatchSchema`'s. Without it the document
    // says "optional" twice and stops, which is exactly the reading that
    // produced the cross-tenant write.
    applicationId: z
      .string()
      .describe(
        'The owning Application. Exactly one of applicationId, composeId ' +
          'or bucketId must be sent; a body carrying two is refused.',
      )
      .optional(),
    composeId: z
      .string()
      .describe(
        'The owning Compose stack. Exactly one of applicationId, composeId ' +
          'or bucketId must be sent; a body carrying two is refused.',
      )
      .optional(),
    bucketId: z
      .string()
      .describe(
        'The owning bucket on a Server, whose Garage S3 API the ' +
          'Domain routes to. Exactly one of applicationId, composeId or ' +
          'bucketId must be sent.',
      )
      .optional(),
  })
  .superRefine(refineDomainRules)
  .superRefine(refineParentRefs);

export class CreateDomainDto extends createZodDto(createDomainSchema) {}

// Update input: everything but the parent FKs — domains don't move between
// services (domainId travels in the URL) — and *stripping*, not passthrough, is
// what makes that hold for a body that sends them anyway (verified
// rather than assumed; see {@link refineParentRefs}). `.strict()` was
// rejected for the reason it was rejected on `patch`: it would newly refuse payloads this
// API accepts today.
export const updateDomainSchema = z
  .object({
    host: hostSchema,
    path: pathSchema,
    internalPath: pathSchema,
    stripPath: z.boolean(),
    port: z.number().int().min(1).max(65535),
    https: z.boolean(),
    certificateType: certificateTypeSchema,
    customCertResolver: traefikNameSchema.nullable(),
    customEntrypoint: traefikNameSchema.nullable(),
    middlewares: z.array(middlewareRefSchema),
    forwardAuthEnabled: z.boolean(),
    serviceName: z.string(),
    domainType: z.enum(['application', 'compose']),
  })
  .partial()
  .superRefine(refineDomainRules);

export class UpdateDomainDto extends createZodDto(updateDomainSchema) {}

// Input for a generated sslip.io host: the appName, plus the optional
// serverId whose IP rides in the host.
export const generateDomainSchema = z.object({
  appName: z.string().min(1, 'appName cannot be empty'),
  // `.nullish()`, not `.optional()`: an Application on the platform host carries
  // `serverId: null` on its row, so `null` is the value a client reads off the
  // resource and sends back here. `.optional()` accepted the omitted key and
  // answered 400 "expected string, received null" to the explicit one — a
  // refusal of the API's own output, on a route whose only job is to suggest a
  // hostname. ADR-0008 makes "no server row" *be* the platform host across the
  // whole HTTP surface, and `checkServerAccess` already collapses `null` and
  // `undefined` onto that branch, so only validation ever disagreed. Widening,
  // never narrowing: every payload accepted before is still accepted, which is
  // why the same spelling could be swept across all 23 sites at once.
  serverId: z.string().nullish(),
  /**
   * The Compose stack the host is for, when it is one: a stack on its Stack
   * VM has no generated host, and is refused, saying so (#1371).
   */
  composeId: z.string().nullish(),
});

export class GenerateDomainDto extends createZodDto(generateDomainSchema) {}
