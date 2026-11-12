import { ForbiddenException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { isAgentUser } from '../auth/user-kind';
import type { DrizzleDB } from '../db/drizzle.module';
import { PLATFORM_ACTOR_ROLE } from '../enterprise/audit-logs/platform-actor';
import { member, user } from '../db/schema';
import type { Member } from '../organizations/organizations.schema';
import { AGENT_ROLES, isAgentRole } from './access-control';
import type { AgentRole } from './access-control';
import type { MemberEntitlements } from './permission.service';

/**
 * **The one writer of `member.role`** (ADR-0023).
 *
 * Two rules hold here and nowhere else, and each is what the other half of
 * the Agent design leans on:
 *
 * - **An Agent holds an agent role and nothing else.** Not `owner`, not
 *   `admin` — `checkInstanceAuthority` admits the instance organization's
 *   owners and admins, and on a single-Organization install every
 *   Organization is that one, so "promote the Agent to admin" would hand it
 *   the platform host — not `member`, which restores backups over what it is
 *   granted, and not a custom role, which stops resolving the day a licence
 *   lapses and would erase the agent-only role name.
 * - **A person never holds an agent role.** That is what lets the role an
 *   audit row records say whether its actor was a person or an Agent.
 *
 * Every role write goes through {@link writeMemberRole} or
 * {@link insertAgentMember}: `OrganizationsService.updateMemberRole`, the
 * custom-role rename, and `AgentsService.create`.
 * `test/coding-standards/member-role-writes.spec.ts` is the census that holds
 * that, parsing `src` for every write to the `member` table. better-auth's own
 * role write, `/organization/update-member-role`, is in `disabledPaths`.
 * What this does not cover, and says so: the rows better-auth
 * *creates* (an accepted invitation, an SSO or SCIM join), which carry an
 * invitation's role or a literal `member`. better-auth's own
 * `/organization/invite-member` is closed too, so every invitation is
 * created by `inviteMember`, which has already validated its role — refused
 * `owner`, an agent role and a comma — before an invitation can carry it.
 *
 * **Two layers, deliberately.** `checkInstanceAuthority` refuses an Agent
 * whatever this writer did, so either alone would keep an Agent off the
 * platform host today. This one also keeps the Organization-level owner/admin
 * bypass away from an Agent, which the instance check does not touch.
 */

/** A transaction handed to `db.transaction`'s callback, or the pool itself. */
type Writer =
  DrizzleDB | Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/** `a, b or c`: the agent roles as one phrase, joined by `conjunction`. */
function listOfAgentRoles(conjunction: 'or' | 'and'): string {
  return `${AGENT_ROLES.slice(0, -1).join(', ')} ${conjunction} ${AGENT_ROLES.at(-1)}`;
}

/** Refused: an Agent moved to a role that is not an agent role. */
export const AGENT_ROLE_REFUSAL = `An Agent can hold only the ${listOfAgentRoles('or')} role`;

/** Refused: anyone moved to the platform's audit role. */
export const PLATFORM_ROLE_REFUSAL = `The ${PLATFORM_ACTOR_ROLE} role is the platform's own and no Member can hold it`;

/** Refused: a person moved to an agent role. */
export const PERSON_ROLE_REFUSAL = `The ${listOfAgentRoles('and')} roles are held only by Agents`;

/**
 * Throws unless `role` is one a user of this kind may hold. Exported for the
 * callers that refuse *before* anything is written — an invitation, which
 * better-auth turns into a member row this writer never sees.
 */
export function assertRoleFitsKind(
  holder: { kind?: string | null },
  role: string,
): void {
  // Nobody holds the platform's role, person or Agent: it is what an
  // audit row written with no caller records, so a Member holding it would
  // be indistinguishable from the platform on the trail.
  if (role.split(',').some((part) => part.trim() === PLATFORM_ACTOR_ROLE)) {
    throw new ForbiddenException(PLATFORM_ROLE_REFUSAL);
  }
  if (isAgentUser(holder)) {
    if (!isAgentRole(role)) throw new ForbiddenException(AGENT_ROLE_REFUSAL);
    return;
  }
  if (isAgentRole(role)) throw new ForbiddenException(PERSON_ROLE_REFUSAL);
}

/**
 * Puts every member row `target` selects on `role`, refusing the whole write
 * if any one of them may not hold it. Answers the rows as written.
 *
 * The rows are read with their user's kind first and written by id after, so
 * a refusal changes nothing — the caller wraps it in a transaction only where
 * it has *other* writes that must roll back with it (the custom-role rename).
 * A kind never changes once a user exists, so nothing between the read and the
 * write can make a checked row wrong.
 */
export async function writeMemberRole(
  db: Writer,
  target: SQL | undefined,
  role: string,
): Promise<Member[]> {
  const rows = await db
    .select({ id: member.id, kind: user.kind })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(target);
  for (const row of rows) assertRoleFitsKind(row, role);
  if (rows.length === 0) return [];

  return db
    .update(member)
    .set({ role })
    .where(
      inArray(
        member.id,
        rows.map((row) => row.id),
      ),
    )
    .returning();
}

/**
 * An Agent's one membership, written with its role and its first grant — the
 * row `AgentsService.create` writes in the same transaction as the Agent's
 * user and first key.
 *
 * Here rather than in the service because its role is a `member.role` write,
 * and a second place that writes one is what this module exists to prevent.
 * The role is typed to the agent roles, and `isDefault` is true because it
 * is the only membership the Agent will ever have, which is what
 * `validateApiKey`'s default-membership resolution relies on.
 */
export async function insertAgentMember(
  db: Writer,
  values: {
    userId: string;
    organizationId: string;
    role: AgentRole;
  } & Required<MemberEntitlements>,
): Promise<Member> {
  assertRoleFitsKind({ kind: 'agent' }, values.role);
  const [created] = await db
    .insert(member)
    .values({ ...values, createdAt: new Date(), isDefault: true })
    .returning();
  return created;
}
