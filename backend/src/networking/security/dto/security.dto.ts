import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// The one character Traefik cannot carry inside a basic-auth username, plus
// the C0 control characters and DEL, which are not a username anyone can type.
// eslint-disable-next-line no-control-regex
const BASIC_AUTH_USERNAME_UNSAFE = /[:\u0000-\u001f\u007f]/;
const INVALID_USERNAME_MESSAGE =
  'Invalid username. A colon separates the username from its password hash in the basicAuth users list, so a username cannot contain one; control characters are not allowed either.';

/**
 * What a basic-auth username may be (H-22).
 *
 * **The sink is `` `${username}:${hash}` ``** — `traefik/app-config.service.ts`
 * builds one htpasswd-shaped string per `security` row and hands the list to
 * `basicAuth.users`. Traefik parses each entry with
 * `strings.Split(user, ":")` and refuses anything that is not exactly two parts
 * (`pkg/middlewares/auth/basic_auth.go`'s `basicUserParser`,
 * `if len(split) != 2 { return …, fmt.Errorf("error parsing BasicUser: %v") }`),
 * and that error propagates out of `getUsers` → `NewBasic` → the middleware
 * constructor. A bcrypt hash carries `$`, `.` and `/` but never a `:`, so the
 * only way to reach three parts is a `:` in the username.
 *
 * **What that actually does, established rather than assumed: it is a lockout,
 * not an auth bypass.** A middleware whose constructor errors is not built, and
 * `pkg/server/router/router.go` answers a router it cannot build a chain for
 * with `routerConfig.AddError(err, true); logger.Error(); continue` — the
 * `continue` skips `muxer.AddRoute`, so the router never enters the routing
 * table and requests to it 404. Traefik does not fall back to serving the
 * router *without* the middleware, which is the shape that would have made this
 * a bypass. The refusal is also all-or-nothing across the list: `getUsers`
 * returns `nil, err` for the whole map, so one poisoned row takes every
 * basic-auth user of that Application with it. And because
 * `traefik/config/domain.ts` pushes `auth-<appName>` onto every non-redirect
 * router of the app, the effect is the whole Application going dark behind a
 * 404 — silently, since nothing in the product reads Traefik's log. A `:` is
 * therefore a self-inflicted outage stored through a 201, not an escalation:
 * `security` rows are per-Application and the middleware name is the app's own.
 *
 * **A refusal set, not an allow-list, and that is deliberate — see H-12
 * for why it normally goes the other way.** The lesson there was that a
 * refusal set is only ever correct for one context, and `getCreateFileCommand`
 * had inherited one written for a different sink. It is the right shape *here*
 * because the sink is not a grammar with an open set of metacharacters: it is
 * an exact-arity split on one byte, so `{':'}` is provably the whole dangerous
 * set rather than the part someone thought of. The control characters are not
 * security — they are a username no console form produces and no operator can
 * reproduce in an `Authorization` header they typed.
 *
 * **An allow-list would have been actively harmful, because this schema is
 * also the emitter's guard.** `TraefikAppConfigService.regenerate` holds every
 * *stored* username to this same schema (§2.4 — one rule, applied at the extra
 * seam that sees the value, never a second spelling of it), so anything this
 * refuses turns an existing install's next redirect or basic-auth edit into a
 * 400. A username carrying a space, a `+`, or a non-ASCII letter authenticates
 * perfectly well today; refusing it would be this fix breaking working
 * configurations to close a hole that is not in them. The one thing this
 * refuses that *works* today is a name over 255 characters — accepted
 * knowingly: `username` is a `text` column with no bound at all, it is
 * concatenated into a file every request's middleware chain is rebuilt from,
 * and no console form has ever produced one.
 */
export const basicAuthUsernameSchema = z
  .string()
  .min(1, { message: 'Add a username' })
  .max(255, { message: 'A username is at most 255 characters' })
  .refine((value) => !BASIC_AUTH_USERNAME_UNSAFE.test(value), {
    message: INVALID_USERNAME_MESSAGE,
  });

// A basic-auth user for an application.
export const createSecuritySchema = z.object({
  username: basicAuthUsernameSchema,
  password: z.string().min(1),
  applicationId: z.string().min(1),
});

export class CreateSecurityDto extends createZodDto(createSecuritySchema) {}

// Every field optional (securityId travels in the URL).
export const updateSecuritySchema = z
  .object({
    username: basicAuthUsernameSchema,
    password: z.string().min(1),
  })
  .partial();

export class UpdateSecurityDto extends createZodDto(updateSecuritySchema) {}

/**
 * The value a **stored** `security` row hands to Traefik, held to the same
 * schema the request body is held to (H-22).
 *
 * The same arrangement, and for the same reason, as
 * `storedDomainRoutingSchema`: the DTO holds every new write, but
 * `updateSecuritySchema` is `.partial()` and `RedirectsService` and
 * `DomainsService` reach the emitter without naming a `security` row at all —
 * so a username stored before this rule existed is not a dormant leftover, it
 * is re-emitted by any write that regenerates the Application's config.
 * `password` is deliberately absent: it never reaches the file as itself, only
 * as a bcrypt hash, and bcrypt's alphabet cannot carry a `:`.
 */
export const storedSecurityUserSchema = z.object({
  username: basicAuthUsernameSchema,
});

// The parent an application's basic-auth users are listed by; folded into a
// query DTO like ListMountsDto rather than a nested path.
export const listSecuritySchema = z.object({
  applicationId: z.string().min(1),
});

export class ListSecurityDto extends createZodDto(listSecuritySchema) {}
