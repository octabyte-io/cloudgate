import type { QueryClient } from "@tanstack/react-query";

import { lastSetup, serversApi } from "@/lib/api/endpoints/servers";
import { keys, type OrganizationScope } from "@/lib/api/keys";
import type { LiveLog, LogEnding } from "@/lib/realtime/live-log";

/**
 * The two lines `/listen-server-setup` ends a run with, verbatim
 * (`realtime/gateways/server-setup.gateway.ts`).
 *
 * **The outcome is a line, not a close code**, and that is the gateway's choice
 * rather than an accident: a close code cannot be relied on to arrive, and the
 * setup script prints `✅` on lines of its own, so an outcome needs a prefix
 * nothing else in the output uses. These two strings are the contract.
 */
const FINISHED_LINE = "✅ Setup finished.";
const FAILED_PREFIX = "❌ Setup failed:";

/**
 * `/listen-server-setup`'s *"no run in flight"* close —
 * `server-setup.gateway.ts`'s `SETUP_CLOSE.notRunning`, mirrored by value the
 * way the other close codes in `lib/realtime/` are (ADR-0058).
 *
 * A dial that only watches gets it when the run it would have watched is
 * already over: a redial after a drop that lost the run's last frame, a
 * backend restart that lost the run itself, or a docked log's **Read it here
 * too** after the run ended. It is in the refusal band so the store does not
 * redial, and it is **not** a refusal — the run `ended`.
 */
export const SETUP_NOT_RUNNING_CLOSE_CODE = 4015;

/** The last thing the run said about itself, scanning back from the newest line. */
export function readOutcome(
  lines: readonly string[],
): { failure: string | null } | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.startsWith(FINISHED_LINE)) return { failure: null };
    if (line.startsWith(FAILED_PREFIX)) {
      return { failure: line.slice(FAILED_PREFIX.length).trim() };
    }
  }
  return null;
}

/** The sentence a run that ended out of sight opens with, on the page and in the Dock. */
export const ENDED_WHILE_AWAY =
  "This run ended while this log was disconnected.";

/** How a run that said how it went ends its log. */
function endingOf(outcome: { failure: string | null }): LogEnding {
  return outcome.failure === null
    ? { mark: "finished", words: "Succeeded", sentence: "Setup finished." }
    : {
        mark: "failed",
        words: "Failed",
        sentence: `Setup failed: ${outcome.failure}`,
      };
}

export interface SetupRunWatchDeps {
  client: QueryClient;
  organizationId: OrganizationScope;
  serverId: string;
  /**
   * Re-read the host and its row once the run is over —
   * `useInvalidate().serverReadiness` and `.server`, captured while the page
   * was mounted. They hold the app-wide client, not the page, so they still
   * work once the page is gone.
   */
  settled: () => Promise<unknown>;
}

/**
 * Have a setup run's Live log learn that its run is over, wherever the log is
 * read — on the Server page, or in the Dock after the page is gone.
 *
 * The run is over once its socket has stopped and either
 *
 * - its last line says how it went (`✅ Setup finished.` / `❌ Setup failed:`),
 *   which ends the log Succeeded or Failed; or
 * - a watch found nothing running ({@link SETUP_NOT_RUNNING_CLOSE_CODE}): the
 *   run ended while the log was disconnected. The outcome is the one stored
 *   on the Server (`lastSetup`), read again for this, and the log says the run
 *   ended out of sight. Nothing is started (ADR-0058).
 *
 * Either way the Server's readiness and row are read again on the app-wide
 * client, whether or not the Server page is mounted, and every line the log
 * holds stays. Returns the stop, which the log calls when it ends.
 */
export function watchSetupRun(
  log: LiveLog,
  deps: SetupRunWatchDeps,
): () => void {
  let done = false;

  const check = () => {
    if (done) return;
    const { status, closeCode, lines } = log.source.getSnapshot();
    if (
      status === "connecting" ||
      status === "open" ||
      status === "reconnecting"
    ) {
      return;
    }
    const outcome = readOutcome(lines);
    const notRunning =
      status === "refused" && closeCode === SETUP_NOT_RUNNING_CLOSE_CODE;
    if (!outcome && !notRunning) return;
    done = true;

    const reread = deps.settled();
    if (outcome) {
      log.end(endingOf(outcome));
      return;
    }
    void reread
      .then(() => storedEnding(deps))
      .catch(() => storedEnding(deps))
      .then((ending) => log.end(ending));
  };

  const unsubscribe = log.source.subscribe(check);
  check();
  return unsubscribe;
}

/** A run that ended out of sight, with the outcome stored on the Server. */
async function storedEnding(deps: SetupRunWatchDeps): Promise<LogEnding> {
  const unknown: LogEnding = {
    mark: "stopped",
    words: "Ended",
    sentence: `${ENDED_WHILE_AWAY} This Server has no recorded setup outcome.`,
  };
  if (deps.organizationId === null) return unknown;
  try {
    const row = await deps.client.fetchQuery({
      queryKey: keys.servers.detail(deps.organizationId, deps.serverId),
      queryFn: () => serversApi.findOne(deps.serverId),
      staleTime: 0,
    });
    const stored = lastSetup(row);
    if (!stored) return unknown;
    return stored.ok
      ? {
          mark: "finished",
          words: "Succeeded",
          sentence: `${ENDED_WHILE_AWAY} The last recorded setup run finished.`,
        }
      : {
          mark: "failed",
          words: "Failed",
          sentence: `${ENDED_WHILE_AWAY} The last recorded setup run failed${
            stored.message ? `: ${stored.message}` : "."
          }`,
        };
  } catch {
    return unknown;
  }
}
