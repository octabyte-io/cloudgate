import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import type { StatusKey } from "@/lib/design/status";
import {
  BLOCKED_SENTENCE,
  LEASE_CLOSE_CODE,
  NO_SHELL_CLOSE_CODE,
  TERMINAL_CLOSE,
  type TerminalStream,
} from "@/lib/realtime/gateways";
import {
  COULD_NOT_CONNECT,
  NO_LONGER_AUTHORIZED,
  refusalSentence,
} from "@/lib/realtime/refusal";

/**
 * What the session is doing, and the way back when it has ended.
 *
 * A terminal that has closed has to say so where the cursor was: a shell whose
 * remote process exited looks exactly like one sitting idle, and the difference
 * decides whether typing does anything at all. `closeReason` is the gateway's own
 * words on a refusal — a missing SSH key, an invalid container id — which is more
 * use than any sentence written here.
 *
 * `noun` is what the far end is called: a Server, the platform host, or a
 * container. The component is shared by both branches and used to write "the
 * Server" into the copy, so a session on the machine Cloudgate runs on said
 * "The Server refused this session" under a card whose header says that machine
 * has no Server row. The word comes from the target now — `terminal.tsx`'s
 * `targetNoun`.
 */
export function TerminalStatus({
  stream,
  footer,
  noun,
}: {
  stream: TerminalStream;
  footer?: React.ReactNode;
  /** What to call the far end — `terminal.tsx`'s `targetNoun`. */
  noun: string;
}) {
  const { status, closeReason, closeCode, reconnect, shellOpen } = stream;

  const sentence =
    status === "open"
      ? shellOpen
        ? footer
        : `Opening a shell on ${noun}.`
      : status === "connecting"
        ? "Connecting."
        : status === "reconnecting"
          ? "The connection dropped. Trying again."
          : status === "refused"
            ? refusalSentence(closeReason, closeCode, noun)
            : status === "blocked"
              ? `${BLOCKED_SENTENCE} Nothing was sent to ${noun}.`
              : // A reason on a clean close is the console's own: the
                // session was ended here (`TERMINALS_ENDED_REASON`).
                `${closeReason ?? "This session has ended"}. Nothing you type now reaches ${noun}.`;

  // No "Connect again" on `blocked`: the browser refuses the same address the
  // same way every time, so the button could only ever fail. Nor on an
  // image with no shell, for the same reason — the sentence above says a second
  // dial ends the same way, and the dialog's own Close is beside it.
  const ended =
    status === "closed" ||
    (status === "refused" && closeCode !== NO_SHELL_CLOSE_CODE);

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel-2 px-3.5 py-2.5">
      <p className="min-w-0 flex-1 text-meta text-tx-2 wrap-anywhere">
        {sentence}
      </p>
      {ended ? (
        <Button size="xs" variant="pri" onClick={reconnect}>
          <Icon name="refresh" size={13} />
          Connect again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * What happened to the session, in the console's own status words.
 *
 * This used to be `running` while the socket was open and `idle` otherwise, so a
 * refused dial, a key the far end would not take and a shell that exited all
 * wore the grey "idle" of a session that had not started — over a status line
 * saying the connection failed. `idle` is kept for exactly that one case now: a
 * store that has not dialled, which is `closed` with no code.
 *
 * A clean `1000` is the one close that went right — both gateways send it when
 * the shell ends — so it is `done`. Every other close is `error`: the whole
 * `refused` band, a socket the browser would not build, and a `1005` or a spent
 * backoff, which is a gateway hanging up without a word (an unowned Server id,
 * an unauthenticated caller, an SSH error in a container) or a transport that
 * would not come back.
 */
export function sessionStatus({
  status,
  closeCode,
  closeReason,
  shellOpen,
}: Pick<
  TerminalStream,
  "status" | "closeCode" | "closeReason" | "shellOpen"
>): StatusKey {
  switch (status) {
    case "open":
      // The socket opens before the SSH handshake; the gateway says when the
      // shell is. Until then this is still a dial.
      return shellOpen ? "running" : "pending";
    case "connecting":
    case "reconnecting":
      return "pending";
    case "refused":
    case "blocked":
      return "error";
    case "closed":
      // No code but a reason: the console ended it, which is a
      // finished session, not one that never dialled.
      if (closeCode === null) return closeReason ? "done" : "idle";
      return closeCode === TERMINAL_CLOSE.shellClosed ? "done" : "error";
  }
}

/**
 * How a session ended, in a few words for a line with no room for the status
 * sentence — the minimised Dock's header bar. `null` while it has not.
 *
 * The Dock can stay minimised for far longer than a dialog stayed open, so a
 * shell that exited, lost its lease or lost its machine behind the bar must
 * not look like one sitting idle; the full sentence is under the well once the
 * Dock is restored. The lease's own words lead, because it is the ending an
 * operator did not cause (ADR-0012).
 */
export function endedWords({
  status,
  closeCode,
}: Pick<TerminalStream, "status" | "closeCode">): string | null {
  if (status === "refused" && closeCode === LEASE_CLOSE_CODE) {
    return NO_LONGER_AUTHORIZED;
  }
  if (status === "refused" || status === "blocked") return COULD_NOT_CONNECT;
  if (status === "closed" && closeCode !== null) {
    return closeCode === TERMINAL_CLOSE.shellClosed
      ? "The shell exited"
      : "Disconnected";
  }
  return null;
}
