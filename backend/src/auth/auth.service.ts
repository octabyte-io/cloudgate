import type { IncomingHttpHeaders } from 'node:http';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { NOT_ORGANIZATION_MEMBER_CODE } from 'api-schemas';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { apikey, member, session as sessionTable, user } from '../db/schema';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { hasInstanceOwner, signUpState } from './sign-up-state';
import type { SignUpState } from './sign-up-state';
import { readInvitationPreview } from './invitation-preview';
import type { InvitationPreview } from './invitation-preview';
import type { Auth, AuthSession } from './auth.config';
import { AUTH } from './auth.constants';
import { banInForce, BANNED_CODE, BANNED_MESSAGE } from './ban';
import {
  AGENT_REFUSAL_CODE,
  AGENT_REFUSAL_MESSAGE,
  isAgentUser,
} from './user-kind';

export interface ValidatedRequest {
  /**
   * Full better-auth session for cookie auth; a synthetic `{ userId }`-only
   * session for api-key auth.
   */
  session: (Partial<AuthSession['session']> & { userId: string }) | null;
  user: AuthSession['user'] | null;
  /**
   * Why a credential that *exists* was turned down, when the reason is worth
   * repeating — either because better-auth named it
   * ({@link NAMED_API_KEY_REFUSALS}) or because the owner's own account earns it
   * ({@link OWNER_REFUSALS}). Absent for an anonymous or unrecognised
   * caller.
   */
  rejection?: CredentialRejection;
  /**
   * How something that outlives this request re-reads the credential later
   * (ADR-0012). Absent for a caller who was not recognised at all — there is no
   * row to point at.
   */
  credential?: CredentialHandle;
  /**
   * The Agent behind a refused Agent credential ({@link AGENT_REFUSAL}),
   * named so the refusal can be an audit row naming it (the Agents spec: an
   * Agent's every call, allowed or refused, is a row). Only ever beside that
   * rejection; a caller this names is refused, never authenticated.
   */
  refusedAgent?: RefusedAgent;
}

/** Who an Agent refusal refused: the Agent, its Organization and its key. */
export interface RefusedAgent {
  userId: string;
  organizationId: string | null;
  /** The key it came with, as an MCP call's row names it; null for a session. */
  key: { id: string; start: string | null } | null;
}

/**
 * A credential named by id rather than held.
 *
 * A WebSocket authorizes for as long as it is open, so it needs to ask "is this
 * caller still who they were" long after its upgrade request is gone. Retaining
 * the request's headers would re-run {@link AuthService.validateRequest}
 * exactly, and it is the shape ADR-0009 already refused one layer up: a
 * credential can only ever be protected negatively, and holding a live cookie in
 * a gateway's closure for the life of a socket creates that obligation on an
 * object that now outlives its request by hours, sits in a heap dump, and would
 * be interpolated into a log line by the first person to debug a renewal
 * failure. This codebase has had precisely that leak once. An id is a
 * name for a row, and names are safe to keep.
 */
export type CredentialHandle =
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'apiKey';
      apiKeyId: string;
      /**
       * The Organization the request named in `x-organization-id`,
       * when it named one. A key so pinned acts there for the life of its
       * socket, whatever its owner's default membership later becomes; an id
       * is as safe to keep as the key's own.
       */
      namedOrganizationId?: string;
    };

/** A refusal the caller can act on: a status and a sentence that says why. */
export interface CredentialRejection {
  /** HTTP status the refusal deserves — 429 for a limit, 401 for a dead key. */
  status: number;
  message: string;
  /** better-auth's own code, e.g. `RATE_LIMITED`. Logged, not published. */
  code: string;
  /**
   * The name this refusal goes out under in the error body, for the refusals a
   * client has to tell apart from every other one of the same status (H-26).
   *
   * Deliberately *not* {@link code}. That one is better-auth's api-key
   * vocabulary and is read by whoever reads the log; this one is a promise to
   * the console, and the two would drift the moment the plugin renamed one of
   * its own codes. `SESSION_BANNED` is the only refusal here that sets it —
   * every other one is fully described by its status, which is why publishing
   * all of them was rejected rather than merely not done: a code the console
   * does not branch on is a contract nobody is holding up.
   *
   * {@link refusalException} is what puts it on the wire, so the three throw
   * sites do not each decide.
   */
  publishedCode?: string;
}

/**
 * A refusal, as the exception the request paths answer with.
 *
 * One function rather than three `new HttpException(…)`s, because H-26 added a
 * second thing a refusal carries and the guard, the socket lease and
 * `assertSessionAlive` were each spelling the first one out on their own —
 * which is how {@link OWNER_REFUSALS.SESSION_BANNED}'s code reached the console
 * on better-auth's surface and not on Cloudgate's own routes.
 *
 * `HttpException` rather than a status-specific subclass, for the reason each
 * of those sites already gave: the status belongs to the refusal, not to the
 * throw site. The object form is what `AllExceptionsFilter` reads a
 * `publishedCode` out of; a refusal without one produces exactly the body it
 * produced before.
 */
export function refusalException(
  rejection: CredentialRejection,
): HttpException {
  return new HttpException(
    {
      message: rejection.message,
      ...(rejection.publishedCode ? { code: rejection.publishedCode } : {}),
    },
    rejection.status,
  );
}

/**
 * The two refusals an api key earns from its *owner's* account rather than from
 * its own row — and the reason both api-key paths have to ask for themselves.
 *
 * better-auth does not check either one on the path Cloudgate verifies a key on.
 * That is not an upstream oversight, it is where the check lives: in
 * `@better-auth/api-key@1.6.33` the ban is asserted inside `/api-key/delete`
 * (`dist/index.mjs:917`), a *session* route reading `ctx.context.session.user`,
 * and the `verify-api-key` region (from `:1622`) throws only `INVALID_API_KEY`,
 * `KEY_NOT_FOUND`, `KEY_DISABLED`, `KEY_EXPIRED`, `USAGE_EXCEEDED` and
 * `RATE_LIMITED`. A key verified from a header carries no session, so there is
 * no user for the plugin to look at.
 *
 * Which is why the banned-key 403 shipped unreachable: `USER_BANNED` was mapped in
 * {@link NAMED_API_KEY_REFUSALS} and nothing could ever put that code into
 * {@link describeApiKeyRefusal}, while `validateApiKey` read `owner.banned` off
 * the row and only *reported* it on the session it built. A banned account
 * therefore answered 200 on every HTTP route indefinitely, at the same time as
 * the ADR-0012 renewal cut its WebSocket inside 30 seconds.
 *
 * @see AuthService.apiKeyOwner — the one place either refusal is decided.
 */
const OWNER_REFUSALS = {
  /**
   * Unreachable while `apikey.reference_id` cascades from `user` — kept because
   * the alternative is a `select` whose empty result silently authorizes.
   */
  GONE: {
    status: 401,
    code: 'OWNER_GONE',
    message: 'The account this API key belongs to is gone',
  },
  BANNED: {
    status: 403,
    code: 'USER_BANNED',
    message: 'The account this API key belongs to is banned',
  },
  /**
   * The same refusal on the path that reads a cookie. Same code, its own
   * sentence: `BANNED` names the *key's* owner and is pinned by
   * `test/auth/api-key-refusal.e2e-spec.ts`, so reusing it for a session would
   * tell a caller their session is an API key.
   *
   * The sentence comes from `ban.ts` since H-08, because a third reader now says
   * it — the refusal `auth.config.ts` raises on better-auth's own session
   * surface, which this service never sees.
   *
   * The one refusal here with a `publishedCode`, and H-26 is why. Every
   * Cloudgate route refuses a banned cookie with this, and the console's
   * `errorMessage()` had one sentence for a 403 — *"Your role in this
   * Organization does not allow this"* — so the person was told to ask an owner
   * for a role change that would fix nothing. It publishes `BANNED_CODE` rather
   * than the `code` beside it because that is the spelling better-auth's own
   * surface already answers with (`ban.ts`), and the console keys on one code
   * for one fact whichever surface refused.
   */
  SESSION_BANNED: {
    status: 403,
    code: 'USER_BANNED',
    publishedCode: BANNED_CODE,
    message: BANNED_MESSAGE,
  },
} as const satisfies Record<string, CredentialRejection>;

/**
 * The refusals worth naming, keyed by better-auth's api-key error code.
 *
 * `verifyApiKey` answers `{ valid: false, error: { code, message } }` for every
 * kind of refusal, and this service used to collapse all of them into the same
 * anonymous result — so a key that was rate-limited, expired or disabled came
 * back as a bare `401 Unauthorized`, indistinguishable from a key that was
 * simply wrong. On the live install that read as "the key is wrong", and the
 * plugin's rate limit was misdiagnosed for a phase because of it.
 *
 * **Only codes that describe a key the caller genuinely holds are listed.**
 * `KEY_NOT_FOUND` and `INVALID_API_KEY` are deliberately absent and stay a
 * bare 401: answering them differently would make the header an oracle for
 * which key strings exist, the same reasoning `UsersService.revokeSession`
 * applies to a session id it declines to name.
 *
 * `RATE_LIMITED` is unreachable while `auth.config.ts` passes
 * `rateLimit: { enabled: false }` to the plugin. It is mapped anyway: it is
 * the refusal the rate-limit bug was actually about, and the mapping is what
 * makes re-enabling a limit safe to do rather than a second silent 401.
 */
const NAMED_API_KEY_REFUSALS: Record<
  string,
  Omit<CredentialRejection, 'code'>
> = {
  RATE_LIMITED: {
    status: 429,
    message: 'API key rate limit exceeded',
  },
  USAGE_EXCEEDED: {
    status: 429,
    message: 'API key has reached its usage limit',
  },
  KEY_EXPIRED: {
    status: 401,
    message: 'API key has expired',
  },
  KEY_DISABLED: {
    status: 401,
    message: 'API key is disabled',
  },
  // Not dead code, and not the branch that produces the 403 either: no
  // `verifyApiKey` refusal can carry this code (see OWNER_REFUSALS), so the ban
  // is caught from the owner's row instead. The mapping stays for the same
  // reason `RATE_LIMITED`'s does — it is what makes the plugin moving the check
  // onto its verify path a version bump rather than a second silent 401 — and it
  // is derived from the single refusal so the two cannot answer differently.
  USER_BANNED: {
    status: OWNER_REFUSALS.BANNED.status,
    message: OWNER_REFUSALS.BANNED.message,
  },
};

const ANONYMOUS: ValidatedRequest = { session: null, user: null };

/**
 * The header a request names its Organization in. Read for a Personal
 * key only: a console session already carries the Organization it acts in,
 * switched through better-auth's `set-active`, and a second way to switch it
 * per request would be a second answer to "where is this cookie acting".
 */
export const ORGANIZATION_HEADER = 'x-organization-id';

/**
 * A Personal key naming, in {@link ORGANIZATION_HEADER}, an Organization its
 * owner is not a member of. A 403, not a 401: the key is genuine and stays
 * usable everywhere its owner is a member. Published with a code because the
 * CLI must tell this apart from a role's refusal, which an owner can fix and
 * this is not — the fix is naming the right Organization.
 *
 * Deliberately the same answer for an id that names no Organization at all,
 * so the header is not an oracle for which Organization ids exist.
 */
function notMemberRefusal(organizationId: string): CredentialRejection {
  return {
    status: 403,
    code: NOT_ORGANIZATION_MEMBER_CODE,
    publishedCode: NOT_ORGANIZATION_MEMBER_CODE,
    message: `The API key's owner is not a member of Organization ${organizationId}`,
  };
}

/** The header's value, when it holds one. */
function namedOrganizationOf(headers: IncomingHttpHeaders): string | undefined {
  const value = headers[ORGANIZATION_HEADER];
  const named = typeof value === 'string' ? value.trim() : '';
  return named.length > 0 ? named : undefined;
}

/**
 * An Agent's credential, on a Cloudgate REST route or socket
 * (ADR-0023). An Agent acts only through the MCP endpoint; every other route
 * refuses it here, whatever its role would have allowed. The sentence and the
 * code are `user-kind.ts`'s, shared with better-auth's own surface.
 */
const AGENT_REFUSAL: CredentialRejection = {
  status: 403,
  code: AGENT_REFUSAL_CODE,
  publishedCode: AGENT_REFUSAL_CODE,
  message: AGENT_REFUSAL_MESSAGE,
};

/**
 * Resolves the caller from the `x-api-key` header first, else from the
 * better-auth session cookie.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * What an uninvited sign-up meets here, asked the way a sign-up screen needs
   * it: Self-hosted, still unclaimed or closed; Hosted, not
   * open yet or open — see `SignUpState`.
   *
   * Without this read the rule lived only in `assertSignUpAllowed`, so
   * `/sign-up` could only find out by submitting the form. Both ask
   * `signUpState` over `hasInstanceOwner`, which is what keeps the answer and
   * the refusal the same question.
   *
   * Note this says nothing about *invited* sign-up, which stays open on a closed
   * instance — the token is what authorises it, and only its holder can ask.
   */
  async signUpState(): Promise<SignUpState> {
    return signUpState(
      this.instanceMode.isHosted,
      await hasInstanceOwner(this.db),
    );
  }

  /** What an invitation link may say before sign-in — see `invitation-preview.ts`. */
  invitationPreview(invitationId: string): Promise<InvitationPreview> {
    return readInvitationPreview(this.db, invitationId);
  }

  /**
   * Who is calling, from the `x-api-key` header or else the session cookie —
   * or why a credential that exists is refused.
   *
   * **An Agent is refused here, on every REST route and socket, in one
   * fail-closed branch** (ADR-0023). It is asked of the caller both
   * paths resolved rather than inside either, so no third credential path
   * can be added beneath it without passing it, and `isAgentUser` refuses
   * anything not declared a person. In practice the caller is always an Agent
   * key: `session.create.before` never lets an Agent hold a session.
   *
   * An Agent key reaching this branch has been through `verifyApiKey`, which
   * stamps the row's `lastRequest` even though the request is then refused.
   * Refusing before verifying would have needed a second branch on the raw
   * key, and a refused REST call is still a use of the key an operator may
   * want to see.
   */
  async validateRequest(
    headers: IncomingHttpHeaders,
  ): Promise<ValidatedRequest> {
    const caller = await this.resolveCredential(headers);
    if (caller.user && isAgentUser(caller.user)) {
      return {
        ...ANONYMOUS,
        rejection: AGENT_REFUSAL,
        refusedAgent: await this.refusedAgentOf(caller.user.id, caller),
      };
    }
    return caller;
  }

  /** The Agent a refusal names, with its key's visible prefix. */
  private async refusedAgentOf(
    userId: string,
    caller: ValidatedRequest,
  ): Promise<RefusedAgent> {
    const handle = caller.credential;
    let key: RefusedAgent['key'] = null;
    if (handle?.kind === 'apiKey') {
      const [row] = await this.db
        .select({ id: apikey.id, start: apikey.start })
        .from(apikey)
        .where(eq(apikey.id, handle.apiKeyId))
        .limit(1);
      key = row ?? null;
    }
    return {
      userId,
      organizationId: caller.session?.activeOrganizationId ?? null,
      key,
    };
  }

  private async resolveCredential(
    headers: IncomingHttpHeaders,
  ): Promise<ValidatedRequest> {
    const apiKeyHeader = headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0) {
      return this.validateApiKey(apiKeyHeader, namedOrganizationOf(headers));
    }

    const session = await this.auth.api.getSession({
      headers: new Headers({ cookie: headers.cookie ?? '' }),
    });

    if (!session?.session || !session.user) {
      return ANONYMOUS;
    }

    // The ban, on the path that reads a cookie. The admin plugin refuses a
    // banned account a *new* session (`admin.mjs:32-49`) and `/admin/ban-user`
    // deletes the ones it has — but that route answers 403 to every account this
    // build can create (see `auth.config.ts`), so the sessions a banned account
    // already holds were the ones nothing checked. A `rejection` rather than
    // `ANONYMOUS`, for the reason `validateApiKey` gives below: the credential is
    // genuine, and a bare 401 would tell the caller their cookie is wrong when
    // their account is. Before `resolveMember`, so a banned caller never gets a
    // role resolved.
    if (banInForce(session.user)) {
      return { ...ANONYMOUS, rejection: OWNER_REFUSALS.SESSION_BANNED };
    }

    // The caller's `role` is their member role in the active organization (not
    // the admin-plugin user.role), and a session without an active
    // organization falls back to the default membership.
    const memberRecord = await this.resolveMember(
      session.user.id,
      session.session.activeOrganizationId,
    );
    session.user.role = memberRecord?.role ?? 'member';
    if (memberRecord) {
      session.session.activeOrganizationId = memberRecord.organizationId;
    }
    return {
      ...session,
      credential: { kind: 'session', sessionId: session.session.id },
    };
  }

  /**
   * Whether a credential someone still holds is alive, read by id (ADR-0012).
   *
   * The sibling of {@link validateRequest}, and here rather than in the realtime
   * module for exactly that reason: "is this credential still alive" now has a
   * second implementation, able to drift from the first if better-auth adds a
   * condition to session validity, and the two are least likely to drift while
   * they sit next to each other. The cost is real and worth naming rather than
   * hiding in a gateway.
   *
   * `organizationId` is the organization the caller was acting in when the
   * credential was read the first time. A session that has since switched
   * organizations is refused rather than quietly re-scoped: whatever it was
   * authorized for was authorized in the organization it has left.
   *
   * Throws rather than answering false, so a caller re-running an authorization
   * treats a dead credential exactly as it treats a withdrawn entitlement.
   */
  async assertCredentialAlive(
    credential: CredentialHandle,
    organizationId: string | null,
  ): Promise<void> {
    if (credential.kind === 'session') {
      await this.assertSessionAlive(credential.sessionId, organizationId);
      return;
    }
    await this.assertApiKeyAlive(
      credential.apiKeyId,
      organizationId,
      credential.namedOrganizationId,
    );
  }

  /**
   * A session row, by id: its absence is revocation, its `expiresAt` is expiry,
   * its owner's ban is a refusal of its own, and its organization is the one
   * vector a permission check cannot see.
   *
   * **The ban used to be delegated and the delegate has no caller.** This
   * docblock said a banned user needed no case of its own, because the admin
   * plugin deletes a banned user's sessions inside `/admin/ban-user`. It does —
   * but no account on this build can reach that route: `hasPermission`
   * (`better-auth/dist/plugins/admin/has-permission.mjs:3-9`) authorizes the
   * caller's `user.role` against `defaultRoles`, `defaultRoles.user` grants
   * nothing, and every row's `role` is `'user'` and cannot be set by a request
   * (`auth.config.ts`'s `input: false`). The plugin does refuse a banned account
   * a *new* session (`admin.mjs:32-49`), so the only unchecked reader was a
   * session the account already held — which is why the ban is asserted here
   * from the columns, via {@link banInForce}, rather than waited for as a
   * revocation that never comes.
   */
  private async assertSessionAlive(
    sessionId: string,
    organizationId: string | null,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.id, sessionId))
      .limit(1);
    if (!row) {
      throw new UnauthorizedException('The session has been revoked');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('The session has expired');
    }
    const [owner] = await this.db
      .select({ banned: user.banned, banExpires: user.banExpires })
      .from(user)
      .where(eq(user.id, row.userId))
      .limit(1);
    // Before the organization test below on purpose: a ban outranks "acting in a
    // different organization", which would otherwise be the sentence a banned
    // caller sees. `owner` absent is deliberately not a refusal — `session
    // .user_id` cascades from `user`, so a missing row means the session row is
    // going too, and the `!row` check above is where that is answered.
    if (owner && banInForce(owner)) {
      // `refusalException` rather than a bare `UnauthorizedException`, for the
      // reason `assertApiKeyAlive` states: the status belongs to the refusal.
      throw refusalException(OWNER_REFUSALS.SESSION_BANNED);
    }
    if ((await this.actingOrganizationOf(row)) !== organizationId) {
      throw new UnauthorizedException(
        'The session is acting in a different organization',
      );
    }
  }

  /**
   * Which organization a session row acts in, resolved the way
   * {@link validateRequest} resolves it.
   *
   * Reading `activeOrganizationId` off the row and comparing it directly would
   * refuse every caller whose session carries none, because `validateRequest`
   * fills that in from the default membership — so the value being compared
   * against was never on the row in the first place. A member row that has since
   * been deleted leaves the column as it stands and lets the entitlement check
   * make the refusal, which is where "removed from the Organization" belongs.
   */
  private async actingOrganizationOf(row: {
    userId: string;
    activeOrganizationId: string | null;
  }): Promise<string | null> {
    const memberRecord = await this.resolveMember(
      row.userId,
      row.activeOrganizationId,
    );
    return memberRecord?.organizationId ?? row.activeOrganizationId ?? null;
  }

  /**
   * An api-key row, by id. `enabled` is the column an operator turns off, and
   * `expiresAt` the one that passes on its own; both are refusals better-auth's
   * `verifyApiKey` would have made from the header, asked here of the row.
   *
   * The owner's account is checked here, and — since the ban fix — on the session path
   * too. The premise this docblock used to give for the asymmetry ("banning
   * deletes sessions but leaves keys enabled") was wrong: the deletion happens
   * inside `/admin/ban-user`, which no account on this build can reach. The
   * conclusion it drew was right and now applies to both paths equally — a
   * credential that outlives its request has to ask about its owner for itself,
   * because nothing is going to come and revoke it. That check is
   * {@link apiKeyOwner}'s and is shared with `validateApiKey` — it used to live
   * here alone, which is exactly how the request path came to let a banned
   * account keep answering 200, and the lesson was the two drifting.
   */
  private async assertApiKeyAlive(
    apiKeyId: string,
    organizationId: string | null,
    namedOrganizationId?: string,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(apikey)
      .where(eq(apikey.id, apiKeyId))
      .limit(1);
    if (!row) {
      throw new UnauthorizedException('The API key has been deleted');
    }
    if (row.enabled === false) {
      throw new UnauthorizedException('The API key is disabled');
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('The API key has expired');
    }

    const { rejection } = await this.apiKeyOwner(row.referenceId);
    if (rejection) {
      // The same refusal the request path answers with, thrown instead of
      // returned. `HttpException` rather than a status-specific subclass
      // for the reason `AuthGuard` uses it: the status belongs to the refusal,
      // not to the throw site. A close frame carries no status anyway — the
      // lease reads only `error.message` — so this is where the two channels
      // legitimately diverge, and nothing else about the decision does. That
      // includes H-26's `publishedCode`, which rides along and is simply not
      // read here; the shared builder is what keeps this site from having to
      // know that.
      throw refusalException(rejection);
    }

    // An api-key session is synthetic and scoped to the owner's default
    // membership, so the organization it acts in is that membership — and a key
    // now resolving to a different one is refused rather than quietly
    // re-scoped.
    //
    // No member row at all is deliberately *not* a refusal here, matching the
    // session path: "removed from the Organization" belongs to the entitlement
    // check, which is the half that knows what was being reached for and can
    // name it. Refusing it here would put "acting in a different organization"
    // in the journal for a caller who is acting in no organization at all, and
    // the journal is the one place ADR-0012 asks the cause to be accurate.
    //
    // A key whose request named its Organization is pinned there, so
    // its owner's default moving elsewhere is not a change of where it acts —
    // refusing it would cut every log stream in a non-default Organization at
    // its first renewal. Its membership there going away is, as above, the
    // entitlement check's to answer.
    if (namedOrganizationId) return;
    const memberRecord = await this.resolveMember(row.referenceId);
    if (memberRecord && memberRecord.organizationId !== organizationId) {
      throw new UnauthorizedException(
        'The API key is acting in a different organization',
      );
    }
  }

  /**
   * The account an api key belongs to, or the refusal that answers for it.
   *
   * One method rather than a check on each path, because the two paths had
   * already drifted and this is the seam they drifted at. The file's own
   * docstring on {@link assertApiKeyAlive} warns that "is this credential still
   * alive" has a second implementation "able to drift from the first"; it
   * had, in the direction that mattered — the socket refused a banned owner and
   * the request reported the flag and let the caller through. Sharing the
   * decision is §1.4's answer to two checks that have to be kept in step, and
   * the callers now differ only in how a refusal is *delivered*.
   *
   * Deliberately owner-side only. Folding the key's own `enabled` and
   * `expiresAt` checks in here too was the larger, tempting fix and is wrong:
   * those two are not drifted — they are one refusal phrased for two channels
   * ("API key is disabled" as better-auth reports it to a request, "The API key
   * is disabled" as the row reads it to a close frame) — and re-deriving them
   * from the row would make {@link validateApiKey} stop believing the
   * `verifyApiKey` it just ran, which is the only thing that knows the *secret*
   * matched.
   *
   * The whole row is selected because {@link validateApiKey} builds its
   * synthetic user from it; the socket path needs one column and pays a
   * negligible width for reading the same row through the same query.
   */
  private async apiKeyOwner(
    referenceId: string,
  ): Promise<
    | { owner: typeof user.$inferSelect; rejection?: never }
    | { owner?: never; rejection: CredentialRejection }
  > {
    const [owner] = await this.db
      .select()
      .from(user)
      .where(eq(user.id, referenceId))
      .limit(1);
    if (!owner) return { rejection: OWNER_REFUSALS.GONE };
    // `banInForce` rather than `owner.banned`: nothing in Cloudgate
    // read `banExpires`, and the only code that clears an elapsed ban is the
    // admin plugin's `session.create.before` hook — so a 24-hour ban on an
    // account that then never signs in refused its api keys for ever.
    if (banInForce(owner)) return { rejection: OWNER_REFUSALS.BANNED };
    return { owner };
  }

  private async resolveMember(
    userId: string,
    activeOrganizationId?: string | null,
  ) {
    const [memberRecord] = await this.db
      .select()
      .from(member)
      .where(
        and(
          eq(member.userId, userId),
          ...(activeOrganizationId
            ? [eq(member.organizationId, activeOrganizationId)]
            : []),
        ),
      )
      .orderBy(desc(member.isDefault), desc(member.createdAt))
      .limit(1);
    return memberRecord;
  }

  /**
   * A Personal key, verified, and the Organization it acts in: the one the
   * request named in {@link ORGANIZATION_HEADER} when it is a member there,
   * else its owner's default membership. Naming one it is not a member
   * of is refused rather than quietly falling back, so a CLI pointed at the
   * wrong Organization never acts in another.
   */
  private async validateApiKey(
    rawKey: string,
    namedOrganizationId?: string,
  ): Promise<ValidatedRequest> {
    try {
      const { valid, key, error } = await this.auth.api.verifyApiKey({
        body: { key: rawKey },
      });
      if (!valid || !key) {
        const rejection = describeApiKeyRefusal(error);
        return rejection ? { ...ANONYMOUS, rejection } : ANONYMOUS;
      }

      const [keyRecord] = await this.db
        .select()
        .from(apikey)
        .where(eq(apikey.id, key.id))
        .limit(1);
      if (!keyRecord) {
        return ANONYMOUS;
      }

      // The half `verifyApiKey` cannot answer: the key is genuine, and its owner
      // may still be refused on their own account. Answered as a
      // `rejection` rather than as `ANONYMOUS` because the caller has already
      // proved they hold this key — the enumeration argument in
      // NAMED_API_KEY_REFUSALS is about key strings nobody holds, and it does
      // not reach a verified one.
      const ownerRow = await this.apiKeyOwner(keyRecord.referenceId);
      if (ownerRow.rejection) {
        return { ...ANONYMOUS, rejection: ownerRow.rejection };
      }
      const owner = ownerRow.owner;

      // Api-key sessions are synthetic: scope them to the Organization the
      // request named, else the key owner's default one, and carry the member
      // role there, like cookie sessions.
      const memberRecord = await this.resolveMember(
        owner.id,
        namedOrganizationId,
      );
      if (namedOrganizationId && !memberRecord) {
        return {
          ...ANONYMOUS,
          rejection: notMemberRefusal(namedOrganizationId),
        };
      }
      return {
        credential: {
          kind: 'apiKey',
          apiKeyId: keyRecord.id,
          ...(namedOrganizationId ? { namedOrganizationId } : {}),
        },
        session: {
          userId: owner.id,
          activeOrganizationId: memberRecord?.organizationId,
        },
        user: {
          id: owner.id,
          name: owner.firstName, // firstName column carries better-auth's `name`
          lastName: owner.lastName,
          email: owner.email,
          emailVerified: owner.emailVerified,
          image: owner.image,
          createdAt: owner.createdAt,
          updatedAt: owner.updatedAt,
          twoFactorEnabled: owner.twoFactorEnabled,
          role: memberRecord?.role ?? 'member',
          kind: owner.kind,
          banned: owner.banned,
          banReason: owner.banReason,
          banExpires: owner.banExpires,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error verifying API key: ${message}`);
      return ANONYMOUS;
    }
  }
}

/**
 * Reads better-auth's `verifyApiKey` refusal and, when it is one of the codes
 * worth repeating, turns it into a refusal the caller can act on.
 *
 * Returns `undefined` — leaving the caller anonymous and the answer a bare 401
 * — for everything else, including an unrecognised key. See
 * {@link NAMED_API_KEY_REFUSALS} for why that asymmetry is deliberate.
 */
function describeApiKeyRefusal(
  error: { code?: string | null; details?: unknown } | null | undefined,
): CredentialRejection | undefined {
  const code = error?.code;
  const named = code ? NAMED_API_KEY_REFUSALS[code] : undefined;
  if (!code || !named) return undefined;

  // `RATE_LIMITED` carries `details.tryAgainIn` in milliseconds. Saying when
  // the key works again is the difference between a wall and an instruction.
  const details = error?.details;
  const tryAgainIn =
    details && typeof details === 'object'
      ? (details as { tryAgainIn?: unknown }).tryAgainIn
      : undefined;
  const seconds =
    typeof tryAgainIn === 'number' && tryAgainIn > 0
      ? Math.ceil(tryAgainIn / 1000)
      : undefined;

  return {
    ...named,
    code,
    message: seconds
      ? `${named.message}. Try again in ${seconds} seconds.`
      : named.message,
  };
}
