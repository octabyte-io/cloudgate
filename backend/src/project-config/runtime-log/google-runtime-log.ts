import { cloudRunResource } from '../../cloud-accounts/gcp/cloud-run-rollout';
import type { CloudRunResource } from '../../cloud-accounts/gcp/definitions/cloud-run-definition';
import type { LogEntry } from '../../cloud-accounts/google-cloud.port';
import type { RuntimeLog, RuntimeLogLine } from './runtime-log';

/**
 * What wrote a line of a Cloud Run Service's Runtime log: the
 * app on stdout or stderr, the app through a log of its own, or Cloud Run
 * itself about the Service (a failed start, a probe, a copy stopped).
 */
export type RuntimeLogSource = 'stdout' | 'stderr' | 'app' | 'cloud-run';

/** One line of a Cloud Run Service's Runtime log, naming its copy and revision. */
export interface GoogleRuntimeLogLine extends RuntimeLogLine {
  /** The revision it is about; `null` for a Cloud Run message about none. */
  readonly revision: string | null;
  readonly source: RuntimeLogSource;
}

/**
 * One read of a Cloud Run Service's Runtime log: as on AWS, and whether its
 * reads are held back by the project's quota.
 */
export interface GoogleRuntimeLog extends RuntimeLog {
  readonly lines: GoogleRuntimeLogLine[];
  /** Google refused a read over the project's quota: the tab says "logs delayed". */
  readonly delayed: boolean;
}

/** The per-request log Cloud Run writes, which the Runtime log never shows. */
const REQUESTS_LOG = 'run.googleapis.com/requests';

/** The logs of the app's own output, by their log id. */
const OUTPUT: Readonly<Record<string, RuntimeLogSource>> = {
  'run.googleapis.com/stdout': 'stdout',
  'run.googleapis.com/stderr': 'stderr',
};

/** Log ids under these are Google's own messages about the Service. */
const GOOGLE_LOGS = ['run.googleapis.com/', 'cloudaudit.googleapis.com/'];

/**
 * Cloud Logging's filter for one Cloud Run service's Runtime log from `from`
 * on: its revisions' entries in the project's own
 * `_Default` store, never the per-request log.
 */
export function runtimeLogFilter(
  service: {
    readonly serviceName: string;
    readonly region: string;
    /** What it runs as: a Worker's log is its worker pool's. */
    readonly resource: CloudRunResource;
  },
  from: number,
): string {
  return [
    ...cloudRunResource(service.serviceName, service.resource),
    `resource.labels.location="${service.region}"`,
    `NOT log_name:"${encodeURIComponent(REQUESTS_LOG)}"`,
    `timestamp>="${new Date(from).toISOString()}"`,
  ].join(' AND ');
}

/** The log id in a log name: `run.googleapis.com/stdout` from `projects/p/logs/run.googleapis.com%2Fstdout`. */
function logIdOf(logName: string): string {
  const id = logName.slice(logName.indexOf('/logs/') + '/logs/'.length);
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function sourceOf(logId: string): RuntimeLogSource {
  return (
    OUTPUT[logId] ??
    (GOOGLE_LOGS.some((prefix) => logId.startsWith(prefix))
      ? 'cloud-run'
      : 'app')
  );
}

/**
 * One read's entries as the Runtime log's lines: each marked by what wrote
 * it, naming its copy (`task`, Cloud Run's instance id) and revision, every
 * copy merged by time (ties by copy, then by id). A per-request entry is
 * dropped even though the filter already keeps it out.
 */
export function googleRuntimeLines(
  entries: readonly LogEntry[],
): GoogleRuntimeLogLine[] {
  return entries
    .map((entry) => ({ entry, logId: logIdOf(entry.logName) }))
    .filter(({ logId }) => logId !== REQUESTS_LOG)
    .map(({ entry, logId }) => ({
      id: entry.insertId || `${entry.logName}@${entry.timestamp}`,
      at: Date.parse(entry.timestamp),
      task: entry.instance ?? '',
      revision: entry.revision,
      source: sourceOf(logId),
      message: entry.text,
    }))
    .filter((line) => Number.isFinite(line.at))
    .sort(
      (a, b) =>
        a.at - b.at || a.task.localeCompare(b.task) || a.id.localeCompare(b.id),
    );
}
