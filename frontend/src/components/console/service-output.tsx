import { useEffect, useRef } from "react";

import { DockedLogNote, LogDockButton } from "@/components/console/log-dock";
import { LogRefusal } from "@/components/console/log-refusal";
import { LogWell, toLogLines } from "@/components/console/log-well";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import type { ApplicationStatus } from "@/lib/api/endpoints/applications";
import {
  BLOCKED_SENTENCE,
  outputEndedSentence,
  useContainerLogs,
} from "@/lib/realtime/gateways";
import type { LiveLog } from "@/lib/realtime/live-log";

import { toCopyLines } from "./service-output-lines";

export type ServiceOutputProps = {
  /** The Swarm service's name, which is what `docker service logs` wants. */
  appName: string;
  /** The Server it runs on; `null` on the platform host. */
  serverId: string | null;
  /** The row's `applicationStatus`, which knows what the socket cannot. */
  status: ApplicationStatus;
  /** The Service's name, for the well's label and the Dock tab. */
  name: string;
  /** What the Service is called in a sentence: "database", "Application". */
  noun: string;
  /**
   * Start the Live log's watch on the row, which keeps this box's rules once
   * the log is docked and the page is gone (`watchServiceStatus`). `null` when
   * it cannot start yet — the log tries again.
   */
  watch: (log: LiveLog) => (() => void) | null;
  /**
   * Read every running copy with Docker's task prefix kept, and draw them
   * merged by time, each line naming its copy (an Application's Logs tab).
   * Left out, the lines are drawn as Docker's stripped output, as a
   * database's always were.
   */
  copies?: boolean;
};

/**
 * A Service's **Runtime log** on a Server or the platform host: Docker's
 * output for its Swarm service, live over `/docker-container-logs` with
 * `runType=swarm`. A database's Container output and an Application's Logs
 * tab are this one box (#1341).
 *
 * It needs no container lookup: `docker service logs` takes a **service
 * name**, and a managed Service's Swarm service is named exactly its
 * `appName`, which also satisfies the gateway's `isValidContainerId` check.
 * So nothing goes stale when Swarm replaces a task. It opens on the last 200
 * lines, then follows.
 *
 * **Lines are not toned.** What a Service writes is its own format; `LogWell`
 * renders lines and never parses them. With `copies` the only parsing is
 * Docker's own prefix and stamp (`toCopyLines`).
 *
 * **It can be docked** (CONTEXT.md, **Docked log**): the Dock button moves
 * the Live log — socket, lines, following flag — into the Dock, and this box
 * shows a note in its place. The Live log watches the row itself (`watch`), so
 * once docked it keeps this box's rules after the page is gone: a stopped
 * Service shows no cursor, an `idle` one is not dialled, and one that
 * finishes deploying is dialled again.
 */
export function ServiceOutput({
  appName,
  serverId,
  status,
  name,
  noun,
  watch,
  copies = false,
}: ServiceOutputProps) {
  /**
   * Never deployed, so there is no Swarm service to follow. Dialling
   * anyway answered "The gateway closed the connection", a Reconnect, a "Not
   * found or not permitted" box and an empty terminal bar — a socket error for
   * what is simply a Service nobody has deployed. `idle` is the column's
   * default and what only a never-deployed workload wears (`status.ts`); the
   * socket dials the moment a deploy moves it on.
   */
  const undeployed = status === "idle";
  const stream = useContainerLogs({
    enabled: !undeployed,
    containerId: appName,
    serverId,
    runType: "swarm",
    taskPrefix: copies,
    tail: 200,
  });
  const log = stream.log;
  const docked = log?.owner === "dock";
  const toLines = copies ? toCopyLines : toLogLines;

  // The Live log's name, how its lines read, and its watch on the row go
  // with it to the Dock. `watch` starts once per log, and the log stops it.
  const dockName = `${name} · Runtime log`;
  const watchRef = useRef(watch);
  useEffect(() => {
    watchRef.current = watch;
  });
  useEffect(() => {
    if (!log || undeployed) return;
    log.describe({ name: dockName, toLines });
    log.watch("service-status", () => watchRef.current(log));
  }, [log, undeployed, dockName, toLines]);

  /**
   * Redial when the Service finishes converging.
   *
   * **Found by deploying a database and watching this well not change.**
   * Opening a Service that has never been deployed dials a gateway whose
   * `docker service logs` immediately answers *no such task or service* and
   * exits, closing with `OUTPUT_ENDED_CLOSE_CODE`, which the store
   * deliberately does not redial — so nothing tells the client to try again
   * once Deploy has made the service.
   *
   * Nothing pushes "the service exists now" either, so the signal is the row:
   * `applicationStatus` reaching `done` means the converge finished. The ref is
   * what keeps this to the *transition* — re-running on every poll would drop
   * and redial the socket every few seconds. A docked log's watch redials
   * it instead, so this one leaves it alone.
   */
  const previousStatus = useRef(status);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = status;
    if (docked) return;
    if (was !== "done" && status === "done") {
      stream.reconnect();
    }
  }, [status, stream, docked]);

  /**
   * The follower ended, or the Swarm service was removed under it — an
   * ending rather than a refusal, so it is checked first and gets no refusal box.
   */
  const ended = outputEndedSentence(stream);
  const refused = ended ? null : stream.closeReason;

  /**
   * A stopped Service has no task, so there is nothing to follow.
   *
   * `docker service logs --follow` on a service scaled to zero does not fail
   * and does not close — it sits there, which is exactly what an open socket
   * with no lines looks like. So "Following …" and a blinking cursor would be
   * true of the socket and false of the Service. The row is what knows.
   */
  const stopped = status === "stopped";

  if (undeployed) {
    return (
      <p className="text-meta text-tx-2">
        Not deployed yet, so there is no container to read. Deploy it and its
        output appears here.
      </p>
    );
  }

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
          {ended
            ? ended
            : refused
              ? "The gateway closed the connection."
              : stream.status === "blocked"
                ? `${BLOCKED_SENTENCE} The ${noun} is unaffected.`
                : stopped
                  ? "Stopped — the Swarm service has no running task, so nothing is being written. Start it to follow the output again."
                  : stream.status === "open"
                    ? copies
                      ? "Following every running copy of the Swarm service."
                      : "Following the Swarm service's output."
                    : stream.status === "connecting"
                      ? "Connecting…"
                      : "Not connected."}
        </span>
        <Button size="xs" onClick={stream.reconnect}>
          <Icon name="refresh" size={14} />
          Reconnect
        </Button>
        <LogDockButton log={log} />
      </div>

      {refused ? (
        <LogRefusal
          reason={refused}
          code={stream.closeCode}
          hint={`A ${noun} that has never been deployed has no Swarm service to read, which is the usual reason — deploy it and the output appears here.`}
        />
      ) : null}

      <LogWell
        label={`Container output for ${name}`}
        lines={toLines(stream.lines)}
        live={stream.status === "open" && !stopped}
        dropped={stream.dropped}
        following={stream.following}
        onFollowingChange={stream.setFollowing}
      />
    </div>
  );
}
