import type { LogEnding } from "./live-log";
import { LEASE_CLOSE_CODE } from "./socket-stream-store";
import type { SocketStreamSnapshot } from "./socket-stream-store";
import {
  DENIED_CLOSE_CODE,
  MALFORMED_CLOSE_CODE,
  NO_SHELL_CLOSE_CODE,
  TERMINAL_CLOSE,
  UNREACHABLE_CLOSE_CODE,
} from "./terminals";

/**
 * A refused socket in words: the sentence a shell's status line says
 * (`TerminalStatus`), and how a Docked log ends when it loses access.
 *
 * Here rather than beside `TerminalStatus` because a Live log — which lives in
 * `lib/realtime`, outside React — ends itself on a refusal once docked, and
 * says so in the same words a Docked shell does (ADR-0012).
 */

/**
 * A refusal, in the tense and the kind it happened in.
 *
 * **One sentence used to cover the whole 4xxx band.** "The Server refused this
 * session" is the connect-time frame's story, and `socket-stream-store.ts` maps
 * every code from 4000 to 4999 to `status: "refused"` — so a `4500` SSH dial
 * that failed, a `4501` key the host would not accept and a `4502` key that was
 * never generated all wore a refusal's words, and a request the gateway threw
 * out for being malformed wore them too. An operator was told the machine
 * refused them when the machine had never been reached, and told the machine
 * could not be reached when their own role was the answer (the `4010` half was
 * fixed first).
 *
 * Grouped by *kind* rather than by code on purpose: a new close code added to
 * either gateway lands in one of these classes, and the `default` is the honest
 * sentence for one that does not — the gateway's own words, with no claim about
 * what happened bolted onto them.
 *
 * That default is why the missing `4012` was quiet rather than broken:
 * an unreachable machine's socket fell through it and quoted the gateway, which
 * was true and carried no tense — so an operator could not tell a session that
 * was refused from one that was never opened. A seventh class, not a seventh
 * sentence for the same class.
 *
 * `reason` is always the gateway's own text and is never rewritten here
 * (ADR-0012 §18). What these sentences add is the tense and the actor.
 */
export function refusalSentence(
  reason: string | null,
  code: number | null,
  noun: string,
): string {
  const said = reason ?? null;

  switch (code) {
    case LEASE_CLOSE_CODE: {
      // The gateway's own reason is the first sentence — ADR-0012 §18's promise
      // — and what a reader needs after it is the tense, not a second way of
      // saying the same thing.
      const lead = said ?? "This session is no longer authorized";
      return `${lead}. The access it was opened with ended while the session was open — connecting again is authorized from scratch.`;
    }

    case TERMINAL_CLOSE.forbidden:
      // ADR-0010: `local` is not an id, so this refusal says why. The second
      // clause is the whole point of the issue — an operator refused by their
      // role was being told the machine was unreachable.
      return `${said ?? "This session was refused"}. That is a decision about your role on this instance, not a problem with ${noun}.`;

    case DENIED_CLOSE_CODE:
      // Byte-identical across not-entitled, unknown id and an ambiguous
      // resolution (ADR-0008). Saying so is better than implying the target
      // exists, and the policy is public.
      return `${said ?? "Not found or not permitted"}. Cloudgate answers the same way for a target that does not exist and one this session may not reach.`;

    case UNREACHABLE_CLOSE_CODE:
      // The pair to the case above, and the one it used to be answered by
      // a socket for a container on a machine nothing spoke to closed
      // 4003, so an operator read the sentence directly above — an
      // authorization claim — about a resolution that never ran.
      //
      // The gateway's reason here is `rethrowIfHostUnreachable`'s own sentence,
      // so it already names the right machine, a Server or the platform host.
      // What it cannot carry is the **tense**, which is what this adds
      // and what tells this apart from a denial: nothing was judged, because
      // nothing was reached. `noun` stays out of the lead for that reason — the
      // reason is more specific about which machine than the noun is.
      return `${said ?? "That Server, or the platform host, could not be reached"}. Nothing was judged: the session never opened, so this says neither that your access was refused nor that the container is gone.`;

    case TERMINAL_CLOSE.badRequest:
    case MALFORMED_CLOSE_CODE:
      return said
        ? `Cloudgate would not open this session: ${said}. Opening it again with the same values will end the same way.`
        : "Cloudgate would not open this session: the request was incomplete.";

    case TERMINAL_CLOSE.sshFailed:
      return said
        ? `Cloudgate could not hold an SSH connection to ${noun}: ${said}`
        : `Cloudgate could not hold an SSH connection to ${noun}.`;

    case TERMINAL_CLOSE.authFailed:
      // True on both branches: the gateway writes the eight-line
      // `authorized_keys` block for `local` and the key/username sentence for a
      // Server, in the frame immediately before this close.
      return `${noun} did not accept the key Cloudgate signed in with${said ? `: ${said}` : ""}. What to run to fix that is printed above the cursor.`;

    case TERMINAL_CLOSE.keyUnavailable:
      return said
        ? `Cloudgate has no SSH key to reach ${noun} with: ${said}`
        : `Cloudgate has no SSH key to reach ${noun} with.`;

    case NO_SHELL_CLOSE_CODE:
      // The container's own refusal is the line above the cursor — an OCI
      // runtime error nobody should have to read to learn this. The
      // gateway's reason names the shell it asked for; what this adds is that
      // the image, not the session, is why.
      return `${said ?? "This image has no shell to open"}. Some images carry none at all — distroless ones, and those built from scratch — so connecting again will end the same way.`;

    default:
      // An unmapped 4xxx: quote the gateway and claim nothing.
      return said ?? "This session ended without a reason.";
  }
}

/**
 * The end word a refusal leaves: the lease's own words when access ended,
 * else "Could not connect" — what a Docked shell's tab says (`endedWords`),
 * so a shell and a log that lost the same access say it alike.
 */
export const NO_LONGER_AUTHORIZED = "No longer authorized";
export const COULD_NOT_CONNECT = "Could not connect";

/**
 * The refusals that end a Docked log: access that ended mid-stream (`4010`),
 * and a dial — a redial after a drop — refused as not found or not permitted,
 * which is also how a deleted target answers (ADR-0008), forbidden by role,
 * malformed, or about a machine that could not be reached. Each says the next
 * dial ends the same way.
 *
 * Every other 4xxx is a log's own ending with its own words — a reaped
 * Deployment log (`4013`), a container's output ending (`4014`) — and the
 * page that knows it says it.
 */
const ENDS_A_DOCKED_LOG: ReadonlySet<number> = new Set([
  LEASE_CLOSE_CODE,
  DENIED_CLOSE_CODE,
  TERMINAL_CLOSE.forbidden,
  UNREACHABLE_CLOSE_CODE,
  MALFORMED_CLOSE_CODE,
  TERMINAL_CLOSE.badRequest,
]);

/**
 * How a docked socket log ends on a refusal, or `null` when its socket was not
 * refused in a way that ends it: ⊘, the end word a Docked shell's tab would
 * carry, and the sentence its status line would say — the gateway's own words
 * first, then the tense.
 */
export function socketRefusalEnding(
  stream: Pick<SocketStreamSnapshot, "status" | "closeCode" | "closeReason">,
): LogEnding | null {
  const { status, closeCode, closeReason } = stream;
  if (status !== "refused" || closeCode === null) return null;
  if (!ENDS_A_DOCKED_LOG.has(closeCode)) return null;
  return {
    mark: "stopped",
    words:
      closeCode === LEASE_CLOSE_CODE ? NO_LONGER_AUTHORIZED : COULD_NOT_CONNECT,
    sentence: refusalSentence(closeReason, closeCode, "its source"),
    refused: true,
  };
}
