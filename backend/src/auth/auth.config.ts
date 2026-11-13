import { apiKey } from '@better-auth/api-key';
import { scim } from '@better-auth/scim';
import { sso } from '@better-auth/sso';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { setSessionCookie } from 'better-auth/cookies';
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';
import {
  admin,
  deviceAuthorization,
  organization,
  twoFactor,
} from 'better-auth/plugins';
import { PERSONAL_KEY_NAME_MAX_LENGTH } from 'api-schemas';
import { desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import * as schema from '../db/schema';
import { reviveScimTombstone } from '../enterprise/scim/scim-tombstone';
import {
  emailDomain,
  providerActsFor,
  routingFor,
  SSO_DOMAIN_NOT_PROVEN_CODE,
  SSO_DOMAIN_NOT_PROVEN_MESSAGE,
} from '../enterprise/sso/proven-domains';
import { restateScimValidationError } from '../enterprise/scim/scim-wire';
import {
  organizationOfProvider,
  organizationRoutedTo,
  providerNamed,
  providerRoutedTo,
  SSO_SIGN_IN_OFF_CODE,
  ssoSignInOffMessage,
} from '../enterprise/sso/sso-sign-in';
import type { PaidFeatureCheck } from '../enterprise/sso/sso-sign-in';
import { refuseNonPublicOidcProvider } from '../enterprise/sso/sso-addresses';
import type { SsoAddressCheck } from '../enterprise/sso/sso-addresses';
import { refuseScimAddWithoutPaidFeatures } from '../enterprise/scim/scim-plan-gate';
import { substituteCustomInvitationRole } from '../organizations/invitation-role';
import {
  renderInvitationEmail,
  renderResetPasswordEmail,
  renderVerificationEmail,
} from '../mail/templates';
import type { RenderedEmail } from '../mail/templates';
import { sendTransactional } from '../mail/transactional-failure';
import { banInForce, BANNED_CODE, BANNED_MESSAGE } from './ban';
import { signUpOrganizationName } from './sign-up-organization-name';
import {
  hasInstanceOwner,
  SIGN_UP_NOT_OPEN_YET_CODE,
  SIGN_UP_NOT_OPEN_YET_MESSAGE,
  signUpState,
} from './sign-up-state';
import { pinInstanceOrganization } from '../rbac/instance-organization-pin';
import { socketPeerFallback } from './socket-peer';
import { refuseForeignConfirmationCallback } from './confirmation-callback';
import { ConfirmationEmailLimit } from './confirmation-email-limit';
import type { ConfirmationEmailClock } from './confirmation-email-limit';
import { CLOUDFLARE_SITEVERIFY_URL, hostedTurnstile } from './turnstile';
import {
  ssoOrganizationOfRequest,
  trustedOriginOwners,
} from './trusted-origin-scope';
import type {
  AuthRequestShape,
  TrustedOriginOwners,
} from './trusted-origin-scope';
import {
  AGENT_REFUSAL_CODE,
  AGENT_REFUSAL_MESSAGE,
  apiKeyOwnerKind,
  refuseAgentMemberRemoval,
  refuseIfAgent,
} from './user-kind';

/** Header carrying the invitation token on invited sign-ups. */
export const INVITATION_TOKEN_HEADER = 'x-cloudgate-token';

/**
 * Run from `databaseHooks.user.create.before`: once an owner exists, sign-up
 * is closed except for invited users, whose invitation token must be valid,
 * pending, unexpired, and match the email.
 *
 * Every refusal carries a `code` as well as a message. better-auth's
 * own errors all do — `APIError.from('BAD_REQUEST', { code, message })` is the
 * shape — and the frontend branches on the code, so these five being
 * message-only meant the sign-up screen had to recognise them by matching
 * English that any wording change would break.
 */
async function assertSignUpAllowed(
  db: DrizzleDB,
  hosted: boolean,
  email: string,
  invitationToken: string | null,
): Promise<void> {
  if (invitationToken) {
    const [invite] = await db
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.id, invitationToken))
      .limit(1);
    if (!invite) {
      throw new APIError('BAD_REQUEST', {
        code: 'INVITATION_INVALID',
        message: 'Invalid invitation token',
      });
    }
    if (invite.expiresAt < new Date()) {
      throw new APIError('BAD_REQUEST', {
        code: 'INVITATION_EXPIRED',
        message: 'Invitation has expired',
      });
    }
    if (invite.status !== 'pending') {
      throw new APIError('BAD_REQUEST', {
        code: 'INVITATION_ALREADY_USED',
        message: 'Invitation has already been used',
      });
    }
    if (email.toLowerCase().trim() !== invite.email.toLowerCase().trim()) {
      throw new APIError('BAD_REQUEST', {
        code: 'INVITATION_EMAIL_MISMATCH',
        message: 'Email does not match invitation',
      });
    }
    return;
  }

  // `unclaimed` and `open` let it through; see `SignUpState`.
  const state = signUpState(hosted, await hasInstanceOwner(db));
  if (state === 'closed') {
    throw new APIError('BAD_REQUEST', {
      code: 'SIGN_UP_CLOSED',
      message: 'Admin is already created',
    });
  }
  // Hosted, before `create-instance-organization` has run: the first
  // web sign-up must not become the Instance organization's owner.
  if (state === 'not-open-yet') {
    throw new APIError('BAD_REQUEST', {
      code: SIGN_UP_NOT_OPEN_YET_CODE,
      message: SIGN_UP_NOT_OPEN_YET_MESSAGE,
    });
  }
}

/**
 * The endpoint context better-auth hands the user-create hooks. `params` is not
 * on its public type, but the SSO endpoints are path-parameterised and the
 * provider is only knowable from there.
 */
type UserCreateContext =
  | {
      path?: string;
      params?: Record<string, string | undefined>;
      /** The sign-up body — `organizationName` rides on it. */
      body?: unknown;
    }
  | null
  | undefined;

/**
 * A user arriving through any `/sso/*` endpoint is being provisioned by an
 * identity provider, not signing themselves up.
 */
const isSsoRequest = (context: UserCreateContext): boolean =>
  context?.path?.includes('/sso') ?? false;

/**
 * A user arriving through any `/scim/*` endpoint is being provisioned by an
 * identity provider's SCIM client against a bearer token, so neither the
 * sign-up rules nor the organization bootstrap apply —
 * the plugin puts them in the token's organization itself.
 */
const isScimRequest = (context: UserCreateContext): boolean =>
  context?.path?.includes('/scim') ?? false;

/**
 * Run from `databaseHooks.user.create.after`: who gets an Organization of their
 * own at sign-up, named on the form or "My Organization"
 * (`signUpOrganizationName`).
 *
 * - **Self-hosted**: the first user, and nobody else. Later users only arrive
 *   via invitation and join the inviter's organization instead.
 * - **Hosted**: every *uninvited* sign-up — `selfSignUp`, neither an
 *   invitation nor an identity provider. Each customer is an Organization, so
 *   that is what "anyone can sign up" means there. The account cannot sign in
 *   until its email is confirmed (`requireEmailVerification` below), and one
 *   never confirmed is deleted after seven days together with this
 *   Organization (`UnconfirmedAccountsService`).
 *
 * The Instance organization itself is never made here on the Hosted instance
 * only `create-instance-organization` on the platform host makes it,
 * and a web sign-up that reached here with no owner yet would be handing
 * instance authority to whoever got there first. `assertSignUpAllowed` already
 * refuses that sign-up; the `hasInstanceOwner` check keeps the rule if a path
 * ever skips the `before` hook, as SSO and SCIM do. So an Organization made
 * here is always a later, non-authoritative owner row (ADR-0013).
 */
async function bootstrapDefaultOrganization(
  db: DrizzleDB,
  hosted: boolean,
  userId: string,
  name: string,
  selfSignUp: boolean,
): Promise<boolean> {
  if (hosted) {
    if (!selfSignUp || !(await hasInstanceOwner(db))) return false;
  } else if (await hasInstanceOwner(db)) {
    return false;
  }

  await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(schema.organization)
      .values({
        name,
        ownerId: userId,
        createdAt: new Date(),
      })
      .returning();
    await tx.insert(schema.member).values({
      organizationId: org.id,
      userId,
      role: 'owner',
      createdAt: new Date(),
      isDefault: true,
    });
    // A Self-hosted first sign-up's Organization is the Instance
    // organization: pinned with it (ADR-0077). Never on the Hosted instance.
    if (!hosted) await pinInstanceOrganization(tx, org.id);
  });
  return true;
}

/**
 * Which of its two jobs a confirmation link is doing, read off the token
 * better-auth minted for it: a change of email carries the new address as
 * `updateTo` (`createEmailVerificationToken`), a sign-up's does not. The
 * signature is not checked here — this only picks the email's wording, and
 * `/verify-email` checks it when the link is followed.
 */
function confirmationPurpose(token: string): 'sign-up' | 'email-change' {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { updateTo?: unknown };
    return typeof payload.updateTo === 'string' ? 'email-change' : 'sign-up';
  } catch {
    return 'sign-up';
  }
}

/**
 * Run from `hooks.after`: on the Hosted instance an invited sign-up is signed
 * in at once (ADR-0051). The invite link was mailed to that address, so
 * following it is the confirmation — the `user.create.before` hook writes the
 * account confirmed — and the invitee goes straight on to accept it, the way
 * the console's sign-up form does.
 *
 * Here and not by switching `requireEmailVerification` off for the request:
 * better-auth reads that option *before* it creates the user, to decide how to
 * answer a taken address, and an invitation header that switched it off would
 * answer a taken address differently from a new one for anyone who sent a
 * made-up token. Reading the outcome instead keys this on what only a valid
 * invitation can produce, a new confirmed account; a taken address gets
 * better-auth's synthetic, unconfirmed reply and no session, as before.
 */
async function startInvitedSession(
  ctx: Parameters<typeof setSessionCookie>[0] & {
    path: string;
    context: { returned?: unknown };
  },
): Promise<unknown> {
  if (ctx.path !== '/sign-up/email') return undefined;
  if (!ctx.request?.headers.get(INVITATION_TOKEN_HEADER)) return undefined;
  const returned = ctx.context.returned as
    | { token?: unknown; user?: { id?: string; emailVerified?: boolean } }
    | undefined;
  if (
    !returned ||
    returned instanceof Error ||
    returned.token !== null ||
    returned.user?.emailVerified !== true ||
    !returned.user.id
  ) {
    return undefined;
  }
  const created = await ctx.context.internalAdapter.findUserById(
    returned.user.id,
  );
  if (!created) return undefined;
  const session = await ctx.context.internalAdapter.createSession(created.id);
  await setSessionCookie(ctx, { session, user: created });
  return ctx.json({ ...returned, token: session.token });
}

/**
 * Run from `user.create.after` on an SSO request: a user an identity
 * provider just provisioned joins the organization that provider belongs to, as
 * a plain member. Without this they would have no membership at all and every
 * organization-scoped route would refuse them.
 */
async function joinProviderOrganization(
  db: DrizzleDB,
  userId: string,
  context: UserCreateContext,
): Promise<void> {
  const providerId = context?.params?.providerId;
  if (!providerId) {
    throw new APIError('BAD_REQUEST', { message: 'Provider ID is required' });
  }

  const [provider] = await db
    .select({ organizationId: schema.ssoProvider.organizationId })
    .from(schema.ssoProvider)
    .where(eq(schema.ssoProvider.providerId, providerId))
    .limit(1);
  if (!provider) {
    throw new APIError('BAD_REQUEST', { message: 'Provider not found' });
  }

  await db.insert(schema.member).values({
    userId,
    organizationId: provider.organizationId ?? '',
    role: 'member',
    createdAt: new Date(),
    isDefault: true,
  });
}

/**
 * The Hosted instance's SSO refusal (ADR-0051): an SSO provider acts
 * only for an email in a domain its Organization has proven. Asked from every
 * hook an SSO callback passes through on its way to a session — the user it
 * would create, the account it would link onto an existing person, and the
 * session itself — so no path through `handleOAuthUserInfo` gets past it, and a
 * refused sign-in leaves no user, link or membership behind.
 *
 * `providerId` is the path's own (`/sso/callback/:providerId`, the SAML ACS),
 * or the account's when one is being linked. A callback that names none is
 * refused: nothing proves anything for it.
 */
async function refuseUnprovenSsoSignIn(
  db: DrizzleDB,
  providerId: string | undefined,
  email: string,
): Promise<void> {
  if (await providerActsFor(db, providerId, email)) return;
  throw new APIError('FORBIDDEN', {
    code: SSO_DOMAIN_NOT_PROVEN_CODE,
    message: SSO_DOMAIN_NOT_PROVEN_MESSAGE,
  });
}

/**
 * The same rule at `POST /sign-in/sso`, before the browser is sent anywhere:
 * an address whose domain a provider claims but its Organization has not
 * proven routes to nobody. A request that names no domain (a bare
 * `providerId`) and a domain no provider claims are left to the plugin; the
 * callback check above still stands between either and a session.
 */
async function refuseUnprovenSsoRoute(
  db: DrizzleDB,
  body: unknown,
): Promise<void> {
  const { email, domain, providerId } = (body ?? {}) as {
    email?: unknown;
    domain?: unknown;
    providerId?: unknown;
  };
  const routed =
    typeof domain === 'string' && domain
      ? domain.trim().toLowerCase()
      : typeof email === 'string'
        ? emailDomain(email)
        : null;
  if (!routed) return;
  const routing = await routingFor(db, {
    domain: routed,
    providerId: typeof providerId === 'string' ? providerId : undefined,
  });
  if (routing !== 'unproven') return;
  throw new APIError('FORBIDDEN', {
    code: SSO_DOMAIN_NOT_PROVEN_CODE,
    message: SSO_DOMAIN_NOT_PROVEN_MESSAGE,
  });
}

/**
 * SSO sign-in stops below Business (ADR-0054), in both instance modes:
 * a provider whose Organization fails the paid-feature check signs nobody in.
 * Asked from the same three hooks as `refuseUnprovenSsoSignIn`, so a flow
 * started while the Organization was on Business cannot finish after it moved
 * down. A callback that names no provider is refused: no Organization passes
 * for it.
 */
async function refuseSsoSignInOff(
  options: Pick<AuthOptions, 'paidFeatures' | 'instanceMode'>,
  organizationId: string | null | undefined,
): Promise<void> {
  if (
    organizationId &&
    (await options.paidFeatures.hasValidLicense(organizationId))
  ) {
    return;
  }
  throw new APIError('FORBIDDEN', {
    code: SSO_SIGN_IN_OFF_CODE,
    message: ssoSignInOffMessage(options.instanceMode.isHosted),
  });
}

/**
 * The same rule at `POST /sign-in/sso`, before the browser is sent anywhere:
 * the provider the plugin would route this body to, if any, must belong to an
 * Organization that passes the paid-feature check. A body that routes to no
 * provider is left to the plugin's own refusal.
 */
async function refuseSsoRouteOff(
  db: DrizzleDB,
  options: Pick<AuthOptions, 'paidFeatures' | 'instanceMode'>,
  body: unknown,
): Promise<void> {
  const organizationId = await organizationRoutedTo(db, body);
  if (organizationId === undefined) return;
  await refuseSsoSignInOff(options, organizationId);
}

/** The `:providerId` of the OIDC callback's path, or undefined. */
function ssoCallbackProviderId(params: unknown): string | undefined {
  const providerId =
    params && typeof params === 'object'
      ? (params as { providerId?: unknown }).providerId
      : undefined;
  return typeof providerId === 'string' ? providerId : undefined;
}

/** The address of a user row, for the hooks that only hold its id. */
async function emailOf(db: DrizzleDB, userId: string): Promise<string> {
  const [row] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row?.email ?? '';
}

/**
 * Backs the session create/delete audit hooks: the trail records the actor's
 * role in the organization the session belongs to.
 */
function recordSessionAudit(
  auditLogs: AuditRecorder,
  action: 'login' | 'logout',
  sessionRow: { userId: string; ipAddress?: string | null },
  organizationId: string | null | undefined,
) {
  return auditLogs.audit(
    {
      userId: sessionRow.userId,
      organizationId,
      ip: sessionRow.ipAddress ?? undefined,
    },
    { action, resourceType: 'session' },
  );
}

/**
 * The one `/api/auth` endpoint a banned account must still reach: leaving
 * (H-08).
 *
 * The console's dead-session exit ends the session before it navigates, because
 * `frontend/src/proxy.ts` reads cookie *presence* and a redirect with the cookie
 * still set is a loop. So refusing `/sign-out` would refuse a banned operator
 * the one action that gets them off a console they are no longer entitled to —
 * and it would refuse it *after* better-auth had already deleted the row, so the
 * session would be gone and the browser would never be told.
 *
 * Everything else on this surface is deliberately not exempt, and the set is
 * meant to stay this size. A per-endpoint judgement about whether the cookie
 * names the identity the request is *about* would be a longer list, would have
 * to be revisited every time better-auth adds a route, and is one un-added entry
 * away from a hole. "A banned session buys nothing here except the door out" is
 * the rule; this is the door.
 */
const BAN_EXEMPT_PATHS = new Set(['/sign-out']);

/**
 * The ban, on better-auth's own surface (the half H-08 found open).
 *
 * `AuthController` mounts better-auth's handler at `/api/auth/*` and every
 * Cloudgate route is guarded by `AuthService.validateRequest`, so the ban fix read as
 * complete: four readers refuse a banned credential and an open socket closes on
 * the next ADR-0012 lease tick. The reader nobody counted is the passthrough
 * itself. `/api/auth/get-session` is `@Public()` by construction — it *is* how a
 * caller finds out whether they have a session — so it never meets
 * `validateRequest`, and it answered a full live session body, token included,
 * for a row carrying `banned = true, ban_expires = now() + 1h`. The console
 * gates on exactly that read, so a banned operator kept a rendered console with
 * their Organization, their Recents and their navigation, and every 403 behind
 * it was reported to them as a *role* problem. The wire was safe throughout;
 * the account was not visibly banned to the person holding it.
 *
 * **It is every endpoint on the surface, not `/get-session` alone.** The live
 * capture caught `/api/auth/organization/list` answering **304** two lines below
 * that 200, which is the Organization the console draws its whole scope from —
 * so refusing one route would have moved the finding rather than closed it. The
 * session is taken from `ctx.context.session` when the endpoint put one there,
 * which `/get-session` does (`getSession` in `api/routes/session.mjs`) and which
 * therefore costs nothing on the one route a signed-in console calls in a loop.
 *
 * **The fallback read is the price of the other endpoints, and it is measured.**
 * `sessionMiddleware` resolves the caller into the *endpoint's* context, and
 * better-call rebuilds that context per endpoint and per middleware, so what
 * `/organization/list` resolved is not on the object an after-hook is handed —
 * verified, not assumed: `ctx.context.session` is `null` there while the handler
 * two frames down is reading `ctx.context.session.user.id`. So a request that
 * reached an endpoint without publishing a session is resolved once more here,
 * with `disableRefresh` because an authorization read must not renew the
 * credential it is about to refuse. One extra session lookup on the `/api/auth`
 * routes a browser calls occasionally, and none on the one it polls.
 *
 * Rejected: doing this in `hooks.before` instead, where `getSessionFromCtx`
 * caches into the context the endpoint will use and the second read would cost
 * nothing. It would pay the read on `/get-session` — the polled route — to save
 * it on the rare ones, which is the trade the wrong way round, and it would seed
 * a session into a context better-auth had not decided to read one in, ahead of
 * the cookie handling `getAuthoritativeSessionFromCtx` exists to undo.
 *
 * **A banned session buys nothing here except the door out**, and that is the
 * rule rather than an accident of which endpoints resolve a session. A caller
 * presenting a banned cookie to `/sign-in/email` is refused by this hook before
 * the plugin's own `BANNED_USER` can refuse them, and a caller presenting one
 * while signing in *as somebody else* is refused too. That second case is
 * deliberate and is the reason the exempt set is a set: the alternative is
 * deciding, per endpoint, whether the cookie names the identity being asked
 * about, and a list like that is one un-added entry away from a hole.
 *
 * **`ctx.request` is the whole of what keeps this off the in-process path.**
 * `auth.api.getSession` is dispatched through the same hook pipeline
 * (`api/dispatch.mjs`), and `AuthService.validateRequest` calls it — with
 * headers and no request — three lines before making this very refusal itself,
 * as a typed `CredentialRejection` the guard renders. Throwing here instead
 * would replace that with a raw `APIError` for `AllExceptionsFilter` to render
 * as a 500. One predicate, two deliveries, which is the arrangement
 * `apiKeyOwner` already documents for the api-key path.
 *
 * The status is 403 and the sentence is `ban.ts`'s, so the answer is the one
 * the ban fix settled; the code is better-auth's `BANNED_USER`, because a browser
 * cannot tell this refusal from the one sign-in already gives and must not have
 * to learn two spellings of it. `frontend/src/lib/auth/console-gate.ts` is what
 * acts on it — a 403 is otherwise a *role* refusal to that guard, and it would
 * deliberately not sign anyone out for one.
 */
async function refuseBannedSession(ctx: {
  request?: Request;
  path: string;
  context: { session?: { user?: unknown } | null };
}): Promise<void> {
  if (!ctx.request || BAN_EXEMPT_PATHS.has(ctx.path)) return;
  // The parameter is narrowed to the three fields this reads, so the cast is
  // back to what the caller already hands it — `hooks.after` is typed for every
  // endpoint at once, and naming that union here would tie one ban check to
  // better-auth's whole route table.
  const resolved =
    ctx.context.session ??
    (await getSessionFromCtx(ctx as Parameters<typeof getSessionFromCtx>[0], {
      disableRefresh: true,
    }));
  const caller = resolved?.user as
    { banned?: boolean | null; banExpires?: Date | null } | undefined;
  if (!caller || !banInForce(caller)) return;
  throw new APIError('FORBIDDEN', {
    code: BANNED_CODE,
    message: BANNED_MESSAGE,
  });
}

/**
 * The header the api-key plugin reads a key from — its default `apiKeyHeaders`,
 * which `createAuth` leaves alone. Named here because {@link refuseAgentSession}
 * has to read the same header before the plugin does.
 */
const API_KEY_HEADER = 'x-api-key';

/**
 * An Agent key, refused on the whole of better-auth's own surface
 * (ADR-0023): every `/api/auth/*` endpoint, every method.
 *
 * `AuthController` mounts better-auth whole and `@Public()`, so an Agent key
 * never meets `AuthService.validateRequest` here — and the api-key plugin's
 * `enableSessionForAPIKeys` hook turns an `x-api-key` into a session that
 * every endpoint reading `ctx.context.session` believes. An Agent holding one
 * could rename its own user through `/update-user`, leave its Organization
 * through `/organization/leave`, or start linking a social account to itself.
 * An Agent acts through the MCP endpoint and nowhere else.
 *
 * **A `before` hook, and the `user` one, not an after-hook like
 * {@link refuseBannedSession}.** Two measured reasons. An after-hook runs once
 * the endpoint has, so the writes above would already have happened by the
 * time it refused. And on `/get-session` the api-key plugin's own before-hook
 * *returns* the session instead of handing on the context
 * (`@better-auth/api-key` `dist/index.mjs`, `if (ctx.path === "/get-session")
 * return session`), which makes `dispatch.mjs` answer straight away and skip
 * every after-hook — so an after-hook cannot see that route at all. The user's
 * before-hook runs ahead of every plugin's (`getHooks`), which is also why the
 * session cannot be read here: the plugin has not built it yet. So the key is
 * read from the header the plugin would read, and its owner looked up by the
 * plugin's own hash (`apiKeyOwnerKind`) without verifying it — verifying would
 * run the plugin's delete-on-expiry, and an expired Agent key is a row
 * Cloudgate keeps.
 *
 * **No exempt paths**, unlike the ban's `/sign-out`: an Agent has no browser
 * session to leave. A cookie cannot carry one either, because
 * `session.create.before` refuses to create a session for an Agent by any
 * route; that refusal, not this one, is what "an Agent cannot sign in" rests
 * on. A key nobody holds, or a person's key, passes untouched to the plugin,
 * which refuses or accepts it exactly as before.
 */
async function refuseAgentSession(
  db: DrizzleDB,
  ctx: { headers?: Headers },
): Promise<void> {
  const key = ctx.headers?.get(API_KEY_HEADER);
  if (!key) return;
  if ((await apiKeyOwnerKind(db, key)) !== 'agent') return;
  throw new APIError('FORBIDDEN', {
    code: AGENT_REFUSAL_CODE,
    message: AGENT_REFUSAL_MESSAGE,
  });
}

/** The one device-flow client: the Cloudgate CLI. */
export const CLI_CLIENT_ID = 'cloudgate-cli';

/**
 * The person's half of the device flow: looking a code up (which claims it),
 * approving it and denying it.
 */
const DEVICE_APPROVAL_PATHS = new Set([
  '/device',
  '/device/approve',
  '/device/deny',
]);

export const DEVICE_APPROVAL_REFUSAL_CODE = 'INTERACTIVE_SESSION_REQUIRED';

/**
 * A Personal key, refused on the person's half of the device flow.
 *
 * Approving a code mints a Personal key, so a key that could approve one could
 * mint its own successor — the hole `disabledPaths` closes on the api-key
 * plugin's routes. `enableSessionForAPIKeys` would let it: the
 * plugin turns `x-api-key` into the session the device routes read. So these
 * three need the console session, as `UsersService.createApiKey` does, and a
 * CLI login is never itself an interactive session.
 */
function refuseKeyOnDeviceApproval(ctx: {
  path?: string;
  headers?: Headers;
}): void {
  if (!ctx.path || !DEVICE_APPROVAL_PATHS.has(ctx.path)) return;
  if (!ctx.headers?.get(API_KEY_HEADER)) return;
  throw new APIError('FORBIDDEN', {
    code: DEVICE_APPROVAL_REFUSAL_CODE,
    message:
      'Approving a CLI login requires an interactive session. A personal key cannot be used here; sign in to the console and retry.',
  });
}

/**
 * Refuses an Agent a session or an account, whichever route asks.
 *
 * An Agent has no password and no SSO link, so no sign-in form can reach one
 * today — but "today" is a property of the rows, and an identity provider an
 * admin registered could still present an Agent's address with
 * `email_verified`, which `accountLinking` would link. So the refusal sits on
 * the two writes every sign-in method ends in rather than on each method:
 * better-auth never creates an `account` for an Agent, and never a `session`.
 */
function refuseAgentUser(db: DrizzleDB, userId: string): Promise<void> {
  // No row is not an Agent: better-auth creates the user before either write,
  // in the same transaction, so a missing row is its problem to report.
  return refuseIfAgent(db, userId, {
    code: AGENT_REFUSAL_CODE,
    message: AGENT_REFUSAL_MESSAGE,
  });
}

/** The slice of AuditLogService the auth hooks need (keeps the config db-only). */
export interface AuditRecorder {
  audit(
    actor: {
      userId: string;
      organizationId: string | null | undefined;
      ip?: string;
    },
    event: { action: 'login' | 'logout'; resourceType: 'session' },
  ): Promise<unknown>;
}

/** The slice of MailService the auth hooks need (keeps the config db-only). */
export interface TransactionalMailer {
  send(to: string, email: RenderedEmail): Promise<void>;
}

export interface AuthOptions {
  secret: string;
  baseURL?: string;
  /**
   * Origins a browser may sign in from besides `baseURL`'s own
   * (TRUSTED_ORIGINS) — merged below with the ones the owners allowlisted at runtime.
   */
  trustedOrigins?: string[];
  /**
   * The hops whose `x-forwarded-for` entries may be stripped to find the client,
   * as IPs and CIDR ranges (derived from TRUST_PROXY). Empty on a
   * deployment with nothing in front, which is what makes better-auth believe a
   * single-entry header only.
   */
  trustedProxies?: string[];
  /** Writes the login/logout trail from the session hooks. */
  auditLogs: AuditRecorder;
  /**
   * Whether this is the Hosted instance — `InstanceMode`, asked on every
   * sign-up rather than once here, so the sign-up rules follow it.
   */
  instanceMode: { readonly isHosted: boolean };
  /**
   * The paid-feature check (`LicenseService.hasValidLicense`): the license
   * key Self-hosted, Business or Enterprise Hosted. SSO sign-in stops for a
   * provider whose Organization fails it, and SCIM's IdP-facing
   * pushes that add or widen access ask it (`scim-plan-gate.ts`).
   */
  paidFeatures: PaidFeatureCheck;
  /**
   * Which Organizations' SSO URLs and trusted origins must be public, and
   * the check itself (`SsoAddressPolicy`, ADR-0076): the Hosted instance's
   * customers. Asked at `POST /sign-in/sso` and the OIDC callback, and for
   * whose trusted origins a request counts.
   */
  ssoAddresses: SsoAddressCheck;
  /**
   * Sends the password-reset link and the organization invitation. Left
   * undefined on an instance with no mail sender configured — see the
   * `emailAndPassword` block and the `organization` plugin below.
   */
  mail?: TransactionalMailer;
  /**
   * The Hosted sign-up form's Turnstile check: TURNSTILE_SECRET_KEY
   * and where to verify it (Cloudflare's siteverify unless a test fakes it).
   * Read only when hosted, whose boot refuses to start without the key.
   */
  turnstile?: { secretKey: string; siteVerifyURL?: string };
  /**
   * The clock the one-confirmation-email-per-address limit reads;
   * the system clock unless a test moves it on.
   */
  confirmationEmailClock?: ConfirmationEmailClock;
}

/**
 * The statically configured origins plus the runtime ones of `owners`
 * (`trusted-origin-scope.ts`): every Organization's on a Self-hosted
 * instance, as before; on the Hosted instance only the Instance
 * organization's and, on a request that is one customer's own SSO, that
 * customer's. The SSO plugin consults this to decide whether it may fetch a
 * provider's endpoints, and better-auth to check a request's `Origin` and
 * its `callbackURL`.
 */
async function resolveTrustedOrigins(
  db: DrizzleDB,
  configured: string[],
  owners: TrustedOriginOwners,
): Promise<string[]> {
  try {
    let rows: { trustedOrigins: string[] | null }[];
    if (owners === 'every') {
      rows = await db
        .select({ trustedOrigins: schema.user.trustedOrigins })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
        .where(eq(schema.member.role, 'owner'));
    } else if (owners.length === 0) {
      rows = [];
    } else {
      // The owner's row is where `SsoService` keeps an Organization's list.
      rows = await db
        .select({ trustedOrigins: schema.user.trustedOrigins })
        .from(schema.organization)
        .innerJoin(schema.user, eq(schema.organization.ownerId, schema.user.id))
        .where(inArray(schema.organization.id, owners));
    }
    return [
      ...configured,
      ...new Set(rows.flatMap((row) => row.trustedOrigins ?? [])),
    ];
  } catch (error) {
    console.error('Failed to resolve trusted origins:', error);
    return configured;
  }
}

/**
 * Whose runtime origins count on `request`; with no request (the boot-time
 * list, the console's own-domain check) no customer's do on the Hosted
 * instance.
 */
async function trustedOriginOwnersFor(
  db: DrizzleDB,
  options: Pick<AuthOptions, 'instanceMode' | 'ssoAddresses'>,
  request?: AuthRequestShape,
): Promise<TrustedOriginOwners> {
  if (!options.instanceMode.isHosted) return 'every';
  return trustedOriginOwners({
    hosted: true,
    instanceOrganizationId: await options.ssoAddresses.instanceOrganizationId(),
    ssoOrganizationId: request
      ? await ssoOrganizationOfRequest(request, {
          organizationOfProvider: (providerId) =>
            organizationOfProvider(db, providerId),
          organizationRoutedTo: (body) => organizationRoutedTo(db, body),
        })
      : null,
  });
}

/**
 * Every origin a browser may call `/api/auth` from on this request: `baseURL`'s
 * own, then {@link resolveTrustedOrigins}. The `before` hook below installs
 * exactly this list and {@link isOriginTrustedNow} reads it, so the console's
 * warning about its own domain and the gate that refuses it read one list.
 */
async function trustedOriginsNow(
  db: DrizzleDB,
  baseURL: string | undefined,
  configured: string[],
  owners: TrustedOriginOwners,
): Promise<string[]> {
  return [
    ...(baseURL ? [new URL(baseURL).origin] : []),
    ...(await resolveTrustedOrigins(db, configured, owners)),
  ].filter(Boolean);
}

/**
 * Whose runtime origins count, per `Auth` instance, for
 * {@link isOriginTrustedNow}: its callers hand it the two configured keys but
 * not the instance mode, and the answer has to be the gate's.
 */
const originOwnersOf = new WeakMap<
  object,
  () => Promise<TrustedOriginOwners>
>();

/**
 * Whether a browser on `origin` gets past better-auth's origin check right now
 * — asked by Settings about the console's own domain, because an HTTPS
 * console that nobody can sign in to is otherwise indistinguishable from a
 * working one until somebody tries.
 *
 * The match is better-auth's `isTrustedOrigin`, not a comparison spelled here:
 * an owner's list may hold a wildcard, which the plugin matches and `===` would
 * not. It is run over {@link trustedOriginsNow} rather than the context's own
 * list, which is resolved once at boot (see the hook) and so would miss an
 * origin allowlisted since — `settings/console-origin.e2e-spec.ts` pins the
 * two agreeing, a runtime-allowlisted origin included.
 */
export async function isOriginTrustedNow(
  auth: Auth,
  db: DrizzleDB,
  options: Pick<AuthOptions, 'baseURL' | 'trustedOrigins'>,
  origin: string,
): Promise<boolean> {
  const context = await auth.$context;
  const trustedOrigins = await trustedOriginsNow(
    db,
    options.baseURL,
    options.trustedOrigins ?? [],
    // A request on no Organization's SSO: the console's own domain.
    (await originOwnersOf.get(auth)?.()) ?? 'every',
  );
  // A copy carrying the fresh list, so the plugin's own method reads it as
  // `this.trustedOrigins` — the shared context is left alone.
  const current = { ...context, trustedOrigins };
  return current.isTrustedOrigin(origin);
}

// The better-auth instance served at `/api/auth`.
export const createAuth = (db: DrizzleDB, options: AuthOptions) => {
  const auth = createAuthWith(
    db,
    options,
    new ConfirmationEmailLimit(options.confirmationEmailClock),
  );
  originOwnersOf.set(auth, () => trustedOriginOwnersFor(db, options));
  return auth;
};

const createAuthWith = (
  db: DrizzleDB,
  options: AuthOptions,
  confirmationEmails: ConfirmationEmailLimit,
) =>
  betterAuth({
    appName: 'Cloudgate',
    basePath: '/api/auth',
    // Org create/update/delete go through OrganizationsController, which
    // enforces the self-hosted owner rules.
    //
    // The SSO provider *writes* go through SsoController for the same reason:
    // the plugin's own endpoints gate on better-auth's org-admin check alone,
    // with no enterprise licence and no Cloudgate org scoping, so they would be
    // a second way into the same table that skips both. That is as true of
    // update/delete-provider as of `/sso/register`, so all three are closed.
    // Reads (`/sso/providers`, `/sso/get-provider`) stay open — they are
    // org-admin scoped and expose nothing the licensed read routes do not.
    disabledPaths: [
      '/organization/create',
      '/organization/update',
      '/organization/delete',
      '/sso/register',
      '/sso/update-provider',
      '/sso/delete-provider',
      // The SCIM plugin's management writes, closed for the same reason: they
      // gate on better-auth's org-role check alone, with no enterprise licence
      // and no provider-id collision check, so they would be a second way into
      // the same table. The reads (`/scim/list-provider-connections`,
      // `/scim/get-provider-connection`)
      // stay open — they are org-role scoped and expose nothing the licensed
      // routes do not. `/scim/v2/*` is the IdP-facing surface and must stay
      // open: it authenticates with a provider's bearer token, not a session.
      '/scim/generate-token',
      '/scim/delete-provider-connection',
      // The api-key plugin's whole HTTP surface. A key that can mint
      // its own replacement cannot be revoked: deleting the key the owner can
      // see leaves the successor the holder already made. So keys are managed
      // only through `/users/me/api-keys`, whose three routes refuse a key
      // (`UsersService`'s `assertInteractiveSession`) and so need a console
      // session, and deleting a key revokes whoever holds it. These are every
      // route `@better-auth/api-key@1.6.33`
      // registers; its verify and delete-expired endpoints are server-only and
      // never routed. `disabledPaths` matches exact paths, so an upgrade that
      // adds one must add it here — `users.e2e-spec.ts` enumerates the live
      // plugin and reds if it does.
      '/api-key/create',
      '/api-key/get',
      '/api-key/update',
      '/api-key/delete',
      '/api-key/list',
      // The plugin's role write, closed like the org writes above: it gates on
      // better-auth's org-role check alone, so it would be a second writer of
      // `member.role` beside `OrganizationsService.updateMemberRole` that
      // skips the licence and owner rules.
      '/organization/update-member-role',
      // The plugin's other writes of `member`, closed for the same reason.
      // Closing a path only unroutes it: Cloudgate's own routes still
      // call `auth.api.createInvitation` and `auth.api.removeMember`
      // in-process. `organizations.e2e-spec.ts` classifies every routed
      // `POST /organization/*` as closed or kept open, so an upgrade that adds
      // one reds until it is placed.
      //  - invite-member: an owner may invite `owner` (a second owner once
      //    accepted) or a comma-joined role, with no `assertRoleFitsKind`,
      //    no custom-role check and no audit row. The one door is
      //    `POST /organizations/invitations`.
      //  - remove-member: the same checks as Cloudgate's
      //    `DELETE /organizations/members/:id`, which delegates to it, but no
      //    audit row.
      //  - leave: no Cloudgate counterpart and no console affordance, and no
      //    audit row.
      '/organization/invite-member',
      '/organization/remove-member',
      '/organization/leave',
      // The CLI's half of the device flow, which Cloudgate's own
      // `DeviceLoginController` serves at `/auth/device/*` instead:
      //  - code: in better-auth 1.6.33 it stores a `user_id` taken from an
      //    unauthenticated body, so anyone could bind a code to a person
      //    before they saw it. Cloudgate's route takes no fields at all and calls
      //    this one in-process.
      //  - token: on approval it creates a better-auth *session* and hands
      //    its token over; Cloudgate's hands over a Personal key instead.
      // The person's half (`/device`, `/device/approve`, `/device/deny`)
      // stays routed for the console, behind `refuseKeyOnDeviceApproval`.
      '/device/code',
      '/device/token',
      // better-auth's own email change, which needs only a session — no
      // password and no API-key refusal, where `PATCH /users/me` asks for both.
      // `UsersService.updateProfile` calls it in-process on the Hosted
      // instance once those have passed, for its confirmation mail.
      '/change-email',
    ],
    secret: options.secret,
    baseURL: options.baseURL,
    // Resolved from the database, so allowlisting an origin takes effect
    // without a restart.
    trustedOrigins: async () =>
      resolveTrustedOrigins(
        db,
        options.trustedOrigins ?? [],
        await trustedOriginOwnersFor(db, options),
      ),
    hooks: {
      // Both halves are needed. The option alone is resolved
      // when better-auth builds its context, and its per-request refresh does
      // not reach the `isTrustedOrigin` an endpoint handler calls — so without
      // this hook a provider allowlisted after boot stays untrusted and the SSO
      // flow refuses its endpoints (four e2e cases pin exactly that).
      before: createAuthMiddleware(async (ctx) => {
        // An Agent key reaches nothing here — see `refuseAgentSession`.
        await refuseAgentSession(db, ctx);
        // A Personal key approves no CLI login.
        refuseKeyOnDeviceApproval(ctx);
        if (ctx.path === '/sign-in/sso') {
          // An unproven domain routes nobody on the Hosted instance.
          if (options.instanceMode.isHosted) {
            await refuseUnprovenSsoRoute(db, ctx.body);
          }
          // Nor does a provider below Business, in either mode.
          await refuseSsoRouteOff(db, options, ctx.body);
          // Nor one the platform host may not fetch (ADR-0076).
          await refuseNonPublicOidcProvider(
            options.ssoAddresses,
            await providerRoutedTo(db, ctx.body),
          );
        }
        if (ctx.path === '/sso/callback/:providerId') {
          // Checked again where the token, userinfo and JWKS are fetched.
          await refuseNonPublicOidcProvider(
            options.ssoAddresses,
            await providerNamed(db, ssoCallbackProviderId(ctx.params)),
          );
        }
        // SCIM adds nothing below the paid features; removals pass.
        await refuseScimAddWithoutPaidFeatures(db, options, ctx);
        // On the Hosted instance a customer's origins count only on its own
        // SSO requests (`trusted-origin-scope.ts`, ADR-0076).
        ctx.context.trustedOrigins = await trustedOriginsNow(
          db,
          ctx.context.baseURL,
          options.trustedOrigins ?? [],
          await trustedOriginOwnersFor(db, options, ctx),
        );
        // After the refresh above, so an origin allowlisted since boot counts.
        refuseForeignConfirmationCallback(ctx);
      }),
      // The ban, on the surface this config *is* — see `refuseBannedSession`
      // (H-08). A hook rather than a plugin so that it runs before every
      // plugin's own after-hooks (`api/dispatch.mjs` `getHooks`), which is what
      // keeps a banned caller out of a plugin's response-shaping as well as its
      // body.
      after: createAuthMiddleware(async (ctx) => {
        await refuseBannedSession(ctx);
        // The other Instance mode's cookies go with a sign-out (#32).
        if (ctx.path === '/sign-out') {
          expireOtherModeCookies(ctx, options.instanceMode.isHosted);
        }
        // A SCIM route's schema refusal, in SCIM's error schema.
        restateScimValidationError(ctx);
        // Only the Hosted instance holds a sign-up's session back; an invited
        // one there starts it here instead.
        if (options.instanceMode.isHosted) return startInvitedSession(ctx);
      }),
    },
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
    }),
    advanced: {
      // `Secure` on the Hosted instance, which is served on HTTPS alone
      // (`deploy/install.sh`'s hosted path), so a session cookie is
      // never sent over plain HTTP. better-auth then names its cookies
      // `__Secure-better-auth.*`; the console's cookie readers accept both
      // spellings. Off when self-hosted, where a stock install is plain HTTP on
      // :3000 and a Secure cookie would never come back. Read once, at boot:
      // the instance mode cannot change without a restart.
      useSecureCookies: options.instanceMode.isHosted,
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: options.instanceMode.isHosted,
        httpOnly: true,
        path: '/',
      },
      // What `session.ip_address` is allowed to be. `getIp` reads a
      // header and nothing else — there is no socket behind the Web `Request`
      // it is handed — and with no `trustedProxies` it discards any
      // `x-forwarded-for` carrying more than one entry
      // (`@better-auth/core` `dist/utils/ip.mjs:188`). So a deployment behind
      // Traefik or a load balancer stored no address at all, however correct
      // `AuthController.toWebRequest` and Express's `trust proxy` were: the
      // chain arrived intact and was thrown away for being a chain.
      //
      // Naming the hops here is what lets `:175-187` strip from the right to
      // the first untrusted one and keep the person's address. Empty is the
      // shipped default and is the safe reading, not a disabled feature —
      // better-auth then trusts a single-entry header only, and
      // `toWebRequest` is what puts the socket peer there when the caller sent
      // none.
      //
      // `ipAddressHeaders` is deliberately left at better-auth's default of
      // `["x-forwarded-for"]`. Adding `x-real-ip` or `cf-connecting-ip` would
      // widen what a caller can assert without widening what is verified, and
      // this key exists to narrow that, not to grow it. It is also the fix that
      // looks right for an unresolved address and cannot work: `getIp` walks *every* header in
      // this list with the same `trustedProxies` (`ip.mjs:205-211`), so a
      // second header resolves to `null` for exactly the same reason the first
      // does.
      //
      // The third case, which this list cannot express: a request from a
      // *declared* proxy that named nobody. The walk at `:175-187` only ever
      // returns an entry it did not step past, and it steps past exactly the
      // declared ones — so a chain whose only entry is the declared peer runs
      // the walk out and returns `null`, and `createSession` stores `""`. The
      // peer travels on `SOCKET_PEER_HEADER` instead and the
      // `session.create.before` hook below fills it in when better-auth
      // resolved nothing; `AuthController.toWebRequest` deletes that header
      // before setting it, so it is Cloudgate's statement about a socket rather
      // than one more thing a caller can assert.
      ipAddress: {
        trustedProxies: options.trustedProxies ?? [],
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      // On the Hosted instance a password sign-in is refused with 403
      // EMAIL_NOT_VERIFIED until the address is confirmed, and sign-up starts
      // no session (better-auth then skips `autoSignIn`, and answers a taken
      // address exactly as a new one) — ADR-0051. Self-hosted never
      // asks: its accounts are its owner's and the people they invite.
      //
      // A getter, not a value read once here, so it follows `InstanceMode` on
      // every request as the sign-up rules do: better-auth reads the
      // option off this object on each sign-up and sign-in.
      get requireEmailVerification() {
        return options.instanceMode.isHosted;
      },
      // Without this better-auth refuses `/request-password-reset` outright
      // with RESET_PASSWORD_DISABLED and never mints a token, so the whole
      // reset flow is unreachable. `url` is the `/reset-password/<token>`
      // callback it builds from the caller's `redirectTo`; following it checks
      // the token and forwards to that screen with `?token=`.
      //
      // `resetPasswordTokenExpiresIn` is deliberately left at better-auth's
      // default of one hour — what the email copy and the /forgot-password
      // screen both promise.
      //
      // Omitted entirely when no mail sender is configured: better-auth's own
      // refusal is what /forgot-password renders as its explicit "this instance
      // cannot send email yet" state, which is a far better answer than
      // accepting the request and failing on the send.
      ...(options.mail
        ? {
            sendResetPassword: async ({
              user,
              url,
            }: {
              user: { email: string; name: string };
              url: string;
            }) => {
              // Named here rather than in the sender: the sender is shared
              // with the notification channels and cannot know what it is
              // carrying.
              await sendTransactional(
                options.mail!,
                'password reset',
                user.email,
                await renderResetPasswordEmail({
                  userName: user.name,
                  resetUrl: url,
                }),
              );
            },
          }
        : {}),
    },
    // The confirmation email: sent on a Hosted sign-up, again from the
    // "check your inbox" screen (`/send-verification-email`), and to the new
    // address when a confirmed account changes its email
    // (`UsersService.updateProfile`, through `changeEmail`). Following the link
    // is better-auth's `/verify-email`, which marks the address confirmed — or,
    // for a change, only then writes the new address.
    //
    // Getters for the reason on `requireEmailVerification`. Self-hosted gets no
    // sender here at all, so `/send-verification-email` keeps refusing with
    // VERIFICATION_EMAIL_NOT_ENABLED and nothing about it changes. The Hosted
    // instance always has one: its boot refuses to start without Resend
    // (`checkInstanceModeBoot`).
    emailVerification: {
      get sendOnSignUp() {
        return options.instanceMode.isHosted;
      },
      // Following the link of a Hosted sign-up signs the person in, so the
      // console can carry on to where they were going: the link's
      // `callbackURL` is the `?next=` path the sign-up carried (the
      // get-started wizard's, ADR-0073), or `/sign-in` without one. The link
      // already proves the address, which is all a password sign-in would
      // add on a new account: it has no 2FA yet, and better-auth signs in
      // only on the first, unconfirmed follow, never for an address already
      // confirmed. `callbackURL` stays on this origin: better-auth's origin
      // check, and `refuseForeignConfirmationCallback` in every mode, refuse
      // anything but a relative path or a trusted origin, and
      // the console sends only `safeNextPath`'s. A change of email is
      // better-auth's other branch and unaffected.
      get autoSignInAfterVerification() {
        return options.instanceMode.isHosted;
      },
      get sendVerificationEmail() {
        const mail = options.mail;
        if (!options.instanceMode.isHosted || !mail) return undefined;
        return async ({
          user,
          url,
          token,
        }: {
          user: { email: string; name: string };
          url: string;
          token: string;
        }) => {
          const purpose = confirmationPurpose(token);
          // An invited sign-up, already confirmed by its invite link:
          // better-auth sends on every sign-up, but there is nothing to
          // confirm. A change of email is sent for a confirmed account too,
          // and is a different purpose.
          if (
            purpose === 'sign-up' &&
            (user as { emailVerified?: boolean }).emailVerified === true
          ) {
            return;
          }
          // One per address every few minutes, whichever of the three
          // routes asked: a second within the window is refused 429
          // CONFIRMATION_EMAIL_LIMITED and nothing is sent.
          await confirmationEmails.send(user.email, async () =>
            sendTransactional(
              mail,
              'email confirmation',
              user.email,
              await renderVerificationEmail({
                userName: user.name,
                verificationUrl: url,
                purpose,
              }),
            ),
          );
        };
      },
    },
    // Lets an IdP login attach to the account that already holds that address
    // rather than failing as unlinked.
    //
    // `trustedProviders` is deliberately not set: the SSO plugin calls
    // handleOAuthUserInfo with `trustProviderByName: false`, so that list is
    // ignored on this path and cannot authorise an SSO link. What does is
    // the IdP's own `email_verified` claim (see `trustEmailVerified` on the
    // plugin below). `requireLocalEmailVerified` is deliberately left at its
    // default: linking needs the address proven at *both* ends, so an
    // unverified local account is never taken over by an IdP claiming it.
    account: {
      accountLinking: { enabled: true },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 3,
      updateAge: 60 * 60 * 24,
      // 0 turns better-auth's freshness check off entirely. Its default is 24
      // hours, and `listSessions` rides `freshSessionMiddleware`, so
      // `GET /users/me/sessions` refused with FORBIDDEN / SESSION_NOT_FRESH for
      // any session older than a day — the state a working session is in almost
      // all of the time. The gate protects nothing here: this is a listing of
      // the caller's own sessions, and its neighbour `revokeSession` rides
      // `sensitiveSessionMiddleware`, which has no freshness check at all, so a
      // stale session could already *end* a session it could not *name*.
      freshAge: 0,
    },
    databaseHooks: {
      // Never an `account` for an Agent — see `refuseAgentUser`.
      account: {
        create: {
          before: async (newAccount, context) => {
            await refuseAgentUser(db, newAccount.userId);
            // An SSO link onto a person who already has an account.
            if (isSsoRequest(context as UserCreateContext)) {
              if (options.instanceMode.isHosted) {
                await refuseUnprovenSsoSignIn(
                  db,
                  newAccount.providerId,
                  await emailOf(db, newAccount.userId),
                );
              }
              await refuseSsoSignInOff(
                options,
                await organizationOfProvider(db, newAccount.providerId),
              );
            }
          },
        },
      },
      user: {
        create: {
          before: async (newUser, context) => {
            // An identity provider is creating this user, not a sign-up form:
            // the closed-instance rule below does not apply to them.
            //
            // On the Hosted instance an SSO provider creates someone only for
            // a domain its Organization has proven, and that person counts as
            // confirmed (ADR-0051): the Organization showed it owns the
            // domain, and its identity provider vouches for the address in it.
            // So no confirmation email is sent (`sendVerificationEmail` skips a
            // confirmed account) and the seven-day sweep leaves them alone.
            //
            // Below Business, in either mode, a provider creates nobody.
            if (isSsoRequest(context)) {
              const providerId = context?.params?.providerId;
              const hosted = options.instanceMode.isHosted;
              if (hosted) {
                await refuseUnprovenSsoSignIn(db, providerId, newUser.email);
              }
              await refuseSsoSignInOff(
                options,
                await organizationOfProvider(db, providerId),
              );
              if (!hosted) return;
              return { data: { ...newUser, emailVerified: true } };
            }
            if (isScimRequest(context)) return;
            const token =
              context?.request?.headers?.get(INVITATION_TOKEN_HEADER) ?? null;
            const hosted = options.instanceMode.isHosted;
            await assertSignUpAllowed(db, hosted, newUser.email, token);
            // Asked here as well as in `after` so a name that will be refused
            // is refused before the user row exists.
            signUpOrganizationName(context?.body);
            // An invite link counts as confirmation on the Hosted instance
            // (ADR-0051): it reached that address, and the token has
            // just been checked against it. So no confirmation email is sent
            // (`sendVerificationEmail` skips a confirmed account) and
            // `startInvitedSession` signs them in. Self-hosted is left as it
            // was: nothing there asks whether an address is confirmed.
            if (hosted && token) {
              return { data: { ...newUser, emailVerified: true } };
            }
          },
          after: async (newUser, context) => {
            // Returns before the bootstrap: a SCIM-provisioned user never owns
            // a new organization — the plugin adds them to the
            // token's organization as a plain member in the same transaction.
            //
            // Defensive rather than load-bearing: the bootstrap below already
            // no-ops once an owner exists, and a
            // SCIM token cannot exist before one does (an owner's session has
            // to generate it, and the row cascades with the organization). Kept
            // so the invariant survives an edit to the bootstrap's own guard;
            // removing it changes no current behaviour, which is why no test
            // pins it.
            if (isScimRequest(context)) return;
            const invited = Boolean(
              context?.request?.headers?.get(INVITATION_TOKEN_HEADER),
            );
            const bootstrapped = await bootstrapDefaultOrganization(
              db,
              options.instanceMode.isHosted,
              newUser.id,
              signUpOrganizationName(context?.body),
              !invited && !isSsoRequest(context),
            );
            // The very first user owns a new organization; anyone else the IdP
            // provisions joins the provider's one.
            if (!bootstrapped && isSsoRequest(context)) {
              await joinProviderOrganization(db, newUser.id, context);
            }
          },
        },
      },
      session: {
        create: {
          // The address better-auth could not resolve, filled from the
          // socket before the row is written.
          //
          // A `before` hook and not an `after` one, which is the opposite of
          // the note below and for a reason that does not conflict with it:
          // that one needs `after` because it *reads* rows the same transaction
          // has not committed yet, and this one reads nothing from the database
          // at all. `before` also lands the value in time for
          // `recordSessionAudit`, which takes `ip` off the created row — an
          // `after` fill would need a second UPDATE and would still write the
          // login entry blank.
          //
          // It is also where an Agent is refused a session by every route at
          // once: see `refuseAgentUser`. First, so a refused sign-in
          // writes nothing.
          before: async (newSession, context) => {
            await refuseAgentUser(db, newSession.userId);
            // Every SSO sign-in, a returning person's included.
            if (isSsoRequest(context as UserCreateContext)) {
              const providerId = (context as UserCreateContext)?.params
                ?.providerId;
              if (options.instanceMode.isHosted) {
                await refuseUnprovenSsoSignIn(
                  db,
                  providerId,
                  await emailOf(db, newSession.userId),
                );
              }
              await refuseSsoSignInOff(
                options,
                await organizationOfProvider(db, providerId),
              );
            }
            const peer = socketPeerFallback(
              (newSession as { ipAddress?: string | null }).ipAddress,
              context?.request,
            );
            if (!peer) return undefined;
            return { data: { ...newSession, ipAddress: peer } };
          },
          // New sessions start in an Organization only when the answer is
          // already known: the membership marked default, or the only one.
          //
          // Several memberships and no default is deliberately left unset
          // and the console asks: sign-in and the 2FA step read the
          // null through `resolveOrganizationDestination`
          // (`frontend/src/lib/auth/active-organization.ts`) and send the
          // person to /select-organization, "Choose an Organization". This used
          // to fall back to the most recently joined one, which answered the
          // question on their behalf — and the Organization is the tenant
          // boundary, so landing in the wrong one silently is the costly
          // mistake. Nothing breaks before the choice: `validateRequest` still
          // resolves a role from the newest membership for a session with no
          // active Organization (`auth.service.ts`), and every console read
          // waits on the session's own id.
          //
          // Runs as an after-hook: create.after hooks are queued
          // post-transaction, so on sign-up this executes after the owner
          // bootstrap above (a before-hook would still see an empty member
          // table).
          after: async (createdSession) => {
            const memberships = await db
              .select({
                organizationId: schema.member.organizationId,
                isDefault: schema.member.isDefault,
              })
              .from(schema.member)
              .where(eq(schema.member.userId, createdSession.userId))
              .orderBy(
                desc(schema.member.isDefault),
                desc(schema.member.createdAt),
              );
            const [first] = memberships;
            if (!first) return;

            // Nothing is audited here when it is left unset: the login is
            // recorded by `update.after` below, against the Organization they
            // choose. Writing it into every Organization they belong to would
            // hand each tenant's admins this session's time and address for
            // work done in another tenant, and pair N logins with the one
            // logout that sign-out records.
            if (!first.isDefault && memberships.length > 1) return;

            await db
              .update(schema.session)
              .set({ activeOrganizationId: first.organizationId })
              .where(eq(schema.session.id, createdSession.id));
            await recordSessionAudit(
              options.auditLogs,
              'login',
              createdSession,
              first.organizationId,
            );
          },
        },
        update: {
          // The login of a session that started in no Organization,
          // recorded when it is put in one for the first time — choosing on
          // /select-organization, the masthead switcher, or accepting an
          // invitation, all of which are `organization.setActiveOrganization`
          // → `updateSession`. `create.after` above records nothing for such
          // a session, so without this its login would be on no trail while
          // its logout is on the chosen one's.
          //
          // "For the first time" is read off the session the endpoint
          // authenticated with, which is the row as it stood before this
          // update: the hook is handed only the updated row. A session that is
          // unset *later* — its Organization deleted, or left — and then put in
          // another one reads as a first time too, and is recorded as a login
          // there; that is the one imprecision, and it names a real entry into
          // that Organization. A refresh of `expiresAt` carries no
          // Organization and returns at once.
          after: async (updatedSession, context) => {
            const now = (
              updatedSession as { activeOrganizationId?: string | null }
            ).activeOrganizationId;
            if (!now) return;
            const before = (
              context?.context as
                | {
                    session?: {
                      session?: {
                        id?: string;
                        activeOrganizationId?: string | null;
                      };
                    } | null;
                  }
                | undefined
            )?.session?.session;
            if (!before || before.id !== updatedSession.id) return;
            if (before.activeOrganizationId) return;
            await recordSessionAudit(
              options.auditLogs,
              'login',
              updatedSession,
              now,
            );
          },
        },
        delete: {
          // Sign-out is audited against the organization the deleted session
          // row carried.
          after: async (deletedSession) => {
            await recordSessionAudit(
              options.auditLogs,
              'logout',
              deletedSession,
              (
                deletedSession as typeof deletedSession & {
                  activeOrganizationId?: string | null;
                }
              ).activeOrganizationId,
            );
          },
        },
      },
    },
    user: {
      modelName: 'user',
      // Only ever reached in-process: `/change-email` is in `disabledPaths`, and
      // `UsersService.updateProfile` calls it on the Hosted instance after its
      // own password check, so the new address is confirmed before it
      // is written. `updateEmailWithoutVerification` stays off.
      changeEmail: { enabled: true },
      fields: {
        name: 'firstName', // better-auth's `name` lives in the firstName column
      },
      additionalFields: {
        role: {
          type: 'string',
          input: false,
        },
        // Person or Agent. Declared so the user on a better-auth
        // session carries it and `isAgentUser` can be asked of that object,
        // and `input: false` so no request can set it: only
        // `AgentsService.create` writes an Agent, straight to the table.
        kind: {
          type: 'string',
          input: false,
        },
        lastName: {
          type: 'string',
          required: false,
          input: true,
          defaultValue: '',
        },
      },
    },
    plugins: [
      // Cloudflare Turnstile on the Hosted public sign-up form; does
      // nothing Self-hosted. An invited sign-up is let through on its
      // invitation token, which `assertSignUpAllowed` checks.
      hostedTurnstile({
        isHosted: () => options.instanceMode.isHosted,
        secretKey: options.turnstile?.secretKey ?? '',
        siteVerifyURL:
          options.turnstile?.siteVerifyURL ?? CLOUDFLARE_SITEVERIFY_URL,
        exempt: (request) => request.headers.has(INVITATION_TOKEN_HEADER),
      }),
      apiKey({
        enableMetadata: true,
        // The plugin's default is 32, under what the console's form and
        // `cloudgate login` (`cloudgate on <hostname>`) send, so a longer name
        // was refused (#25). One ceiling, stated once in `api-schemas`.
        maximumNameLength: PERSONAL_KEY_NAME_MAX_LENGTH,
        // A Cloudgate key is a *service* credential — the documented way to
        // drive a headless instance — and better-auth's per-key rate limit is
        // not shaped for one.
        //
        // Left unset, the plugin defaults to `maxRequests: 10` in a
        // `timeWindow` of 86_400_000 ms, and stamps those two numbers onto the
        // `apikey` row at creation. So every key was born allowed **ten
        // requests a day**, and the eleventh was refused — a live install spent
        // its whole budget inside the first three minutes, on the mint script's
        // own self-verification.
        //
        // Raising the ceiling would not have been enough. The plugin's window
        // resets on an *idle gap*, not on elapsed time: it compares now against
        // `lastRequest`, so a key that is used steadily never re-opens its
        // window and dies at whatever the ceiling is. Any finite `maxRequests`
        // is therefore a countdown for exactly the caller this credential
        // exists for, differing only in how long it takes to run out.
        //
        // `enabled: false` is also the only lever that reaches keys that
        // already exist: it is read from this config on every verification and
        // short-circuits before the row's own `rateLimitEnabled`, so an install
        // already carrying keys stamped `10 / 86_400_000` is healed by
        // deploying this — no `UPDATE apikey` by hand, which is what the live
        // install had to resort to.
        //
        // Nothing is lost that Cloudgate had: the API is not rate-limited on
        // any other credential, and throttling *only* the automation credential
        // is backwards. A real limit belongs in front of the whole API, not on
        // one plugin's rows.
        rateLimit: { enabled: false },
        // One credential across the API.
        //
        // Cloudgate's own guard resolves `x-api-key` itself, so a key already
        // authenticates every Cloudgate route. better-auth knew nothing about
        // it, so every handler that delegates back to `auth.api.*` — the
        // `/users/me/*` key and session routes, the organization and team
        // routes — looked for a session cookie, found none and refused. The
        // same key that got 200 on `/projects` got 401 on `/users/me/api-keys`:
        // a key could not so much as list or rotate itself.
        //
        // This registers the plugin's `before` hook, which resolves an
        // `x-api-key` header to its owner and puts that session on the request
        // context. The delegation then works as it always did for a cookie.
        //
        // It is deliberately *not* a blanket grant. better-auth marks its
        // account-security routes with `sensitiveSessionMiddleware`, which
        // discards the context session and re-reads the cookie store, so
        // password change, 2FA disable and session revocation stay reachable
        // only from an interactive session — which is the line Cloudgate wants
        // anyway, and `UsersService` states it in the refusal rather than
        // letting it read as a bare 401.
        //
        // Key management itself has since joined that line; why is at
        // `disabledPaths` above.
        enableSessionForAPIKeys: true,
      }),
      // Enterprise SSO/OIDC. Provider writes are disabled above and go through
      // SsoService instead.
      //
      // `trustEmailVerified` is deliberate: without it the plugin forces every
      // profile's emailVerified to false, which makes linking to an existing
      // account unreachable by any configuration — see the accountLinking note
      // above. An admin registering a provider is vouching for that IdP over
      // its own domains, so its `email_verified` claim is taken at face value.
      sso({ trustEmailVerified: true }),
      // Enterprise SCIM 2.0 provisioning.
      // Its `/scim/v2/*` surface is the IdP-facing half and stays reachable;
      // the two management writes are disabled above and go through
      // ScimService instead.
      //
      // `linkExistingUsers` is narrowed to the one row a SCIM delete leaves
      // behind, so the same address can be provisioned again — see
      // `reviveScimTombstone` for what DELETE means and why nothing wider links.
      scim({
        linkExistingUsers: { shouldLinkUser: reviveScimTombstone(db) },
      }),
      twoFactor(),
      organization({
        // Teams are optional groupings — an organization works with none,
        // so deleting the last team must be allowed.
        teams: { enabled: true, allowRemovingAllTeams: true },
        // An invitation on a custom role: the plugin cannot resolve one,
        // so `inviteMember` validates it and this swaps it in before the row is
        // written. `invitation-role.ts` carries the argument.
        organizationHooks: {
          beforeCreateInvitation: substituteCustomInvitationRole,
          // An Agent leaves only through `DELETE /agents/:id`.
          beforeRemoveMember: refuseAgentMemberRemoval(db),
        },
        // Without this the invitation row is created and nothing ever reaches
        // the invitee — `sendResetPassword`'s shape a second time.
        //
        // better-auth builds no URL here, unlike `sendResetPassword`: the note
        // on its own option says so, and the invitation id is all it hands over.
        // So the link is assembled from `baseURL` — the origin better-auth is
        // configured to be reached on (BETTER_AUTH_URL) — and the
        // `/accept-invitation/<id>` path the console already serves, which is
        // the same address its invite dialog offers to copy.
        //
        // Omitted when there is no sender *or* no baseURL: with no origin there
        // is no link worth mailing, and an invitation with a broken link is
        // worse than one the operator passes on by hand. Nothing is lost in
        // either case — the row is created regardless, and better-auth runs
        // this hook after writing it, so a send that throws costs the send and
        // not the invitation (it catches and logs, and `POST /invitations` still
        // answers with the row).
        //
        // `invitationExpiresIn` is deliberately left at better-auth's default
        // of 48 hours, which is what the email copy promises.
        ...(options.mail && options.baseURL
          ? {
              sendInvitationEmail: async (data: {
                id: string;
                role: string;
                email: string;
                organization: { name: string };
                inviter: { user: { name: string; email: string } };
              }) => {
                // Named here for the reason on `sendResetPassword` above.
                await sendTransactional(
                  options.mail!,
                  'invitation',
                  data.email,
                  await renderInvitationEmail({
                    organizationName: data.organization.name,
                    inviterName: data.inviter.user.name,
                    inviterEmail: data.inviter.user.email,
                    role: data.role,
                    acceptUrl: new URL(
                      `/accept-invitation/${data.id}`,
                      options.baseURL,
                    ).toString(),
                  }),
                );
              },
            }
          : {}),
      }),
      // `adminRoles: []` is NOT what locks /admin/*, and it was described
      // that way here for long enough that an issue was filed against the wrong
      // mechanism. `hasPermission` (`plugins/admin/has-permission.mjs`) never
      // reads `adminRoles` at all: it checks `adminUserIds` (unset here), then
      // authorizes the caller's own `role` against `defaultRoles`, and
      // `defaultRoles.user` grants nothing. The lock is that every row's `role`
      // is `'user'` — the plugin's default (its `user.create.before` database
      // hook in `plugins/admin/admin.mjs`), the column's default
      // (`auth.schema.ts`), and `input: false` on the additional field above,
      // so no request can set it. `/admin/set-role` needs the very
      // permission it would grant, which closes the catch-22: this build has no
      // in-product path to an account that can call any /admin/* route, and the
      // instance owner's 403 is correct rather than a bug.
      //
      // `adminRoles: []` is load-bearing for exactly one thing —
      // `impersonateUser`'s check on whether the *target* is an admin
      // (`plugins/admin/routes.mjs`) — and it stays because it states out loud
      // that this build has no instance-admin role. Cloudgate authorizes by
      // Organization role and nothing else (ADR-0010).
      //
      // **The ban is not enforced by this plugin's session deletion.** It is
      // enforced where the credential is read (`banInForce`, `ban.ts`), on
      // the api-key path, the cookie path, and — since H-08 — this config's own
      // `hooks.after`, which is the only one of the three that sees the plugin's
      // *own* endpoints. Do not "restore" /admin/* on the theory that the ban
      // needs it.
      //
      // `bannedUserMessage` is the plugin's own refusal of a *new* session, and
      // it is set here because the default was a second sentence for a fact
      // this build already has one of (H-29). Sign-in answered "You have been
      // banned from this application. Please contact support if you believe
      // this is an error." and `/get-session`, on the same surface to the same
      // person seconds later, answered `BANNED_MESSAGE`. `ban.ts` carries the
      // argument for which of the two survived.
      admin({ adminRoles: [], bannedUserMessage: BANNED_MESSAGE }),
      // `cloudgate login`. The person approves at the console's
      // `/device` screen; the CLI's two routes are Cloudgate's own (see
      // `disabledPaths`), and the only client is the CLI.
      deviceAuthorization({
        verificationUri: '/device',
        validateClient: (clientId) => clientId === CLI_CLIENT_ID,
      }),
    ],
  });

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Auth['$Infer']['Session'];

/** better-auth's cookie prefix, and the one `useSecureCookies` puts before it. */
const AUTH_COOKIE_PREFIX = 'better-auth.';
const SECURE_COOKIE_PREFIX = '__Secure-';

/**
 * Expires the session cookies a request carries under the **other** Instance
 * mode's spelling: `__Secure-better-auth.*` on a Self-hosted Instance,
 * `better-auth.*` on the Hosted one.
 *
 * `set-instance-mode` changes the spelling (`useSecureCookies` above), and a
 * browser signed in before the switch keeps the old cookie. better-auth's
 * sign-out clears only its own spelling, while the console's gate
 * (`frontend/src/proxy.ts`, `getSessionCookie`) accepts either, so the
 * dead-session exit signed out and the gate still saw a session: a blank,
 * refreshing console with no way to sign in (#32). Cleared here, on the
 * sign-out that exit makes, with the attributes each spelling was set with,
 * since a browser takes a `__Secure-` cookie, and so its removal, only with
 * `Secure`.
 */
function expireOtherModeCookies(
  ctx: {
    headers?: Headers;
    setCookie: (
      name: string,
      value: string,
      attributes: Record<string, unknown>,
    ) => unknown;
  },
  isHosted: boolean,
): void {
  const header = ctx.headers?.get('cookie') ?? '';
  for (const pair of header.split(';')) {
    const name = pair.split('=')[0]?.trim() ?? '';
    const secure = name.startsWith(
      `${SECURE_COOKIE_PREFIX}${AUTH_COOKIE_PREFIX}`,
    );
    const plain = name.startsWith(AUTH_COOKIE_PREFIX);
    if (isHosted ? !plain : !secure) continue;
    ctx.setCookie(name, '', {
      maxAge: 0,
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure,
    });
  }
}
