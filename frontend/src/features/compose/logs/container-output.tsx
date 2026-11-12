import { useEffect } from "react";

import { DockedLogNote, LogDockButton } from "@/components/console/log-dock";
import { LogRefusal } from "@/components/console/log-refusal";
import { LogWell, toLogLines } from "@/components/console/log-well";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import {
  BLOCKED_SENTENCE,
  OUTPUT_ENDED_CLOSE_CODE,
  outputEndedSentence,
  useContainerLogs,
  type LogsRunType,
} from "@/lib/realtime/gateways";
import type { LiveLog } from "@/lib/realtime/live-log";

/**
 * Have a docked container log end when its output does — the gateway's
 * `4014` close (the container stopped, restarted or was removed). The socket
 * is already shut and the store does not redial on that code; this is what
 * turns it into the tab's ending: ⊘, "Container stopped", every line kept.
 *
 * Only a docked log ends. A page box that was never docked keeps today's
 * ending sentence and its **Reconnect**, which an ended Live log would refuse.
 * A log docked while still following is watched for as long as it lives; the
 * card hides its Dock button once the output has ended, so nothing already
 * over is docked.
 */
function watchOutputEnded(log: LiveLog): () => void {
  const settle = () => {
    if (log.owner !== "dock") return;
    const { status, closeCode, closeReason } = log.getSnapshot();
    if (status !== "refused" || closeCode !== OUTPUT_ENDED_CLOSE_CODE) return;
    log.end({
      mark: "stopped",
      words: "Container stopped",
      sentence: `${closeReason ?? "The container's output ended"}.`,
    });
  };
  return log.subscribe(settle);
}

/**
 * One container's output, live.
 *
 * **A stack has no stack-wide log**, and that is the shape of the backend rather
 * than a simplification: `/docker-container-logs` takes one `containerId` and runs
 * `docker logs --follow` on it (or `docker service logs` with `runType=swarm`).
 * There is no `docker compose logs` gateway, so "the logs" for a stack is a choice
 * of container before it is a stream — which is what the Logs tab is built around.
 *
 * **Lines are not toned.** F09's `log-tones.ts` is keyed to what *this backend's*
 * build commands print; the containers in a stack are third-party images with as
 * many log formats, and a rule keyed to one of them would be silent on the others
 * and wrong about a third. `LogWell` renders lines and never parses them — this is
 * the side of that contract where the honest answer is to parse nothing.
 *
 * **A following log can be docked** (CONTEXT.md, **Docked log**): the header's
 * Dock button moves the Live log — socket, lines, following flag — into the
 * Dock as "stack · container", and this card shows a note in its place. Once
 * docked, the gateway's output-ended close ends the tab as "Container stopped"
 * (`watchOutputEnded`), whether or not this page is still there.
 */
export function ContainerOutput({
  containerId,
  serverId,
  composeId,
  label,
  runType = "native",
  /** What this is following, for the sentence above the well. */
  describe,
  subject,
  container,
}: {
  containerId: string | null;
  serverId: string | null;
  /** A stack on its own Stack VM, which the gateway reaches by the stack. */
  composeId?: string | null;
  label: string;
  runType?: LogsRunType;
  describe?: string;
  /** Whose container this is — the stack's name — for the Dock tab's name. */
  subject?: string;
  /** The container's (or Swarm service's) name, for the Dock tab's name. */
  container?: string;
}) {
  const stream = useContainerLogs({
    containerId,
    serverId,
    composeId,
    runType,
    tail: 200,
  });
  const log = stream.log;
  const docked = log?.owner === "dock";

  // The Live log's own name and its own watch on the output ending: both go
  // with it to the Dock. `watch` starts once per log, and the log stops it.
  const what = container ?? containerId ?? label;
  const name = subject ? `${subject} · ${what}` : what;
  useEffect(() => {
    if (!log || containerId === null) return;
    log.describe({ name, toLines: toLogLines });
    log.watch("output-ended", () => watchOutputEnded(log));
  }, [log, name, containerId]);

  /**
   * The follower ended — the container stopped, restarted or was removed.
   * Checked before `refused`, because it arrives on the same 4xxx band and is not
   * a refusal: the stream ran and finished, so it gets an ending and no refusal
   * box, whose hint about a container removed *since the list was read* is a
   * guess about a connect this stream got past.
   */
  const ended = outputEndedSentence(stream);
  const refused = ended ? null : stream.closeReason;

  if (log && docked) {
    return (
      <DockedLogNote
        log={log}
        stream={stream}
        onReadHere={stream.readHereToo}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="min-w-0 flex-1 text-meta text-tx-2">
          {containerId === null
            ? "Nothing is selected."
            : ended
              ? ended
              : refused
                ? "The gateway closed the connection."
                : stream.status === "blocked"
                  ? `${BLOCKED_SENTENCE} The container is unaffected.`
                  : stream.status === "open"
                    ? `Following ${describe ?? "the container"}.`
                    : stream.status === "connecting"
                      ? "Connecting…"
                      : "Not connected."}
        </span>
        {stream.live ? <LogDockButton log={log} /> : null}
        <Button
          size="xs"
          onClick={stream.reconnect}
          aria-disabled={containerId === null || undefined}
        >
          <Icon name="refresh" size={14} />
          Reconnect
        </Button>
      </div>

      {refused ? (
        <LogRefusal
          reason={refused}
          code={stream.closeCode}
          hint="A container that has been removed since this list was read is the usual reason — re-read the containers and pick again."
        />
      ) : null}

      <LogWell
        label={label}
        lines={toLogLines(stream.lines)}
        live={stream.status === "open"}
        dropped={stream.dropped}
        following={stream.following}
        onFollowingChange={stream.setFollowing}
      />
    </div>
  );
}
