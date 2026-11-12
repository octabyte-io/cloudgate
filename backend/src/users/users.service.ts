import type { IncomingHttpHeaders } from 'node:http';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Whoami } from 'api-schemas';
import { and, eq, ne } from 'drizzle-orm';
import { callAuthApi, toWebHeaders } from '../auth/auth-api.util';
import type { Auth } from '../auth/auth.config';
import type { CredentialHandle } from '../auth/auth.service';
import { AUTH } from '../auth/auth.constants';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { apikey, organization, session, user } from '../db/schema';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import type { CreateApiKeyDto } from './dto/create-api-key.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import { normalizeEmail } from './user-email';
import { toSessionSummary } from './users.types';
import type { SessionSummary } from './users.types';

/**
 * Where a confirmed change of email lands: the console's Account
 * settings, which then show the new address. A path, so better-auth's origin
 * check on `/verify-email`'s `callbackURL` passes and the redirect stays on
 * the origin the link was opened on.
 */
export const EMAIL_CHANGE_CONFIRMED_PATH = '/settings/account';

/** A better-auth API result plus the response headers to forward (Set-Cookie). */
export interface AuthApiResult<T> {
  headers: Headers;
  response: T;
}

/**
 * Refuses an `x-api-key` caller on a route that only an interactive session can
 * answer, and says so.
 *
 * Most of `/users/me/*` works under a key now: `auth.config.ts` registers the
 * api-key plugin's session hook, so the delegations below resolve the key's
 * owner exactly as they resolve a cookie. Three of these routes still cannot,
 * and not by omission — better-auth guards its account-security endpoints with
 * `sensitiveSessionMiddleware`, which throws away whatever session the request
 * context carries and re-reads the cookie store, precisely so that a
 * non-interactive credential cannot disable 2FA or end a session. A key has no
 * cookie, so those endpoints answer `401 Unauthorized`.
 *
 * Cloudgate agrees with the rule and only disagrees with how it arrived: an
 * unexplained 401 on `/users/me/2fa/disable` from a key that gets 200 on
 * `/users/me/sessions` reads as a broken route. So the refusal is stated here,
 * before the delegation, as a 403 that names the credential and the reason —
 * the difference between "this is not allowed" and "something is wrong".
 *
 * Changing the sign-in email is refused here too, and it is the one
 * route on this list that better-auth would *not* have refused on its own: the
 * write is Cloudgate's (`updateProfile`), so the rule is applied rather than
 * explained. The reason is better-auth's, restated — the address is where a
 * password reset goes, so a credential kept away from "disable 2FA" must not be
 * able to rewrite it either.
 *
 * Creating, listing and deleting personal keys is refused here as well,
 * for a reason of Cloudgate's own, stated at `createAuth`'s `disabledPaths`.
 *
 * The test mirrors `AuthService.validateRequest`'s own precedence: the key
 * header is what that guard resolved the caller from, so its presence is what
 * decides, cookie or no cookie.
 */
function assertInteractiveSession(
  headers: IncomingHttpHeaders,
  operation: string,
): void {
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    throw new ForbiddenException(
      `${operation} requires an interactive session. A personal key cannot be ` +
        'used on this route; sign in and retry with the session cookie.',
    );
  }
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly auditLogs: AuditLogService,
    private readonly instanceMode: InstanceMode,
  ) {}

  async getProfile(userId: string) {
    const [profile] = await this.db
      .select()
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!profile) throw new NotFoundException('User not found');
    return profile;
  }

  /**
   * Who a request is made as, where, and with what: the caller's
   * email, the Organization the request acts in, and the Personal key it was
   * made with. Any signed-in caller may ask, about themselves only.
   *
   * **Only the calling key, and that is why a key may ask.** Listing keys is
   * refused to a key ({@link assertInteractiveSession}) because a key
   * that can see its siblings can outlive their revocation; this reads the one
   * row the guard already resolved the caller by, so it tells the holder
   * nothing they do not hold. It exists because `cloudgate whoami` has to say
   * when its key ends, and nothing else answered that for a key.
   *
   * Rejected: adding the key to `GET /users/me`. That route is the user row,
   * which the console reads as a profile; a credential is not a profile field,
   * and a key-shaped hole in the profile would be one more place a future
   * change could start leaking key columns.
   */
  async whoami(
    email: string,
    organizationId: string | null | undefined,
    credential: CredentialHandle | undefined,
  ): Promise<Whoami> {
    const [inUse] = organizationId
      ? await this.db
          .select({ id: organization.id, name: organization.name })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .limit(1)
      : [];
    const [key] =
      credential?.kind === 'apiKey'
        ? await this.db
            .select({
              id: apikey.id,
              name: apikey.name,
              start: apikey.start,
              expiresAt: apikey.expiresAt,
            })
            .from(apikey)
            .where(eq(apikey.id, credential.apiKeyId))
            .limit(1)
        : [];
    return {
      email,
      organization: inUse ?? null,
      key: key
        ? {
            id: key.id,
            name: key.name,
            start: key.start,
            expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
          }
        : null,
    };
  }

  /**
   * The profile columns, and the sign-in email with them.
   *
   * **The email is not a cosmetic column**. It is what the account signs
   * in with and where a password reset is sent, so rewriting it is the same
   * class of act as disabling 2FA and is guarded the same way: an API key is
   * refused by {@link assertInteractiveSession}, and a session has to present
   * the current password, checked by better-auth's own `verifyPassword` exactly
   * as `2fa/enable` and `2fa/disable` check theirs. The name and avatar stay
   * open to a key — a service credential renaming its owner is not an account
   * takeover.
   *
   * "Changes" is measured against the stored row after {@link normalizeEmail},
   * so a client that sends the whole form back — the address included, in any
   * case — is not asked for a password it is not using. A legacy row stored in
   * mixed case is the exception, and correctly so: re-saving it lower-cased
   * *is* a change to what the account signs in with.
   *
   * Self-hosted, the column is written at once: better-auth's `changeEmail`
   * flow verifies by mailing the new address, which a Self-hosted instance may
   * have no sender for, and the password check is the re-authentication that
   * works on every install. On the Hosted instance the password check still
   * comes first, and then `changeEmail` mails the new address and writes it
   * only once that link is followed — the reply carries it as
   * `pendingEmail` meanwhile.
   */
  async updateProfile(
    headers: IncomingHttpHeaders,
    userId: string,
    data: UpdateProfileDto,
    actor?: { organizationId?: string | null; ip?: string },
  ) {
    const current = await this.getProfile(userId);
    const email =
      data.email === undefined ? undefined : normalizeEmail(data.email);

    const changing = email !== undefined && email !== current.email;
    if (changing) {
      await this.assertMayChangeEmail(
        headers,
        userId,
        email,
        data.currentPassword,
      );
    }

    // On the Hosted instance the new address has to be confirmed before it is
    // the one the account signs in with (ADR-0051): better-auth's
    // `changeEmail` mails a link to it, and its `/verify-email` writes the
    // address only when that link is followed. So the column is left alone
    // here, and the reply names the address that is waiting.
    const pendingEmail =
      changing && this.instanceMode.isHosted ? email : undefined;
    const storedEmail =
      data.email === undefined || pendingEmail
        ? undefined
        : normalizeEmail(data.email);
    if (pendingEmail) {
      await callAuthApi(() =>
        this.auth.api.changeEmail({
          body: {
            newEmail: pendingEmail,
            callbackURL: EMAIL_CHANGE_CONFIRMED_PATH,
          },
          headers: toWebHeaders(headers),
        }),
      );
    }

    const [updated] = await this.db
      .update(user)
      .set({
        firstName: data.firstName,
        lastName: data.lastName,
        image: data.image,
        email: storedEmail,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId))
      .returning();
    if (!updated) throw new NotFoundException('User not found');

    await this.auditLogs.audit(
      { userId, organizationId: actor?.organizationId, ip: actor?.ip },
      {
        action: 'update',
        resourceType: 'user',
        resourceId: userId,
        resourceName: updated.email,
      },
    );
    return pendingEmail ? { ...updated, pendingEmail } : updated;
  }

  /**
   * Everything an email change has to clear before the row is written,
   * in the order that answers each caller with its own reason: a key is told it
   * is the wrong credential before anything asks it for a password.
   *
   * The collision check is last, behind the password, so the route only says
   * "another account has that address" to somebody who has just proved who
   * they are. It is a real answer rather than the unique constraint's 500, and
   * it is now reachable in a way it was not: a case variant of another
   * account's address used to be stored as a second, unreachable row.
   */
  private async assertMayChangeEmail(
    headers: IncomingHttpHeaders,
    userId: string,
    email: string,
    password: string | undefined,
  ): Promise<void> {
    assertInteractiveSession(headers, 'Changing the sign-in email');
    if (!password) {
      throw new BadRequestException(
        'Changing the sign-in email needs your current password. Send it as ' +
          'currentPassword',
      );
    }
    await callAuthApi(() =>
      this.auth.api.verifyPassword({
        body: { password },
        headers: toWebHeaders(headers),
      }),
    );

    const [holder] = await this.db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.email, email), ne(user.id, userId)))
      .limit(1);
    if (holder) {
      throw new ConflictException(
        'Another account already signs in with that email address',
      );
    }
  }

  enableTwoFactor(headers: IncomingHttpHeaders, password: string) {
    assertInteractiveSession(headers, 'Enabling two-factor authentication');
    return callAuthApi(() =>
      this.auth.api.enableTwoFactor({
        body: { password },
        headers: toWebHeaders(headers),
        returnHeaders: true,
      }),
    );
  }

  verifyTwoFactor(headers: IncomingHttpHeaders, code: string) {
    assertInteractiveSession(headers, 'Verifying a two-factor code');
    return callAuthApi(() =>
      this.auth.api.verifyTOTP({
        body: { code },
        headers: toWebHeaders(headers),
        returnHeaders: true,
      }),
    );
  }

  disableTwoFactor(headers: IncomingHttpHeaders, password: string) {
    assertInteractiveSession(headers, 'Disabling two-factor authentication');
    return callAuthApi(() =>
      this.auth.api.disableTwoFactor({
        body: { password },
        headers: toWebHeaders(headers),
        returnHeaders: true,
      }),
    );
  }

  /**
   * The caller's own sessions, projected onto `SessionSummary` (ADR-0009).
   *
   * better-auth still decides *which* rows the caller may see — this is not a
   * hand-rolled query over the `session` table, so ADR-0001's reuse holds and
   * the freshness middleware, impersonation rules and cookie handling stay
   * upstream's. What changed is the projection: the raw rows carry `token`, and
   * publishing that made the listing a credential dump for every other machine
   * the account was signed in on.
   */
  async listSessions(headers: IncomingHttpHeaders): Promise<SessionSummary[]> {
    const sessions = await callAuthApi(() =>
      this.auth.api.listSessions({ headers: toWebHeaders(headers) }),
    );
    return sessions.map(toSessionSummary);
  }

  /**
   * Ends one of the caller's sessions, named by its id (ADR-0009).
   *
   * The id is resolved to its token here, scoped to `userId`, so the credential
   * never leaves the server. **A row that is not the caller's and a row that
   * does not exist are the same single miss** — one `.where()` cannot tell them
   * apart, and that is deliberate rather than incidental: answering them
   * differently would make this route an oracle for whether a session id
   * exists. It is the same reasoning ADR-0007 applies to the deployment-log
   * socket's one close code and ADR-0008 to the container sockets', restated on
   * HTTP as the 404 that §2.2 already uses for a row in another tenant.
   *
   * The 404 is also what makes the answer *true*. better-auth's own
   * `revokeSession` guards its delete on ownership and then returns
   * `{ status: true }` either way, so a token it declined to touch comes back as
   * a success — the console would report a session revoked that is still live.
   *
   * The revoke itself still goes through better-auth rather than a `delete` on
   * the table: `databaseHooks.session.delete.after` in `auth.config.ts` is what
   * writes the logout entry to the audit trail, and a direct drizzle delete
   * would bypass it silently.
   */
  async revokeSession(
    headers: IncomingHttpHeaders,
    sessionId: string,
    userId: string,
  ) {
    assertInteractiveSession(headers, 'Revoking a session');

    const [target] = await this.db
      .select({ token: session.token })
      .from(session)
      .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
      .limit(1);
    if (!target) throw new NotFoundException('Session not found');

    return callAuthApi(() =>
      this.auth.api.revokeSession({
        body: { token: target.token },
        headers: toWebHeaders(headers),
      }),
    );
  }

  async createApiKey(
    headers: IncomingHttpHeaders,
    data: CreateApiKeyDto,
    actor: { userId: string; organizationId?: string | null; ip?: string },
  ) {
    assertInteractiveSession(headers, 'Creating a personal key');
    const created = await callAuthApi(() =>
      this.auth.api.createApiKey({
        body: data,
        headers: toWebHeaders(headers),
      }),
    );

    await this.auditLogs.audit(
      {
        userId: actor.userId,
        organizationId: actor.organizationId,
        ip: actor.ip,
      },
      {
        action: 'create',
        resourceType: 'user',
        resourceId: created.id,
        resourceName: data.name,
      },
    );
    return created;
  }

  listApiKeys(headers: IncomingHttpHeaders) {
    assertInteractiveSession(headers, 'Listing personal keys');
    return callAuthApi(() =>
      this.auth.api.listApiKeys({ headers: toWebHeaders(headers) }),
    );
  }

  async deleteApiKey(
    headers: IncomingHttpHeaders,
    keyId: string,
    actor: { userId: string; organizationId?: string | null; ip?: string },
    credential: CredentialHandle | undefined,
  ) {
    // The one exception to the interactive-session rule: a key may
    // delete itself, which is what `cloudgate logout` does with the only
    // credential it holds. It cannot delete a sibling — that is the rotation
    // hole that was closed — and the id compared is the row the guard resolved
    // the caller by, never anything the request says about itself.
    const deletesItself =
      credential?.kind === 'apiKey' && credential.apiKeyId === keyId;
    if (!deletesItself) {
      assertInteractiveSession(headers, 'Deleting a personal key');
    }
    // The key's name is read before deleting it, so the entry names the key
    // rather than only its id.
    const [target] = await this.db
      .select({ name: apikey.name })
      .from(apikey)
      .where(eq(apikey.id, keyId))
      .limit(1);

    const result = await callAuthApi(() =>
      this.auth.api.deleteApiKey({
        body: { keyId },
        headers: toWebHeaders(headers),
      }),
    );

    await this.auditLogs.audit(
      {
        userId: actor.userId,
        organizationId: actor.organizationId,
        ip: actor.ip,
      },
      {
        action: 'delete',
        resourceType: 'user',
        resourceId: keyId,
        resourceName: target?.name ?? undefined,
      },
    );
    return result;
  }
}
