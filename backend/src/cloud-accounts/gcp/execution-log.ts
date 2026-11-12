import type {
  CloudRunExecutionRef,
  ExecutionLogPlace,
  LogEntry,
} from '../google-cloud.port';
import { cloudRunResource } from './cloud-run-rollout';

/**
 * **A Cron run's log on Google Cloud** (the Google Cloud kinds spec): its
 * execution's own output, copied from Cloud Logging into the Run record's
 * log while it runs. Pure: the filter the adapter reads with, and where
 * the copy has reached after each read.
 */

/** The logs a container's output is written to; Cloud Run's own messages are not the run's. */
const OUTPUT_LOGS = ['run.googleapis.com/stdout', 'run.googleapis.com/stderr'];

/** Cloud Logging's label naming the execution an entry of a job is from. */
const EXECUTION_NAME_LABEL = 'run.googleapis.com/execution_name';

/**
 * How far back a read with no place yet looks: the oldest an
 * execution's output can be, its task timeout of a day, and an hour more.
 * An oldest-first read with no lower bound starts at the oldest entry the
 * log store keeps and answers empty pages while it walks the weeks between,
 * so it read as "nothing yet" for the whole of a run.
 */
export const FIRST_READ_LOOKBACK_MS = 25 * 60 * 60 * 1000;

/**
 * Cloud Logging's filter of one execution's own output from a place on:
 * its job's `cloud_run_job` entries labelled with its execution's name, so
 * two runs of one Cron service at once never mix, stdout and stderr, at or
 * after the place's instant, or {@link FIRST_READ_LOOKBACK_MS} before `now`
 * with no place yet. The entries at exactly that instant already
 * copied are left out by insert id after the read
 * ({@link afterPlace}), since a filter cannot say "after this entry".
 */
export function executionLogFilter(
  ref: Pick<CloudRunExecutionRef, 'job' | 'execution'>,
  from: ExecutionLogPlace | null,
  now: number,
): string {
  const since = from
    ? from.timestamp
    : new Date(now - FIRST_READ_LOOKBACK_MS).toISOString();
  return [
    ...cloudRunResource(ref.job, 'job'),
    `labels."${EXECUTION_NAME_LABEL}"="${ref.execution}"`,
    `(${OUTPUT_LOGS.map((log) => `log_id("${log}")`).join(' OR ')})`,
    `timestamp>="${since}"`,
  ].join(' AND ');
}

/** `entries` less those at exactly the place's instant that it already holds. */
export function afterPlace(
  entries: readonly LogEntry[],
  from: ExecutionLogPlace | null,
): LogEntry[] {
  if (!from) return [...entries];
  const held = new Set(from.insertIds);
  return entries.filter(
    (entry) =>
      !(entry.timestamp === from.timestamp && held.has(entry.insertId)),
  );
}

/**
 * Where the copy has reached once `entries` (oldest first, already past
 * `from`) are copied: the last one's instant, with every entry copied at
 * it. **A read that found nothing leaves the place where it was**, so an
 * entry Cloud Logging takes in late is still read (the CloudWatch lesson of
 * bf22abe).
 */
export function nextLogPlace(
  from: ExecutionLogPlace | null,
  entries: readonly LogEntry[],
): ExecutionLogPlace | null {
  const last = entries.at(-1);
  if (!last) return from;
  const atLast = entries
    .filter((entry) => entry.timestamp === last.timestamp)
    .map((entry) => entry.insertId);
  const kept = from && from.timestamp === last.timestamp ? from.insertIds : [];
  return {
    timestamp: last.timestamp,
    insertIds: [...new Set([...kept, ...atLast])],
  };
}

/** A place as the Run record keeps it (`CronRunMark.logFrom`). */
export function logPlaceText(place: ExecutionLogPlace): string {
  return JSON.stringify(place);
}

/** A kept place read back; `null` for none or one this did not write. */
export function logPlaceOf(
  text: string | null | undefined,
): ExecutionLogPlace | null {
  if (!text) return null;
  try {
    const read = JSON.parse(text) as Partial<ExecutionLogPlace>;
    if (
      typeof read.timestamp === 'string' &&
      Array.isArray(read.insertIds) &&
      read.insertIds.every((id) => typeof id === 'string')
    ) {
      return { timestamp: read.timestamp, insertIds: read.insertIds };
    }
  } catch {
    // Not a place this wrote: read from the start.
  }
  return null;
}
