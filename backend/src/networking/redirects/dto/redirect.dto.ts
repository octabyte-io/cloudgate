import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// C0 control characters and DEL. Not a charset — see redirectRuleSchema for
// why a charset is the wrong tool for a field whose content is metacharacters.
// eslint-disable-next-line no-control-regex
const REDIRECT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const REDIRECT_CONTROL_MESSAGE =
  'A redirect rule cannot contain control characters.';
/**
 * Long enough that no real rule meets it — Traefik's own documented examples
 * are tens of characters — and short enough to be a bound.
 */
const REDIRECT_MAX_LENGTH = 1024;

/**
 * What a redirect's `regex` and `replacement` may be (H-24). One schema
 * for both fields, the way `pathSchema` covers `path` and `internalPath`:
 * they are the same product concept reaching the same sink in the same object,
 * and a second spelling of one bound is the thing §2.4 exists to prevent.
 *
 * **A charset would be the wrong tool, and that is the whole shape of this
 * decision.** `regex` is a regular expression: its content *is* metacharacters,
 * so the excluded-character reasoning that bounds `hostSchema` and `pathSchema`
 * has nothing to bite on. `replacement` is a substitution template carrying
 * `${1}`. Neither has a meaningful alphabet to allow.
 *
 * **The sink is safe, and that was established rather than assumed.** Both
 * values land in `http.middlewares.<name>.redirectRegex.{regex,replacement}`
 * (`traefik/config/redirect.ts:23-28`) and reach Traefik only through
 * `TraefikWriterService`'s `yaml.stringify`. That writer was probed with the
 * fifteen shapes that could plausibly escape a scalar — a `---` document
 * separator carrying a whole forged `http.routers` tree, `\r\n`, a bare NUL, a
 * leading BOM, `...`, `*alias &anchor !!tag`, `#comment` followed by
 * `regex: other`, tabs, and every quote character — and **every one of them
 * round-tripped byte-identically, with one middleware key and two inner keys
 * still present**. The writer cannot be talked out of quoting, so no value of
 * these two fields forges a second YAML key. This is therefore hygiene at the
 * YAML sink and is being written down as hygiene, not as a security fix.
 *
 * **What the bounds actually buy, then:** a `text` column with no length at all
 * that is concatenated into a file Traefik re-reads on every change, and
 * control characters that make a stored rule impossible to read back or
 * reproduce in the console. Neither is an escape; both are the kind of thing an
 * API should refuse rather than store.
 *
 * **Three tools were rejected, and the reasons matter more than the choice.**
 *
 * - **A ReDoS bound** (a complexity limit, a nesting cap, a timeout). Rejected
 *   with evidence: nothing in this repo ever compiles a stored `regex` — grep
 *   `redirect.regex` and its only consumers are the generator above and this
 *   DTO — and the process that does compile it is Traefik, whose `regexp` is
 *   Go's RE2. RE2 has no backtracking by construction and matches in time
 *   linear in the input, so there is no catastrophic case to bound. A ReDoS
 *   rule here would be a defence against an engine this value never reaches.
 * - **Requiring an anchor** (`^…$`). Rejected as a behaviour change wearing a
 *   safety costume: an unanchored `redirectRegex` matching anywhere in the URL
 *   is Traefik's documented normal usage, and refusing it would break working
 *   redirects to buy nothing this schema is for.
 * - **Compile-validating the regex here, with `new RegExp`.** The tempting one,
 *   and the one that would be wrong in exactly the way H-12 was wrong: a
 *   rule that is correct for one engine, applied at a sink governed by another.
 *   `new RegExp` is ECMAScript and Traefik is RE2, and they disagree in **both**
 *   directions. Toward false refusals: `(?i)` and `(?i:…)` — inline flags, an
 *   everyday Traefik idiom for a case-insensitive host — are valid Go and a
 *   `SyntaxError` in V8, as is `(?P<name>…)`, Go's own spelling of a named
 *   group. Toward false confidence: `(?=…)`, `(?<=…)` and `\1` compile happily
 *   in V8 and are refused by RE2. So the check would refuse legitimate rules
 *   *and* still pass broken ones. The real defect it was reaching for is real
 *   and is filed separately: a regex Traefik cannot compile fails
 *   `newRedirect`'s `regexp.Compile`, which fails the middleware constructor,
 *   which makes `router.go` skip every router that names it — so a 201 here
 *   silently 404s the whole Application. Closing that needs an RE2 parser on
 *   this side of the wire (a dependency decision) or a Traefik-side dry run,
 *   not a guess in a different regex dialect.
 *
 * **The length bound is the one thing here that can refuse a rule that works
 * today**, and it is taken knowingly: 1024 characters is far past any redirect
 * anyone has written, and this schema is also the emitter's guard (see
 * {@link storedRedirectSchema}), so anything it refuses turns an existing
 * install's next edit into a 400 rather than a silent drop.
 */
export const redirectRuleSchema = z
  .string()
  .min(1)
  .max(REDIRECT_MAX_LENGTH, {
    message: `A redirect rule is at most ${REDIRECT_MAX_LENGTH} characters`,
  })
  .refine((value) => !REDIRECT_CONTROL_CHARACTERS.test(value), {
    message: REDIRECT_CONTROL_MESSAGE,
  });

// A redirect rule for an application; `permanent` is optional.
export const createRedirectSchema = z.object({
  regex: redirectRuleSchema,
  replacement: redirectRuleSchema,
  permanent: z.boolean().optional(),
  applicationId: z.string().min(1),
});

export class CreateRedirectDto extends createZodDto(createRedirectSchema) {}

// Every field optional (redirectId travels in the URL).
export const updateRedirectSchema = z
  .object({
    regex: redirectRuleSchema,
    replacement: redirectRuleSchema,
    permanent: z.boolean(),
  })
  .partial();

export class UpdateRedirectDto extends createZodDto(updateRedirectSchema) {}

/**
 * The values a **stored** `redirect` row hands to Traefik, held to the same
 * schema the request body is held to (H-24).
 *
 * The same arrangement as `storedDomainRoutingSchema` and
 * `storedSecurityUserSchema`, and it is worth saying why a *hygiene* rule gets
 * the emitter treatment at all: without it the rule would govern new writes
 * only, and `updateRedirectSchema` is `.partial()`, so `PATCH {permanent:true}`
 * would re-emit an unbounded stored `regex` while reporting success. A bound
 * that only half the writes reach is not a bound — that is the shape
 * X05-1 filed against `path`, and repeating it here knowingly would be worse
 * than not having the rule.
 */
export const storedRedirectSchema = z.object({
  regex: redirectRuleSchema,
  replacement: redirectRuleSchema,
});

// The parent an application's redirects are listed by; folded into a query
// DTO like ListMountsDto rather than a nested path.
export const listRedirectsSchema = z.object({
  applicationId: z.string().min(1),
});

export class ListRedirectsDto extends createZodDto(listRedirectsSchema) {}
