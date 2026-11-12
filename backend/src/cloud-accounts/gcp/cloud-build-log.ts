import type { ExecutionLogPlace } from '../google-cloud.port';

/**
 * **A hosted Cloud Build build's log in Cloud Logging** (ADR-0047).
 * Pure: the filter the adapter reads one build's lines with. Where the
 * copy has reached after each read is `execution-log.ts`'s place, the same
 * shape a Cron run's copy keeps (`afterPlace`, `nextLogPlace`).
 *
 * A build that runs as a user-specified service account (the Cloud account's
 * build identity) writes with `options.logging:
 * CLOUD_LOGGING_ONLY` (`cloud-builds/google-build-program.ts` says why).
 * Its lines are then entries of the project's `cloudbuild` log on the
 * `build` resource labelled with the build's id, each line one entry's
 * `textPayload`: the filter below is the one the Google Cloud CLI tails a
 * running build's log with (`googlecloudsdk/api_lib/cloudbuild/logs.py`,
 * `GCLLogTailer`, SDK 570.0.0).
 */

/**
 * How far back a read with no place yet looks: a build's default timeout
 * (60 minutes) and its queue's (`queueTtl`, 60 minutes), and an hour more.
 * A lower bound keeps the oldest-first read from walking weeks of empty
 * pages (a lesson of the Google acceptance walk).
 */
export const BUILD_LOG_LOOKBACK_MS = 3 * 60 * 60 * 1000;

/** Cloud Logging's filter of one build's own lines from a place on. */
export function cloudBuildLogFilter(
  request: { readonly projectId: string; readonly buildId: string },
  from: ExecutionLogPlace | null,
  now: number,
): string {
  const since = from
    ? from.timestamp
    : new Date(now - BUILD_LOG_LOOKBACK_MS).toISOString();
  return [
    `logName="projects/${request.projectId}/logs/cloudbuild"`,
    'resource.type="build"',
    `resource.labels.build_id="${request.buildId}"`,
    `timestamp>="${since}"`,
  ].join(' AND ');
}
