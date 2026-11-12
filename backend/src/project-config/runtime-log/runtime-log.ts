import {
  CONTAINER_NAME,
  LOG_STREAM_PREFIX,
} from '../../cloud-accounts/aws/definitions/web-definition';
import type { LogStreamsPage } from '../../cloud-accounts/cloud.port';

/** A first read opens on the last five minutes of the Runtime log. */
export const RUNTIME_LOG_WINDOW_MS = 5 * 60_000;

/**
 * Each read starts again this far back, so an event CloudWatch takes in a
 * few seconds late is still read (the AWS spec: "a few seconds behind"). The
 * console drops the lines it already holds by their id.
 */
export const RUNTIME_LOG_LATE_MS = 10_000;

/** No read starts further back than an hour. */
export const RUNTIME_LOG_LOOKBACK_MS = 60 * 60_000;

/** At most this many lines in one read; the rest are the next read's. */
export const RUNTIME_LOG_LINES = 1_000;

/** One line of the Runtime log, naming the task that wrote it. */
export interface RuntimeLogLine {
  /** The cloud's id for the line: the same line read twice has the same id. */
  readonly id: string;
  /** Epoch milliseconds. */
  readonly at: number;
  /**
   * The copy that wrote it: the ECS task id, or Cloud Run's instance id
   * (`''` for a Cloud Run message about no one copy).
   */
  readonly task: string;
  readonly message: string;
}

/**
 * One read of a cloud Service's Runtime log: every task's lines
 * merged by time, and where the next read starts.
 */
export interface RuntimeLog {
  readonly lines: RuntimeLogLine[];
  /** The `since` of the next read. */
  readonly next: number;
  /** Lines after the last were left for the next read, which can come at once. */
  readonly more: boolean;
}

/** Where a read starts: the time asked, within the lookback, or the opening window. */
export function startOf(since: number | undefined, now: number): number {
  if (since === undefined) return now - RUNTIME_LOG_WINDOW_MS;
  return Math.min(Math.max(since, now - RUNTIME_LOG_LOOKBACK_MS), now);
}

const STREAM_PREFIX = `${LOG_STREAM_PREFIX}/${CONTAINER_NAME}/`;

/** The task id in a stream name `awslogs` made: prefix, container, task id. */
export function taskOf(logStreamName: string): string {
  return logStreamName.startsWith(STREAM_PREFIX)
    ? logStreamName.slice(STREAM_PREFIX.length)
    : logStreamName;
}

/**
 * The lines of one read, merged by time across every task (ties by task,
 * then by event id), and the next read's start: from the last line when
 * more was left, else from {@link RUNTIME_LOG_LATE_MS} ago.
 */
export function runtimeLogOf(
  page: LogStreamsPage,
  read: { startTime: number; now: number },
): RuntimeLog {
  const lines = page.events
    .map((event) => ({
      id: event.eventId,
      at: event.timestamp,
      task: taskOf(event.logStreamName),
      message: event.message,
    }))
    .sort(
      (a, b) =>
        a.at - b.at || a.task.localeCompare(b.task) || a.id.localeCompare(b.id),
    );
  const last = lines.at(-1);
  const next =
    page.more && last
      ? last.at
      : Math.max(read.startTime, read.now - RUNTIME_LOG_LATE_MS);
  return { lines, next, more: page.more && last !== undefined };
}
