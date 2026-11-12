import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { DockedLogNote, LogDockButton } from "@/components/console/log-dock";
import { LogRefusal } from "@/components/console/log-refusal";
import { LogWell } from "@/components/console/log-well";
import { StatusPill } from "@/components/console/status-pill";
import { useDock } from "@/components/shell/dock-context";
import { Button } from "@/components/ui/button";
import {
  deploymentsApi,
  type Deployment,
} from "@/lib/api/endpoints/deployments";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { Icon } from "@/lib/design/icons";
import {
  BLOCKED_SENTENCE,
  REAPED_LOG_CLOSE_CODE,
  deploymentLogKey,
  useDeploymentLog,
} from "@/lib/realtime/gateways";
import { useLiveLog } from "@/lib/realtime/use-socket-stream";
import type { SocketStatus } from "@/lib/realtime/use-socket-stream";
import { timeExact } from "@/lib/format/time";

import { ExplainLog } from "@/features/integrations/ai/explain-log";

import { deploymentEnding, watchDeployment } from "./deployment-watch";
import { splitLogText, toBuildLines } from "./log-tones";
import { STORED_LOG_TAIL, storedDeploymentLog } from "./stored-deployment-log";

/** A Deployment that is still writing to its log. */
function isLive(status: Deployment["status"]): boolean {
  return status === "pending" || status === "running";
}

/**
 * One Deployment's build output.
 *
 * **Two sources, and which one is used is decided by the Deployment's status, not
 * by trying one and falling back.** A live build opens `/listen-deployment`, whose
 * `tail -n +1 -f` replays the whole file before following — so a build opened
 * three minutes in shows those three minutes and then keeps going. A finished one
 * reads `GET /deployments/:id/logs` once, because a socket to a file nothing is
 * appending to would connect, replay, and then sit open for ever waiting for a
 * line that is never coming.
 *
 * **Which machine holds the file is not this component's business.** It used to
 * pass the build `serverId` and the Deployment's `logPath` to the socket; now
 * the gateway is addressed by deployment id and resolves both from the row,
 * which is what stops a signed-in caller streaming any file under the platform
 * directory.
 *
 * **Which of the two paths a reaped log arrives on, decided rather than left
 * implicit.**
 * ADR-0020 keeps a Deployment log for 90 days and both readers now say so past
 * the window — the route answers `reapedLogNotice`'s sentence as its body, the
 * socket closes {@link REAPED_LOG_CLOSE_CODE} carrying that sentence elided.
 * `isLive` sends a *settled* Deployment down the HTTP path whatever its
 * age, so the close is reachable from this screen only for a Deployment left
 * non-terminal past the window — a queue the engine never finished — and
 * otherwise only from a direct consumer of the gateway (`StreamPanel`, the dev
 * probe, which prints `closeReason` verbatim because a wire probe should).
 * **That asymmetry is kept**: routing a settled Deployment through a socket to
 * reach one sentence would open, replay nothing and hang waiting on a file that
 * has been deleted, which is the failure the status test exists to avoid. What
 * had to be true instead is that the two paths do not *disagree*, which is
 * {@link REAPED_NOTE}'s job.
 *
 * Follow-tail lives on the stream's Live log, so a paused log stays paused
 * wherever it is read next; `LogWell` shows it and keeps the scroll position.
 * This only decides what is in the well and whether the cursor is drawn.
 *
 * **A live build's log can be docked** (CONTEXT.md, **Docked log**): the
 * header's Dock button moves the Live log — socket, lines, following flag —
 * into the Dock, and this box shows a note in its place. The Live log watches
 * the Deployment's status itself (`watchDeployment`), so a docked log learns
 * that its build ended after this page is gone.
 *
 * **A finished build's log can be docked too** (#1340), as a fixed record: its
 * REST read is not a Live log, so the Dock button builds one at the press —
 * the lines read, ended the way the build did, with Reload reading the route
 * again (`storedDeploymentLog`). It is moved like a live one: under the same
 * key, so the Dock holds this Deployment's log once whichever version came
 * first, and while it is there this box shows the docked note in its place —
 * whether it was docked from here or from another box of the same
 * Deployment, or before this page was come back to. **Read it here too**
 * gives the box its own read back until it is docked again.
 */
export function DeploymentLog({
  deployment,
  label = "Deployment output",
  subject,
}: {
  deployment: Deployment;
  label?: string;
  /** Whose Deployment this is — the Service's name — for the Dock tab's name. */
  subject?: string;
}) {
  const live = isLive(deployment.status);
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();

  const stream = useDeploymentLog({
    deploymentId: deployment.deploymentId,
    enabled: live,
  });
  const log = stream.log;
  const docked = log?.owner === "dock";

  // A finished build's log in the Dock under this Deployment's key — docked
  // from this box, from another, or a live one whose build has since ended —
  // unless Read it here too asked for this box's own read back.
  const dock = useDock();
  const key = deploymentLogKey(deployment.deploymentId);
  const [readHere, setReadHere] = useState(false);
  const elsewhere =
    !live && !readHere
      ? (dock?.logs.find((held) => held.key === key) ?? null)
      : null;
  const elsewhereStream = useLiveLog(elsewhere);

  // The Live log's own name and its own watch on the build's status: both go
  // with it to the Dock. `watch` starts once per log, and the log stops it.
  const name = subject ? `${subject} · ${deployment.title}` : deployment.title;
  useEffect(() => {
    if (!log || !live) return;
    log.describe({ name, toLines: toBuildLines });
    log.watch("deployment-status", () =>
      watchDeployment(queryClient, organizationId, deployment, log),
    );
  }, [log, live, name, queryClient, organizationId, deployment]);

  const settled = useQuery({
    queryKey: keys.deployments.logs(organizationId, deployment.deploymentId),
    queryFn: () =>
      deploymentsApi.readLogs(deployment.deploymentId, STORED_LOG_TAIL),
    enabled: !live && organizationId !== null,
  });

  const lines = live
    ? stream.lines
    : settled.data
      ? splitLogText(settled.data)
      : [];

  // Toned once, and the stripped text is what `ExplainLog` sends: it states that
  // the lines on screen are what goes to the provider, so it sends those rather
  // than the raw ones with their terminal escapes still in.
  const toned = toBuildLines(lines);

  const refused = live ? stream.closeReason : null;

  // Once its lines are read, a finished build's Dock button hands over its
  // stored record, built at the press. A `held` build is not over, so it has
  // no ending to dock with and no button.
  const ending = live ? null : deploymentEnding(deployment.status);
  const text = settled.data;
  const record =
    ending !== null && text !== undefined
      ? () =>
          storedDeploymentLog({
            key,
            deploymentId: deployment.deploymentId,
            text,
            ending,
            about: { name, toLines: toBuildLines },
          })
      : null;

  const inDock = log && docked ? log : elsewhere;
  if (inDock) {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <StatusPill
            key={deployment.status}
            status={deployment.status}
            className="animate-fade"
          />
          <span
            title={deployment.title}
            className="min-w-0 flex-1 truncate text-meta text-tx-2"
          >
            {deployment.title}
          </span>
        </div>
        <DockedLogNote
          log={inDock}
          stream={inDock === log ? stream : elsewhereStream}
          onReadHere={() => {
            stream.readHereToo();
            setReadHere(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        {/* Keyed: pending → running → done fades in the new word. The
            well below never animates. */}
        <StatusPill
          key={deployment.status}
          status={deployment.status}
          className="animate-fade"
        />
        <span
          title={deployment.title}
          className="min-w-0 flex-1 truncate text-meta text-tx-2"
        >
          {deployment.title}
        </span>
        {live ? (
          <>
            <span className="text-meta text-tx-3">
              {CONNECTION[stream.status]}
            </span>
            <LogDockButton log={log} />
          </>
        ) : (
          <>
            <span className="text-meta text-tx-3">
              {settled.isPending
                ? "Reading the log…"
                : `${lines.length} ${lines.length === 1 ? "line" : "lines"}`}
            </span>
            <Button
              size="xs"
              onClick={() => void settled.refetch()}
              aria-label="Read the log again"
            >
              <Icon name="refresh" size={14} />
              Reload
            </Button>
            <LogDockButton
              log={record}
              onDocked={() => setReadHere(false)}
            />
          </>
        )}
      </div>

      {/* No `hint`, because this view has no connect-time guess to make: the
          socket is addressed by deployment id and resolves the Server
          and the path from the row, so "removed since this list was read" and
          "never been deployed" — the guesses the other three log views carry —
          have no analogue here. There is no wrong id a caller could have picked.

          The sentence below is a `note` rather than a `hint` on purpose:
          it is a fact about the build, not a guess at the refusal, and it stays
          true when a lease ends mid-stream. Passed as a `hint` it was gated on
          the close code and withheld on exactly the `4010` it was written for,
          which is the non-goal the conversion named and then silently reversed.

          It is `refusalNote(closeCode)` rather than one string because a later
          change added a close the fixed sentence is false on — see that function. It
          is still a `note` and not a `hint`: both branches are facts about the
          log rather than guesses at the cause, and `hint`'s gate is `4010`
          alone, which would withhold the reaped sentence on nothing and hand a
          lease close the wrong one of the two. */}
      {/* The browser never opened the socket. The deploy was accepted
          over REST before this card dialled, so it runs regardless — and once
          it finishes, `live` goes false and the stored log below is read over
          REST too, which the browser has no objection to. */}
      {live && stream.status === "blocked" ? (
        <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-meta text-tx">
          {BLOCKED_SENTENCE} The build is unaffected, and its log can be read
          here once it finishes.
        </p>
      ) : null}

      {refused ? (
        <LogRefusal
          reason={refused}
          code={stream.closeCode}
          note={refusalNote(stream.closeCode)}
        />
      ) : null}

      {settled.error ? (
        <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-2.5 text-meta text-tx">
          {errorMessage(settled.error)}
        </p>
      ) : null}

      <LogWell
        label={label}
        lines={toned}
        live={live && stream.status === "open"}
        dropped={live ? stream.dropped : 0}
        following={stream.following}
        onFollowingChange={stream.setFollowing}
        stamp={
          deployment.startedAt
            ? timeExact(deployment.startedAt)
            : timeExact(deployment.createdAt)
        }
      />

      {/* F15's one addition to this file: `POST /ai/analyze-logs` belongs on a
          log, not on a settings page. It renders nothing when no AI provider is
          configured, and it is placed *after* a finished build's output rather
          than beside a live one's — a stream still writing is not a thing to ask
          a model about. */}
      {!live && lines.length > 0 ? (
        <ExplainLog lines={toned.map((line) => line.text)} context="build" />
      ) : null}

      {!live && lines.length === 0 && !settled.isPending && !settled.error ? (
        <p className="text-meta text-tx-2">
          This Deployment&rsquo;s log file is empty. That happens when a build
          was refused before it could write anything — the reason is on the
          Deployment itself rather than in the output.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The note for every close but one: a build that is refused mid-flight is a
 * build that may still be running, and its output is still where it was written.
 *
 * This sentence was exempted from `LogRefusal`'s gate by name and was lost when
 * it went through `hint` anyway, so it is kept byte-identical —
 * `deployment-log.test.tsx` asserts it on a `4003` and on a `4010`.
 */
const BUILD_NOTE =
  "The build may still be running — its output is written on the build Server and read from there.";

/**
 * The note for a reaped log, which is the half of ADR-0020's sentence the close
 * frame could not carry.
 *
 * **What broke first.** {@link BUILD_NOTE} was the only note this view had, and
 * log retention gave the socket a close it is false on: past ADR-0020's window
 * the log has been deleted, so the build is not still writing to it and there
 * is nothing on the build host left to read. The console printed it directly
 * under `reapedLogCloseReason`'s sentence, which says the log was deleted for
 * being past the retention window — one panel making two contradictory claims
 * about one file, which is the shape the backend had just had removed.
 *
 * **Why this is not simply the route's notice repeated, and why the two
 * sentences differ in length.** RFC 6455 §5.5 leaves a close frame's reason
 * **123 bytes** and `ws` *throws* rather than truncating, so the backend could
 * not put `reapedLogNotice`'s 149 on the wire; `closeFrameReason` elides it at
 * a word boundary, and what falls off the end is measured rather than guessed —
 * the reason arrives as *"… keeps deployment logs for 90 days and this…"*,
 * keeping the window rule and losing the clause that says **this** Deployment
 * is past it. So "make the two paths identical" was never available. This
 * sentence is chosen to complete the one the operator actually reads: the
 * window rule comes off the wire, the clause the cap cut is supplied here, and
 * the HTTP path's body says both halves on its own. Consistent, not identical.
 *
 * **Rejected: dropping the note on a `4013`.** The elided reason ends
 * mid-clause, so a panel with nothing under it leaves an operator holding a
 * rule about 90 days and no statement that it applied to them. Also rejected:
 * a second sentence restating the window here, which is
 * `UNREACHABLE_CLOSE_CODE`'s recorded argument and ADR-0020's — a second copy
 * of a retention number is the thing that goes stale. This names no number.
 */
const REAPED_NOTE =
  "This Deployment is older than that window, so its log has been deleted from the build host and is not coming back. The Deployment itself is kept — retention reaps the log, never the record — so the status and timings above are what is left of this build.";

/**
 * Which of the two notes a close deserves.
 *
 * A lookup on the code rather than on `reason`, for `isUnreachableHost`'s
 * reason: the reason is prose the backend may re-word, the code is the contract.
 * A `switch` would be ceremony at two branches, and the default is deliberately
 * {@link BUILD_NOTE} rather than nothing — a close code this console has no
 * words for yet is still a close on a build that may be running.
 */
function refusalNote(code: number | null): string {
  return code === REAPED_LOG_CLOSE_CODE ? REAPED_NOTE : BUILD_NOTE;
}

/** What the socket is doing, in words. `--tx-3` because it is not the content. */
const CONNECTION: Record<SocketStatus, string> = {
  connecting: "Connecting to the build…",
  open: "Streaming",
  closed: "Stream closed",
  refused: "Stream refused",
  reconnecting: "Reconnecting…",
  blocked: "Not connected",
};
