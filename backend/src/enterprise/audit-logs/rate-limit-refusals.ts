import { and, count, eq, gte, inArray, lt, max, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/drizzle.module';
import { AUDIT_REASON, auditLog } from './audit-log.schema';

/**
 * An Agent's 429s, read off the audit trail: the `refused` rows the MCP
 * dispatcher writes with `metadata.reason: 'rate-limit'` (`AUDIT_REASON.rateLimit`),
 * one per 429.
 *
 * Two readers, one predicate: the Agent row's "Rate-limited N times in the
 * last hour" and the loop signal's restart check. Both are single queries on
 * `audit_log_refused_user_created_at_idx` — `(user_id, created_at) WHERE
 * outcome = 'refused'` — which narrows to one Agent's refusals in the window,
 * and the reason is then read in the row. `test/mcp/agent-rate-limited
 * .e2e-spec.ts` holds both queries to that index with `EXPLAIN`.
 *
 * `metadata` is JSON in a `text` column, so the cast is guarded by the outcome
 * inside a `CASE`, the one construct Postgres evaluates in order: a refused row
 * is only ever written by the dispatcher, whose metadata is always JSON, while
 * a `succeeded` row may be anything and must never reach the cast however the
 * planner orders the other conditions.
 */
function rateLimitRefusal(
  users: SQL,
  since: Date,
  before: Date | undefined,
): SQL {
  return and(
    users,
    eq(auditLog.outcome, 'refused'),
    gte(auditLog.createdAt, since),
    before ? lt(auditLog.createdAt, before) : undefined,
    sql`(case when ${auditLog.outcome} = 'refused' then ${auditLog.metadata}::jsonb ->> 'reason' end) = ${AUDIT_REASON.rateLimit}`,
  )!;
}

/**
 * The count query itself, unexecuted — {@link countRateLimited} runs it, and
 * the index check reads its plan.
 */
export function countRateLimitedQuery(
  db: DrizzleDB,
  agentUserIds: string[],
  since: Date,
) {
  return db
    .select({ userId: auditLog.userId, total: count() })
    .from(auditLog)
    .where(
      rateLimitRefusal(
        inArray(auditLog.userId, agentUserIds),
        since,
        undefined,
      ),
    )
    .groupBy(auditLog.userId);
}

/** How many 429s each of these Agents earned since `since`. Absent means none. */
export async function countRateLimited(
  db: DrizzleDB,
  agentUserIds: string[],
  since: Date,
): Promise<Map<string, number>> {
  if (agentUserIds.length === 0) return new Map();
  const rows = await countRateLimitedQuery(db, agentUserIds, since);
  return new Map(
    rows.flatMap((row) =>
      row.userId ? [[row.userId, row.total] as const] : [],
    ),
  );
}

/**
 * The restart check's query itself, unexecuted — {@link lastRateLimited} runs
 * it, and the index check reads its plan.
 */
export function lastRateLimitedQuery(
  db: DrizzleDB,
  agentUserId: string,
  since: Date,
  before: Date,
) {
  return db
    .select({ at: max(auditLog.createdAt) })
    .from(auditLog)
    .where(rateLimitRefusal(eq(auditLog.userId, agentUserId), since, before));
}

/** The latest 429 of one Agent in `[since, before)`, or `null`. */
export async function lastRateLimited(
  db: DrizzleDB,
  agentUserId: string,
  since: Date,
  before: Date,
): Promise<Date | null> {
  const [row] = await lastRateLimitedQuery(db, agentUserId, since, before);
  return row?.at ?? null;
}
