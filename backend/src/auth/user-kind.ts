import { eq } from 'drizzle-orm';
import { defaultKeyHasher } from '@better-auth/api-key';
import { APIError } from 'better-auth/api';
import type { DrizzleDB } from '../db/drizzle.module';
import { apikey, user } from './auth.schema';

/**
 * The one question every Agent rule asks of a user row, and the facts an Agent
 * row is made of (ADR-0023).
 *
 * A module of its own for the reason `ban.ts` gives: `auth.config.ts`,
 * `AuthService`, `PermissionService` and the SCIM revival all ask it, and
 * `auth.service.ts` already imports from `auth.config.ts`, so it cannot live in
 * either without the two requiring each other. Writing the test a second time
 * where it was needed is the drift once filed for the ban.
 */

/**
 * The RFC 2606 reserved domain every Agent's address is minted in. `.invalid`
 * can never be delivered to or registered, so no real identity provider can
 * present one of these addresses — which is half of what keeps SCIM from
 * reviving an Agent (`reviveScimTombstone` refuses the other half by kind).
 */
export const AGENT_EMAIL_DOMAIN = 'agents.cloudgate.invalid';

/**
 * An Agent's address: `<agent-id>@agents.cloudgate.invalid`. It exists because
 * `user.email` is `NOT NULL UNIQUE`, never because anything is sent to it, and
 * it is never shown.
 */
export function agentEmail(agentId: string): string {
  return `${agentId}@${AGENT_EMAIL_DOMAIN}`;
}

/**
 * Whether this user is an **Agent** — read from `user.kind`, never from the
 * address or the absence of an `account`.
 *
 * **Fails closed**: anything not declared `'human'` is an Agent, so a row read
 * without the column, or a kind added later, is refused by every rule that
 * asks rather than let through. The three shapes it is asked of all carry the
 * column: the drizzle row, and better-auth's session user, which has it
 * because `auth.config.ts` declares `kind` as an additional field.
 */
export function isAgentUser(row: { kind?: string | null }): boolean {
  return row.kind !== 'human';
}

/**
 * What an Agent is told on every surface but the MCP endpoint, and the code it
 * goes out under — one sentence for REST (`AuthService`) and better-auth's own
 * surface (`refuseAgentSession`), for the reason `ban.ts` keeps one for a ban.
 *
 * 403 and not 401 wherever it is used: the credential is genuine, and a client
 * told 401 would try to re-authenticate with the same key.
 */
export const AGENT_REFUSAL_MESSAGE =
  'An Agent can act only through the MCP endpoint';

export const AGENT_REFUSAL_CODE = 'AGENT_NOT_ALLOWED_HERE';

/**
 * The kind of the user an api key belongs to, read from the raw key — or
 * `null` when no row holds that key.
 *
 * The key is hashed the way the api-key plugin stores it (its exported
 * `defaultKeyHasher`, SHA-256 base64url) and looked up directly, **without**
 * `verifyApiKey`. That is the point: verifying runs the plugin's
 * delete-on-expiry, its usage claim and its expired-key sweep, and a caller
 * asking only "whose key is this" must not touch a row to find out.
 * `refuseAgentSession` asks it on better-auth's surface before the plugin has
 * read the key at all.
 */
export async function apiKeyOwnerKind(
  db: DrizzleDB,
  rawKey: string,
): Promise<'human' | 'agent' | null> {
  const hashed = await defaultKeyHasher(rawKey);
  const [row] = await db
    .select({ kind: user.kind })
    .from(apikey)
    .innerJoin(user, eq(user.id, apikey.referenceId))
    .where(eq(apikey.key, hashed))
    .limit(1);
  return row?.kind ?? null;
}

/**
 * What removing an Agent as a member is told. An Agent is deleted with
 * `DELETE /agents/:id`, which takes its user and keys with it; removing only
 * its member row would leave a user holding live keys that every surface
 * refuses and no screen lists.
 */
export const AGENT_MEMBER_REMOVAL_REFUSAL =
  'An Agent is deleted from the Agents section, not removed as a member';

/**
 * The organization plugin's `beforeRemoveMember` hook: refuses when the member
 * being removed is an Agent.
 *
 * A hook rather than a check in `OrganizationsService.removeMember` because it
 * sits on `auth.api.removeMember` itself, so it holds for any caller of it.
 * better-auth's own `/organization/remove-member` was a second door and is now
 * in `disabledPaths`, so today the hook guards the one door, Cloudgate's
 * `DELETE /organizations/members/:id`; it stays so that reopening the route,
 * or a new in-process caller, cannot bypass it. It runs after the plugin's own
 * permission and Organization checks, so a caller who may not remove the
 * member, or is in another Organization, learns nothing from it. The kind is
 * read from the table, not from the plugin's user object, which is
 * better-auth's shape and is not promised to carry Cloudgate's columns.
 */
export function refuseAgentMemberRemoval(db: DrizzleDB) {
  return ({ member }: { member: { userId: string } }): Promise<void> =>
    refuseIfAgent(db, member.userId, {
      message: AGENT_MEMBER_REMOVAL_REFUSAL,
    });
}

/**
 * Throws better-auth's 403 with `refusal` when `userId` names an Agent — the
 * look-up-then-throw of every hook that keeps an Agent out of a better-auth
 * write. The kind is read from the table. No row is not an Agent: the hooks
 * run where better-auth itself answers for a missing user.
 */
export async function refuseIfAgent(
  db: DrizzleDB,
  userId: string,
  refusal: { code?: string; message: string },
): Promise<void> {
  const [row] = await db
    .select({ kind: user.kind })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (row && isAgentUser(row)) throw new APIError('FORBIDDEN', refusal);
}
