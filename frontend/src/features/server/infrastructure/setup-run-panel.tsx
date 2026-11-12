import { Dot } from "@/components/console/dot";
import { DockedLogNote, LogDockButton } from "@/components/console/log-dock";
import { LogWell } from "@/components/console/log-well";
import { lastSetup, type Server } from "@/lib/api/endpoints/servers";
import type { Mark } from "@/lib/design/status";
import { BLOCKED_SENTENCE } from "@/lib/realtime/gateways";
import { useLiveLog } from "@/lib/realtime/use-socket-stream";
import type { SocketStatus } from "@/lib/realtime/use-socket-stream";
import { timeAgo, timeExact } from "@/lib/format/time";

import { ENDED_WHILE_AWAY } from "../setup-run-watch";
import type { ServerSetupRun, SetupRunState } from "../use-server";
import { toSetupLines } from "./setup-log-tones";

/**
 * The run: one sentence about where it is, then the script's own output.
 *
 * The sentence is above the well rather than inside it because the well holds what
 * the machine said and nothing else — the same division `log-well.tsx` asks for.
 *
 * **A run can be docked, running or over** (CONTEXT.md, **Docked log**): the
 * Dock button moves its Live log — socket, lines, following flag — into the
 * Dock, and this panel shows a note in its place. A run that has ended docks
 * the lines it holds and how it ended, with no Reload: the backend keeps only
 * a run's outcome, never its log (ADR-0058). Docked, it is only ever watched (ADR-0058):
 * the page no longer dials a log it does not hold, the Dock offers nothing that
 * starts a run, and **Read it here too** opens a box of the page's own that
 * only watches.
 */
export function RunPanel({
  run,
  server,
}: {
  run: ServerSetupRun;
  server: Server;
}) {
  const log = run.log;
  const stream = useLiveLog(log);
  if (log && log.owner === "dock") {
    return (
      <div className="mb-1">
        <DockedLogNote
          log={log}
          stream={stream}
          onReadHere={() => run.watch(log.key)}
        />
      </div>
    );
  }

  return (
    <div className="mb-1 flex flex-col gap-2.5 animate-rise">
      <div className="flex flex-wrap items-baseline gap-2.5">
        {/* Keyed on the state, so a run that ends swaps its sentence with a
            fade rather than a jump. The log below never animates. */}
        <p
          key={run.state}
          className="flex min-w-0 flex-1 animate-fade items-baseline gap-2 text-body text-tx wrap-anywhere"
        >
          <Dot mark={MARK[run.state]} />
          {headline(run.state, server)}
        </p>
        {run.state === "running" ? (
          <span className="text-meta text-tx-3">
            {CONNECTION[run.connection]}
          </span>
        ) : null}
        {/* Running or over, a run with output can be docked; one refused or
            blocked has none. Docked once over, it is the lines held and how
            it ended — nothing stores a run's log, so there is no Reload. */}
        {run.state === "refused" || run.state === "blocked" ? null : (
          <LogDockButton log={log} />
        )}
      </div>

      {run.reason ? (
        /* The script's, or the gateway's, own words. Long, and worth every
           character: "Remote command failed with exit code 1" is the difference
           between a broken host and a missing sudo rule. */
        <p className="font-mono text-meta text-tx-2 wrap-anywhere">
          {run.reason}
        </p>
      ) : null}

      {run.state === "ended" ? <EndedOutcome server={server} /> : null}

      {AFTERWORD[run.state] ? (
        <p
          key={run.state}
          className={
            run.state === "interrupted"
              ? "animate-fade rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-meta text-tx"
              : "animate-fade text-meta text-tx-3"
          }
        >
          {AFTERWORD[run.state]}
        </p>
      ) : null}

      {run.state === "refused" || run.state === "blocked" ? null : (
        <LogWell
          label="Setup output"
          lines={toSetupLines(run.lines)}
          live={run.state === "running"}
          dropped={run.dropped}
          following={run.following}
          onFollowingChange={run.setFollowing}
        />
      )}
    </div>
  );
}

const MARK: Record<SetupRunState, Mark> = {
  idle: { tone: "mute", glyph: "○", label: "not started" },
  running: { tone: "info", glyph: "◐", label: "running" },
  finished: { tone: "ok", glyph: "●", label: "finished" },
  failed: { tone: "bad", glyph: "○", label: "failed" },
  interrupted: { tone: "warn", glyph: "◐", label: "output lost" },
  ended: { tone: "mute", glyph: "○", label: "ended" },
  refused: { tone: "bad", glyph: "○", label: "refused" },
  blocked: { tone: "bad", glyph: "○", label: "not connected" },
};

function headline(state: SetupRunState, server: Server): string {
  switch (state) {
    case "running":
      return `Running on ${server.ipAddress}, as ${server.username}.`;
    case "finished":
      return "Setup finished.";
    case "failed":
      return "Setup stopped before it finished.";
    case "interrupted":
      return "Cloudgate stopped receiving this run's output.";
    case "ended":
      return ENDED_WHILE_AWAY;
    case "refused":
    case "blocked":
      return "Cloudgate did not start a run.";
    default:
      return "Nothing has been run yet.";
  }
}

/** The sentence after the outcome: what it means, and what to do next. */
const AFTERWORD: Record<SetupRunState, string | null> = {
  idle: null,
  running: null,
  finished:
    "The readiness check above has been read again from the host, so it now reflects this run.",
  failed:
    "Nothing was undone — the script stops where it fails and leaves the steps it had already finished in place. Fix what the line above names and run setup again; the steps that are done will be skipped.",
  interrupted:
    "The run carries on on the machine: Cloudgate has no way to stop a script it has started, and closing this page never did. Watch again to pick the output back up, or read the readiness check above to see where it got to.",
  ended:
    "The output below is what arrived before the connection dropped; the rest was not kept. Cloudgate did not start anything when it reconnected.",
  refused: null,
  blocked: `${BLOCKED_SENTENCE} Nothing was run on the machine: a run starts when this connection opens, and it never did.`,
};

/**
 * How an `ended` run went, from the Server's stored record — the log lost the
 * run's own last line, and the row is what kept it. "Last recorded" because a
 * run cut short by a backend restart may not have recorded anything, and the
 * row then still holds the run before it.
 */
function EndedOutcome({ server }: { server: Server }) {
  const stored = lastSetup(server);
  if (!stored) {
    return (
      <p className="text-meta text-tx-2">
        This Server has no recorded setup outcome.
      </p>
    );
  }
  const when = (
    <time dateTime={stored.at} title={timeExact(stored.at)}>
      {timeAgo(stored.at)}
    </time>
  );
  return (
    <div>
      <p className="flex items-baseline gap-2 text-body text-tx">
        <Dot mark={stored.ok ? MARK.finished : MARK.failed} />
        <span>
          The last recorded setup run {stored.ok ? "finished" : "failed"} {when}
          .
        </span>
      </p>
      {!stored.ok && stored.message ? (
        <p className="mt-1.5 font-mono text-meta text-tx-2 wrap-anywhere">
          {stored.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the socket is doing, in words. `--tx-3` because it is not the content.
 *
 * `reconnecting` names the thing somebody watching a Docker install for the third
 * minute needs to be told: the socket dropping is not the run dropping.
 */
const CONNECTION: Record<SocketStatus, string> = {
  connecting: "Connecting…",
  open: "Streaming",
  closed: "Stream closed",
  refused: "Stream refused",
  reconnecting: "Reconnecting — this does not stop the run…",
  blocked: "Not connected",
};
