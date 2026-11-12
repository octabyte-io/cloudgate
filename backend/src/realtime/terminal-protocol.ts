import type { StreamChannel } from './channels/stream-channel';
import type { WsClient } from './ws-client';

/**
 * # The terminal socket protocol
 *
 * Read this before changing either terminal gateway.
 *
 * **Server → browser is raw bytes and nothing else.** Whatever the pty emits is
 * forwarded verbatim; there is no envelope in that direction and there must not
 * be one, because a program is free to print any byte at all, the reserved one
 * included. Anything the browser needs to know that is not terminal output
 * belongs on a different channel, not in the stream.
 *
 * **Browser → server is raw terminal input, with exactly one exception.** A frame
 * whose first byte is NUL (`\x00`) *and* whose remainder is a small JSON object
 * is a **control frame**; it never reaches the shell. Everything else is input
 * and is written through untouched.
 *
 * ```text
 * \x00{"cols":120,"rows":40}   → channel.resize(120, 40)
 * \x00{"cols":0,"rows":-1}     → dropped: addressed to the protocol, unhonourable
 * anything else                → channel.write(frame)
 * ```
 *
 * The reserved byte is safe in this direction and only in this direction. NUL is
 * not a printable key, but it *is* what a terminal sends for Ctrl-Space (Ctrl-@),
 * which emacs users press constantly — so a frame is control only if the whole of
 * it matches the shape, not just the first byte. A bare `\x00`, a NUL followed by
 * anything that is not a JSON object, and a paste too long to be a control frame
 * are all still input. The only string this eats that a person could have meant
 * is a literal `\x00{…}` typed or pasted as one frame, which no keyboard produces.
 *
 * `cols`/`rows` arrive from a browser and are handed to ssh2 and node-pty, so
 * they are validated as positive integers inside a plausible window. A control
 * frame that fails that check is dropped rather than clamped *and* rather than
 * typed: the client meant to speak the protocol, so its bytes are not the
 * operator's keystrokes, but its numbers are not a window either.
 */

/** The reserved first byte. Only ever read on frames coming *from* a browser. */
export const CONTROL_FRAME_PREFIX = '\x00';

/**
 * The one frame either terminal gateway sends *to* a browser that is not
 * terminal bytes: the shell is open.
 *
 * The console's pill read the WebSocket being open as `running`, and the
 * socket opens before the SSH handshake has even started — so a Server that
 * never answers wore a green "running" for the 20–30 s the dial takes, above
 * "Connecting...". This is sent once, the moment the channel exists and before
 * any of its bytes, so the console holds `pending` until it arrives.
 *
 * Safe to look for without ever inspecting output, because of *when* it is
 * sent: nothing from a pty can reach the socket before the channel it comes
 * from exists, so a client reads frames for it only until it has seen it and
 * never after. Mirrored in `frontend/src/lib/realtime/terminals.ts`, pinned
 * from `server-terminal-close.spec.ts`.
 */
export const SHELL_OPEN_FRAME = `${CONTROL_FRAME_PREFIX}{"shell":"open"}`;

/**
 * Bounds on a window. The floor is the smallest grid a terminal can be; the
 * ceiling is far past any real display (a 1000-column monospace grid is some
 * 8000 physical pixels) and exists only so a hostile client cannot ask a pty for
 * an absurd allocation.
 */
export const MIN_TERMINAL_COLS = 1;
export const MAX_TERMINAL_COLS = 1000;
export const MIN_TERMINAL_ROWS = 1;
export const MAX_TERMINAL_ROWS = 1000;

/** Longest frame worth inspecting as control. A resize is ~25 bytes; a paste is
 *  unbounded, and must not be run through JSON.parse to find that out. */
const MAX_CONTROL_FRAME_LENGTH = 128;

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * The size a session starts at when the client has not said otherwise — ssh2's
 * and node-pty's own default, named here so the gateways state it rather than
 * inherit it silently.
 */
export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };

/** What one frame from a browser turns out to be. */
export type TerminalFrame =
  /** Keystrokes, a paste, an escape sequence — write it to the channel. */
  | { kind: 'input'; data: string }
  | { kind: 'resize'; size: TerminalSize }
  /** A control frame this cannot act on. Not input; goes nowhere. */
  | { kind: 'unhonoured-control' };

const isWindowDimension = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

/** Whether a frame is addressed to the protocol at all, and its payload if so. */
function readControlPayload(frame: string): Record<string, unknown> | null {
  if (!frame.startsWith(CONTROL_FRAME_PREFIX)) return null;
  if (frame.length > MAX_CONTROL_FRAME_LENGTH) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.slice(CONTROL_FRAME_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** What the gateway should do with one frame a browser sent. */
export function readTerminalFrame(frame: string): TerminalFrame {
  const payload = readControlPayload(frame);
  if (!payload) return { kind: 'input', data: frame };

  const { cols, rows } = payload;
  if (
    !isWindowDimension(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS) ||
    !isWindowDimension(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
  ) {
    return { kind: 'unhonoured-control' };
  }
  return {
    kind: 'resize',
    size: { cols: cols as number, rows: rows as number },
  };
}

export interface InitialSizeCapture {
  /**
   * The size to open the channel at: the last one asked for so far, if any.
   * Read it once, as the channel is opened — `handOver` compares against it.
   */
  take(): TerminalSize | undefined;
  /**
   * Stop listening, and give the channel any size asked for after `take`. Call
   * it once the channel exists, immediately before bridging it.
   */
  handOver(channel: StreamChannel): void;
}

/**
 * Watches a socket for resize control frames before its channel exists.
 *
 * Both gateways `await` a channel — an SSH connection takes as long as it takes
 * — and a browser sends its size the moment the socket opens. Without a listener
 * in place for that window the first resize is simply dropped by `ws` and the
 * session keeps the default size for its whole life. So the size is
 * captured here and handed to the channel as the pty's *initial* window.
 *
 * **The window has two ends, and the frame can land in either.** A gateway whose
 * checks are quick reaches the dial — and `take`s the size — before the browser
 * has even seen its upgrade answered, so the frame arrives *during* the
 * handshake. That is `/terminal`'s ordinary case, and it opened every Server
 * shell at 80 × 24 because the capture was then simply stopped. So a size
 * that arrived after `take` is not lost: `handOver` gives it to the channel as
 * its first resize, before the bridge takes the socket over.
 *
 * Input frames arriving this early are not buffered: there is nothing to type
 * into yet, and replaying keystrokes into a shell that appeared later is worse
 * than losing them.
 */
export function captureInitialSize(ws: WsClient): InitialSizeCapture {
  let listening = true;
  let latest: TerminalSize | undefined;
  let taken: TerminalSize | undefined;
  ws.on('message', (message) => {
    if (!listening) return;
    const frame = readTerminalFrame(message.toString());
    if (frame.kind === 'resize') latest = frame.size;
  });
  return {
    take: () => (taken = latest),
    handOver: (channel) => {
      listening = false;
      // Each frame is a fresh object, so identity says whether one arrived
      // after `take` — and a repeat of the same size costs one no-op resize.
      if (latest && latest !== taken) {
        channel.resize?.(latest.cols, latest.rows);
      }
    },
  };
}

/**
 * The browser → channel half of a terminal session: control frames resize the
 * pty, everything else is typed into it.
 */
export function bridgeTerminalInput(
  ws: WsClient,
  channel: StreamChannel,
): void {
  ws.on('message', (message) => {
    const frame = readTerminalFrame(message.toString());
    try {
      if (frame.kind === 'input') {
        channel.write(frame.data);
      } else if (frame.kind === 'resize') {
        // A transport with no window (a child process without a pty) has no
        // resize to call; the frame is still not input, so it goes nowhere.
        channel.resize?.(frame.size.cols, frame.size.rows);
      }
    } catch (error) {
      ws.send((error as Error).message);
    }
  });
}

/**
 * `/terminal`'s whole close-code contract, kept beside the
 * protocol because `/docker-container-terminal` shares its `shellClosed`.
 *
 * Every one of these used to be a bare `ws.close()`, or no close at all. A bare
 * close is `1005` with an empty reason, which a browser cannot tell from a proxy
 * dropping the connection — and the frontend's socket store reads a 4xxx as
 * `status: "refused"` and shows the reason, so saying nothing threw away the
 * only channel that existed for saying anything. (It used to render every one of
 * them as the single sentence "The Server refused this session"; `4500`–`4502`
 * are dials that *failed* rather than refusals, so the console now keeps one
 * sentence per code and gets the noun from the target.)
 *
 * 4400 rather than the 4000 the validator gateways use: those close *before*
 * authentication on a malformed parameter, and this one refuses an authenticated
 * caller whose request cannot be served. 4003 is not reused either — that is
 * `socket-access.ts`'s single denial frame, deliberately byte-identical across
 * every way a caller can be refused an id, and none of these are that; the
 * codes here read as their HTTP statuses with a 4000 offset, which is why the
 * one refusal this gateway does make in its own words is 4403 rather than a
 * second spelling of 4003 (ADR-0010).
 */
export const TERMINAL_CLOSE = {
  /** The request was wrong and will be wrong again: no serverId, or a local
   *  terminal without the port and username it cannot be opened without. */
  badRequest: 4400,
  /** The caller may not open a shell on the platform host (ADR-0010). Only the
   *  local branch closes with this; the Server branch's denial stays the silent
   *  codeless close every gateway uses for an id that may not be the caller's. */
  forbidden: 4403,
  /** The SSH channel could not be opened, or died after it was. */
  sshFailed: 4500,
  /** SSH refused the key. The frame before it says what to run. */
  authFailed: 4501,
  /** There is no key to dial with: none configured on the Server, or none this
   *  host could generate for its own local terminal. */
  keyUnavailable: 4502,
  /** The shell ended. Nothing went wrong. */
  shellClosed: 1000,
} as const;

/**
 * A close reason is at most 123 bytes on the wire (RFC 6455 §5.5), and `ws`
 * throws rather than truncating. An ssh2 error message is written by the remote
 * end and has no such bound, so it is cut here — with the cut said out loud, and
 * any half-written multi-byte character at the boundary dropped.
 */
export function terminalCloseReason(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= 123) return text;
  return `${bytes
    .subarray(0, 120)
    .toString('utf8')
    .replace(/\uFFFD+$/, '')}…`;
}
