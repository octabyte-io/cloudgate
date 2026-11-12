import { FINISHED_DEPLOYMENT_STATUSES } from 'api-schemas';
import type { DeploymentStatus, DeploymentView } from 'api-schemas';

import { abortOf, POLL_MILLISECONDS } from './stopping.js';

export type { DeploymentStatus, DeploymentView };

/** A Deployment log being followed: close it, or learn that it ended. */
export interface DeploymentLog {
  /** Settles when the stream ends, whoever ended it. */
  closed: Promise<void>;
  close(): void;
}

/** How a watch ended. */
export type WatchResult =
  { kind: 'finished'; deployment: DeploymentView } | { kind: 'interrupted' };

export interface WatchOptions {
  /** `GET /deployments/:id`. */
  read: () => Promise<DeploymentView>;
  /** Opens the Deployment log stream; absent when the Instance offers none. */
  follow?: (onText: (text: string) => void) => DeploymentLog;
  /** Where the log's text goes. */
  onText: (text: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  /** Ctrl-C: stop watching. The Deployment goes on. */
  signal: AbortSignal;
  /** How often to ask; 2 s. */
  pollMilliseconds?: number;
}

export function isFinished(status: DeploymentStatus): boolean {
  return FINISHED_DEPLOYMENT_STATUSES.includes(status);
}

/**
 * Follows one Deployment to its end (CLI spec: "the wait ends when `GET
 * /deployments/:id` says the Deployment finished, even if the stream stays
 * open"). Shared by `deploy` and `logs --deployment -f`.
 *
 * **The status is what ends it, never the stream.** `/listen-deployment` is
 * `tail -f` on the log file and does not close when the Deployment finishes;
 * and a stream that does end early (a dropped connection, a log past
 * retention) says nothing about the Deployment either, so asking goes on until
 * the answer is done, failed or cancelled. A held or pending Deployment is not
 * finished: it is waiting on a plan or on the queue.
 *
 * Each ask waits for the one before it, so a slow Instance is never asked
 * twice at once. Once finished, the stream gets one more interval to deliver
 * the log's last lines, then is closed.
 */
export async function watchDeployment(
  options: WatchOptions,
): Promise<WatchResult> {
  const pollMilliseconds = options.pollMilliseconds ?? POLL_MILLISECONDS;
  const log = options.follow?.(options.onText);
  const interrupted = abortOf(options.signal).then(
    () => 'interrupted' as const,
  );
  try {
    for (;;) {
      if (options.signal.aborted) return { kind: 'interrupted' };
      const deployment = await Promise.race([options.read(), interrupted]);
      if (deployment === 'interrupted') return { kind: 'interrupted' };
      if (isFinished(deployment.status)) {
        if (log) {
          await Promise.race([
            options.sleep(pollMilliseconds),
            log.closed,
            interrupted,
          ]);
        }
        return { kind: 'finished', deployment };
      }
      const woke = await Promise.race([
        options.sleep(pollMilliseconds),
        interrupted,
      ]);
      if (woke === 'interrupted') return { kind: 'interrupted' };
    }
  } finally {
    log?.close();
  }
}
