import { and, asc, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { aiUsage } from '../gateway/ai-usage.schema';
import { aiUsageDaily } from './ai-usage-daily.schema';
import type { SpendFigures, TokenSpend } from './dto/token-spend.dto';

/**
 * How long a raw usage row is kept: a fixed constant, as
 * `DEPLOYMENT_LOG_RETENTION_DAYS` is, not a setting. Past it, a day is only
 * its rollups.
 */
export const USAGE_RAW_RETENTION_DAYS = 90;

/** Where the Token spend job and read take "now" from; a test replaces it. */
export const TOKEN_SPEND_CLOCK = 'TOKEN_SPEND_CLOCK';
export type TokenSpendClock = () => Date;
export const systemTokenSpendClock: TokenSpendClock = () => new Date();

const DAY_MS = 24 * 60 * 60 * 1000;

/** The database, or a transaction on it. */
type Db = DrizzleDB | Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/** The UTC day `at` falls on, `YYYY-MM-DD`: how a raw row's day is read. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `day` moved by `days` whole days, `YYYY-MM-DD` in and out. */
export function addDays(day: string, days: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS));
}

/**
 * The first instant a raw row is kept at, given `now`: the start of the UTC
 * day {@link USAGE_RAW_RETENTION_DAYS} before today. Day-aligned, so every day
 * the raw rows still cover, they cover whole, and a rollup recomputed from
 * them is never a partial day.
 */
export function rawRetentionCutoff(now: Date): string {
  return `${addDays(utcDay(now), -USAGE_RAW_RETENTION_DAYS)}T00:00:00.000Z`;
}

/** One day × credential × model served on one AI model, summed. */
export interface SpendRow {
  applicationId: string;
  day: string;
  apikeyId: string;
  agentUserId: string | null;
  agentName: string;
  /** The Agent's id, kept as text past its removal: what a read sums by. */
  agentId: string;
  model: string;
  promptTokensReported: number;
  promptTokensEstimated: number;
  completionTokensReported: number;
  completionTokensEstimated: number;
  callsOk: number;
  callsRuntimeError: number;
  callsClientAborted: number;
  callsRefused: number;
}

/** A raw row's UTC day: its ISO `startedAt` up to the `T`. */
const RAW_DAY = sql<string>`substr(${aiUsage.startedAt}, 1, 10)`;

/**
 * Raw rows summed to rollup grain. The Agent's id and name are the latest
 * call's, so a renamed Agent reads by its current name; once it is removed
 * its id is null on every row and its last name is kept.
 */
function aggregateRaw(db: Db) {
  const tokens = (count: SQLWrapper, flag: SQLWrapper, estimated: boolean) =>
    sql<number>`coalesce(sum(${count}) filter (where ${flag} = ${estimated}), 0)`.mapWith(
      Number,
    );
  const calls = (outcome: string) =>
    sql<number>`count(*) filter (where ${aiUsage.outcome} = ${outcome})`.mapWith(
      Number,
    );
  return db
    .select({
      applicationId: aiUsage.applicationId,
      day: RAW_DAY,
      apikeyId: aiUsage.apikeyId,
      agentUserId: sql<
        string | null
      >`(array_agg(${aiUsage.agentUserId} order by ${aiUsage.startedAt} desc))[1]`,
      agentName: sql<string>`(array_agg(${aiUsage.agentName} order by ${aiUsage.startedAt} desc))[1]`,
      // One key is one Agent's for life, so every row of a group agrees.
      agentId: sql<string>`min(${aiUsage.agentId})`,
      model: aiUsage.model,
      promptTokensReported: tokens(
        aiUsage.promptTokens,
        aiUsage.promptTokensEstimated,
        false,
      ),
      promptTokensEstimated: tokens(
        aiUsage.promptTokens,
        aiUsage.promptTokensEstimated,
        true,
      ),
      completionTokensReported: tokens(
        aiUsage.completionTokens,
        aiUsage.completionTokensEstimated,
        false,
      ),
      completionTokensEstimated: tokens(
        aiUsage.completionTokens,
        aiUsage.completionTokensEstimated,
        true,
      ),
      callsOk: calls('ok'),
      callsRuntimeError: calls('runtime-error'),
      callsClientAborted: calls('client-aborted'),
      callsRefused: calls('refused'),
    })
    .from(aiUsage);
}

const GROUP = [aiUsage.applicationId, RAW_DAY, aiUsage.apikeyId, aiUsage.model];

/** Rollups written per statement; a night's work can be every day × key. */
const UPSERT_BATCH = 500;

/**
 * Sums every raw row that started before `beforeDay` into its day's rollup,
 * replacing what the rollup held.
 *
 * **Recomputed rather than added to**, so a run is idempotent and a row that
 * settled after its day was first rolled (a long stream across midnight) is
 * counted on the next night. That is only sound while the raw rows cover each
 * day they touch whole, which {@link rawRetentionCutoff} keeps true: the prune
 * removes whole days, and only after this has run in the same transaction.
 */
export async function rollUpRawDays(
  db: Db,
  beforeDay: string,
): Promise<number> {
  const rows: SpendRow[] = await aggregateRaw(db)
    .where(lt(aiUsage.startedAt, beforeDay))
    .groupBy(...GROUP);
  for (let at = 0; at < rows.length; at += UPSERT_BATCH) {
    await db
      .insert(aiUsageDaily)
      .values(rows.slice(at, at + UPSERT_BATCH))
      .onConflictDoUpdate({
        target: [
          aiUsageDaily.applicationId,
          aiUsageDaily.day,
          aiUsageDaily.apikeyId,
          aiUsageDaily.model,
        ],
        set: {
          agentUserId: sql`excluded.agent_user_id`,
          agentName: sql`excluded.agent_name`,
          agentId: sql`excluded.agent_id`,
          promptTokensReported: sql`excluded.prompt_tokens_reported`,
          promptTokensEstimated: sql`excluded.prompt_tokens_estimated`,
          completionTokensReported: sql`excluded.completion_tokens_reported`,
          completionTokensEstimated: sql`excluded.completion_tokens_estimated`,
          callsOk: sql`excluded.calls_ok`,
          callsRuntimeError: sql`excluded.calls_runtime_error`,
          callsClientAborted: sql`excluded.calls_client_aborted`,
          callsRefused: sql`excluded.calls_refused`,
        },
      });
  }
  return rows.length;
}

/**
 * Every {@link SpendRow} of `applicationIds` over `from`..`to` (inclusive
 * days): raw rows for every day that still has them — today always, a day
 * the job has not reached yet, and a rolled day inside the 90 days — and
 * rollups for the days the prune has taken. A day is read from one source or
 * the other, never both, per AI model.
 *
 * **Raw first**, because the raw rows are the record and a rollup is their
 * sum as of the night it was built: a call that settled after its day was
 * rolled (a long stream across midnight) is in the raw rows at once and in
 * the rollup only from the next night. The prune takes whole days
 * ({@link rawRetentionCutoff}), so a day with raw rows has all of them.
 *
 * Takes many AI models so the Environment and Project totals sum the same
 * rows; which ones a reader may see is the caller's to decide.
 */
export async function readSpendRows(
  db: DrizzleDB,
  applicationIds: string[],
  from: string,
  to: string,
  today: string,
): Promise<SpendRow[]> {
  if (applicationIds.length === 0) return [];
  const rolled = await db
    .select()
    .from(aiUsageDaily)
    .where(
      and(
        inArray(aiUsageDaily.applicationId, applicationIds),
        gte(aiUsageDaily.day, from),
        lte(aiUsageDaily.day, to),
        lt(aiUsageDaily.day, today),
      ),
    )
    .orderBy(asc(aiUsageDaily.day));

  const raw: SpendRow[] = await aggregateRaw(db)
    .where(
      and(
        inArray(aiUsage.applicationId, applicationIds),
        gte(aiUsage.startedAt, from),
        lt(aiUsage.startedAt, addDays(to, 1)),
      ),
    )
    .groupBy(...GROUP);

  const rawDays = new Set(raw.map((row) => `${row.applicationId}/${row.day}`));
  return [
    ...rolled.filter((row) => !rawDays.has(`${row.applicationId}/${row.day}`)),
    ...raw,
  ];
}

/** The longest window a read answers, so `days` stays a page, not a dump. */
export const MAX_SPEND_DAYS = 3660;

function zero(): SpendFigures {
  return {
    promptTokens: { reported: 0, estimated: 0 },
    completionTokens: { reported: 0, estimated: 0 },
    calls: { ok: 0, runtimeError: 0, clientAborted: 0, refused: 0 },
  };
}

function add(into: SpendFigures, row: SpendRow): void {
  into.promptTokens.reported += row.promptTokensReported;
  into.promptTokens.estimated += row.promptTokensEstimated;
  into.completionTokens.reported += row.completionTokensReported;
  into.completionTokens.estimated += row.completionTokensEstimated;
  into.calls.ok += row.callsOk;
  into.calls.runtimeError += row.callsRuntimeError;
  into.calls.clientAborted += row.callsClientAborted;
  into.calls.refused += row.callsRefused;
}

/** `rows` summed into one figure: a total over many AI models, or one. */
export function totalOf(rows: SpendRow[]): SpendFigures {
  const total = zero();
  for (const row of rows) add(total, row);
  return total;
}

/**
 * {@link SpendRow}s as the read answers them: the total, each day of
 * `from`..`to` in order, and the window by Agent × model served, an Agent
 * being its id, kept past its removal (`agentId`), so two removed Agents
 * that shared a name stay two lines.
 */
export function toTokenSpend(
  rows: SpendRow[],
  from: string,
  to: string,
): TokenSpend {
  const total = zero();
  const days = new Map<string, SpendFigures & { day: string }>();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.set(day, { day, ...zero() });
  }
  const breakdown = new Map<string, TokenSpend['breakdown'][number]>();
  for (const row of rows) {
    add(total, row);
    const day = days.get(row.day);
    if (day) add(day, row);
    const key = JSON.stringify([row.agentId, row.model]);
    let entry = breakdown.get(key);
    if (!entry) {
      entry = {
        agentId: row.agentId,
        agentUserId: row.agentUserId,
        agentName: row.agentName,
        model: row.model,
        ...zero(),
      };
      breakdown.set(key, entry);
    }
    add(entry, row);
  }
  return {
    from,
    to,
    total,
    days: [...days.values()],
    breakdown: [...breakdown.values()].sort(
      (a, b) =>
        a.agentName.localeCompare(b.agentName) ||
        a.model.localeCompare(b.model),
    ),
  };
}
