import { and, asc, eq, inArray } from 'drizzle-orm';
import { banInForce } from '../auth/ban';
import { user } from '../auth/auth.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { auditLog } from '../enterprise/audit-logs/audit-log.schema';
import { member } from '../organizations/organizations.schema';
import { requesterIdOf } from './requester';

/**
 * The fact a Previews row reads that is not a column of the preview:
 * who asked for a Requested preview, read for a whole list at once and joined
 * onto the rows in memory. The row's other fact, its newest build, is every
 * read's (`PreviewDeploymentsService.latestBuildsOf`), not this file's.
 */

/**
 * Where a requester stands in the Organization now. `removed` covers every way
 * of leaving: the member row deleted (a person removed, an Agent deleted) and
 * the user deleted with it, which leaves no id to look up at all.
 * `suspended` is a ban in force, read with the predicate sign-in refuses on,
 * so a lapsed ban reads `member`; it is the ban an Agent's Suspend writes and
 * the one a person's deactivation writes alike.
 */
export type RequesterStanding = 'member' | 'removed' | 'suspended';

/**
 * Who asked for a Requested preview, **named by its create audit row**:
 * the row denormalizes the actor's name when it is written, so the
 * name survives the requester being removed, where `preview.requesterId` and
 * the user row do not. `name` is null only where no create row exists.
 */
export interface RequestedBy {
  id: string | null;
  name: string | null;
  standing: RequesterStanding;
}

type Ban = { banned: boolean | null; banExpires: Date | null };

export function requesterStanding({
  member: row,
}: {
  member: Ban | null;
}): RequesterStanding {
  if (row === null) return 'removed';
  return banInForce(row) ? 'suspended' : 'member';
}

type CreateRow = {
  userName: string | null;
  userId: string | null;
  metadata: string | null;
};

/**
 * One preview's requester from its create row, its own column, and the
 * member rows of the ids involved. The id is `requesterIdOf`'s, the same
 * resolution the expiry sweep's platform row names its requester by.
 */
export function requestedByFrom(
  created: CreateRow | null,
  requesterId: string | null,
  members: ReadonlyMap<string, Ban>,
): RequestedBy {
  const id = requesterIdOf(created, requesterId);
  return {
    id,
    name: created?.userName ?? null,
    standing: requesterStanding({
      member: id === null ? null : (members.get(id) ?? null),
    }),
  };
}

/**
 * Every Requested preview's {@link RequestedBy}, by preview id. A pull-request
 * preview has no requester and is not in the answer.
 */
export async function requestedByOf(
  db: DrizzleDB,
  organizationId: string,
  previews: readonly {
    previewDeploymentId: string;
    trigger: string;
    requesterId: string | null;
  }[],
): Promise<Map<string, RequestedBy>> {
  const requested = previews.filter((row) => row.trigger === 'requested');
  const answer = new Map<string, RequestedBy>();
  if (requested.length === 0) return answer;

  const rows = await db
    .select({
      previewDeploymentId: auditLog.resourceId,
      userName: auditLog.userName,
      userId: auditLog.userId,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.organizationId, organizationId),
        eq(auditLog.action, 'create'),
        eq(auditLog.resourceType, 'previewDeployment'),
        inArray(
          auditLog.resourceId,
          requested.map((row) => row.previewDeploymentId),
        ),
      ),
    )
    .orderBy(asc(auditLog.createdAt));
  // The earliest wins, though a preview only ever has one: a refused create
  // (the cap row) carries no resourceId, so it is never among these.
  const created = new Map<string, CreateRow>();
  for (const row of rows) {
    if (row.previewDeploymentId === null) continue;
    if (!created.has(row.previewDeploymentId)) {
      created.set(row.previewDeploymentId, row);
    }
  }

  const ids = [
    ...new Set(
      // Only the id each row resolves to is ever looked up.
      requested.flatMap((row) => {
        const id = requesterIdOf(
          created.get(row.previewDeploymentId) ?? null,
          row.requesterId,
        );
        return id === null ? [] : [id];
      }),
    ),
  ];
  const members = new Map<string, Ban>();
  if (ids.length > 0) {
    const found = await db
      .select({
        userId: member.userId,
        banned: user.banned,
        banExpires: user.banExpires,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        and(
          eq(member.organizationId, organizationId),
          inArray(member.userId, ids),
        ),
      );
    for (const row of found) members.set(row.userId, row);
  }

  for (const row of requested) {
    answer.set(
      row.previewDeploymentId,
      requestedByFrom(
        created.get(row.previewDeploymentId) ?? null,
        row.requesterId,
        members,
      ),
    );
  }
  return answer;
}
