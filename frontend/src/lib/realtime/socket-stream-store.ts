import { WS_ORIGIN } from "@/lib/config";

import { LineBuffer } from "./line-buffer";
import { reconnectedLine, type HeldLines } from "./log-resume";

/**
 * One WebSocket, owned outside React.
 *
 * The backend runs `@nestjs/platform-ws` — plain `ws`, no socket.io — so this is
 * a bare `WebSocket` with the reconnect and teardown all six gateways need
 * written once. Turning frames into lines is `LineBuffer`'s job.
 * `useSocketStream` subscribes to this through `useSyncExternalStore`; nothing
 * here touches React.
 *
 * All six send text frames only (every `ws.send` in
 * `backend/src/realtime/gateways/` is handed a string, including
 * `/listen-server-setup`, whose replay buffer is a `string[]`), so a frame is a
 * string.
 */

export type SocketStatus =
  /** Dialling for the first time. */
  | "connecting"
  /** Connected. */
  | "open"
  /** Dropped mid-stream; backing off before trying again. */
  | "reconnecting"
  /** Finished, nothing to connect to, or the backoff ran out. Not an error. */
  | "closed"
  /** The gateway rejected the connection and will reject it again. */
  | "refused"
  /**
   * The browser would not construct the socket at all, so no gateway was asked
   * — see `dial`.
   * Its own state rather than `closed` or `refused`, because every card words
   * those as a stream that ended and as the gateway's decision, and this is
   * neither. Say it with {@link BLOCKED_SENTENCE}.
   */
  | "blocked";

export interface SocketStreamSnapshot {
  status: SocketStatus;
  /** Committed lines plus, last, whatever has arrived of the current one. */
  lines: readonly string[];
  /** Whether the view should stay pinned to the newest output. */
  following: boolean;
  /** The gateway's own words when it refused. */
  closeReason: string | null;
  /**
   * The code the socket last closed with, `null` until it has closed once since
   * it was last dialled. On a `refused` stream it is the 4xxx code it refused
   * with, which is what says *when* the refusal happened: `4000`/`4003` are decided at connect, `4010` is a stream that was
   * already running (`LEASE_CLOSE_CODE`). A screen that appends its own hint to
   * `closeReason` needs the difference — the two kinds of refusal have no
   * explanation in common.
   */
  closeCode: number | null;
  /** Lines dropped off the front to stay under the cap. */
  dropped: number;
  /**
   * Which of `lines`, by index, are the store's own rather than the source's:
   * where a redial that kept its lines picked up again (`setResume`).
   */
  marked: readonly number[];
}

const EMPTY: SocketStreamSnapshot = {
  status: "closed",
  lines: [],
  following: true,
  closeReason: null,
  closeCode: null,
  dropped: 0,
  marked: [],
};

/**
 * How a backoff redial keeps the lines it holds rather than starting over
 * (`log-resume.ts` has one per kind of log).
 */
export interface LogResume {
  /** Added to the redial, worked out from the whole lines held. */
  params?: (held: readonly string[], now: number) => DialParams | null;
  /**
   * Which lines the redial sends again: given the whole lines held and how
   * many of the source's lines were taken in, dropped ones included.
   */
  held: (held: readonly string[], received: number) => HeldLines;
}

/** Bursts of output coalesce into one render. Not `requestAnimationFrame` —
 * that stops firing in a background tab, and a build left running in another
 * tab must still be there when you come back to it. */
const FLUSH_MS = 60;

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * The one 4xxx code that is **not** a verdict on the connection: the socket
 * connected, passed, streamed, and then its authorization lease ended
 * (`backend/src/realtime/socket-access.ts`'s `LEASE_CLOSE_CODE`, ADR-0012).
 *
 * It sits here rather than in a screen because the difference it carries is the
 * same on every screen: a connect-time refusal can be explained by the target not
 * being there yet, and this one never can — it is a stream that was working.
 */
export const LEASE_CLOSE_CODE = 4010;

/**
 * What every card says first about a `blocked` stream, before its own clause
 * about what is unaffected. The cause named is the one that has been seen: an
 * https console whose `NEXT_PUBLIC_API_URL` is http, which the browser refuses
 * to dial from a secure page.
 */
export const BLOCKED_SENTENCE =
  "This browser would not open the live connection — an https console with an http API address does this.";

export class SocketStreamStore {
  private snapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  private socket: WebSocket | null = null;
  private url: string | null = null;
  private attempt = 0;
  /**
   * Query parameters for the next dial only — see {@link reconnectOnce}. Taken
   * by `dial()` and cleared there, so a backoff redial never carries them.
   */
  private onceParams: DialParams | null = null;
  /**
   * Set by a backoff redial: keep the lines on screen until the new socket says
   * something. See `handleClose`.
   */
  private resetOnFirstFrame = false;
  /** Asked at each backoff redial whether to keep the lines — see `setResume`. */
  private resume: (() => LogResume | null) | null = null;
  /** Set by a redial that keeps its lines, until its socket opens. */
  private resuming: LogResume | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly buffer: LineBuffer;

  /** Set while frames should bypass the line buffer. */
  private frameHandler: ((frame: string) => void) | undefined;

  /** `cap` is fixed for the store's life — see `useSocketStream`. */
  constructor(cap: number) {
    this.buffer = new LineBuffer(cap);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SocketStreamSnapshot => this.snapshot;

  /** There is no socket on the server, so the stream is simply not open yet. */
  getServerSnapshot = (): SocketStreamSnapshot => EMPTY;

  /**
   * Send frames somewhere other than the line buffer — a terminal emulator, or a
   * JSON parser. Swappable without touching the connection: an emulator that
   * mounts after the socket opened must not cost a redial.
   */
  setFrameHandler = (handler: ((frame: string) => void) | undefined): void => {
    this.frameHandler = handler;
  };

  /**
   * Have a backoff redial keep the lines held instead of starting over:
   * it asks for what `resume` says, puts a marked line where it picked up, and
   * skips what it is sent again. Asked at each redial, so the answer can change
   * with who holds the log — a Docked log keeps its lines, a page box does not.
   * Only backoff redials: `reconnect` and a new target still start from empty.
   */
  setResume = (resume: (() => LogResume | null) | null): void => {
    this.resume = resume;
  };

  /**
   * Point at a gateway, or at `null` to hold the connection closed.
   *
   * `once` is added to the first dial to `url` and to no dial after it — what
   * `/listen-server-setup` needs for its start flag (ADR-0058): a backoff redial
   * is never the operator's press.
   */
  open = (url: string | null, once?: DialParams): void => {
    this.disposed = false;
    this.url = url;
    this.attempt = 0;
    this.onceParams = url ? (once ?? null) : null;
    if (!url) {
      this.emit({ status: "closed" });
      return;
    }
    this.emit({ status: "connecting", closeReason: null, closeCode: null });
    this.dial();
  };

  /** Unmount, or a change of target. Nothing reconnects after this. */
  close = (): void => {
    this.disposed = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  };

  /** Terminals, and the container-logs pty the gateway forwards input to. */
  send = (data: string): boolean => {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(data);
    return true;
  };

  setFollowing = (following: boolean): void => {
    if (this.snapshot.following === following) return;
    this.emit({ following });
  };

  /** Throw away what has been received. The connection stays up. */
  clear = (): void => {
    this.buffer.reset();
    this.emit({ lines: [], dropped: 0, marked: [] });
  };

  /** Try again now, from the top of the backoff. */
  reconnect = (): void => {
    this.reconnectOnce();
  };

  /**
   * {@link reconnect}, with `params` added to this one dial and not to any
   * backoff redial after it. A separate method rather than an argument to
   * `reconnect`, which is handed straight to `onClick` and would read the click
   * event as parameters.
   */
  reconnectOnce = (params?: DialParams): void => {
    this.onceParams = params ?? null;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.attempt = 0;
    if (!this.url) return;
    this.emit({ status: "connecting", closeReason: null, closeCode: null });
    this.dial();
  };

  private dial(options: { keepLines?: boolean } = {}): void {
    if (!this.url || this.disposed) return;
    let url = withParams(this.url, this.onceParams);
    this.onceParams = null;

    // A redial that keeps its lines (`setResume`): it may ask for less than
    // the page did, and once open it marks where it picked up and skips what
    // the gateway sends again. Nothing is reset, now or on its first frame.
    const resume = options.keepLines ? (this.resume?.() ?? null) : null;
    this.resuming = resume;
    if (resume) {
      url = withParams(
        url,
        resume.params?.(this.buffer.wholeLines(), Date.now()) ?? null,
      );
    }

    // Start from empty on every dial, including a reconnect. The log gateways
    // replay before they follow — `/listen-deployment` runs `tail -n +1 -f`, and
    // `/docker-container-logs` passes `--tail`. Keeping the old lines would show
    // the whole log twice after any drop.
    //
    // A backoff redial empties the buffer on its first frame rather than here:
    // the replay that frame begins makes the result the same, and a redial that
    // ends without one — `/listen-server-setup` finding its run already over
    // (ADR-0058) — keeps the lines it had instead of wiping them on the way out.
    // A redial with a `resume` (a Docked log) never empties: it skips
    // the replay's held lines instead (`pickUp`).
    this.resetOnFirstFrame = options.keepLines === true && !resume;
    if (options.keepLines !== true) {
      this.buffer.reset();
      this.emit({ lines: [], dropped: 0, marked: [] });
    }

    // **The constructor can throw, and nothing above this would catch it**
    // A console
    // served over `https://` with a `ws://` `NEXT_PUBLIC_API_URL` gets a
    // synchronous `SecurityError` here — not a failed connection, so there is no
    // `close` event and none of the handling below runs. `open()` is called from
    // an effect, so the throw reached the error boundary and took every other
    // control on the screen with it, Stop and the stored log included.
    //
    // It becomes `blocked`, a state of its own that every card has words for,
    // and not the backoff: the same URL is refused the same way every time (the
    // origin is baked into the bundle), so a retry would only be the throw
    // again. `reconnect()` still dials, and lands back here.
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.emit({ status: "blocked" });
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      if (this.socket === socket && this.resuming) this.pickUp(this.resuming);
      this.emit({ status: "open" });
    };

    socket.onmessage = (event: MessageEvent<unknown>) => {
      // **A superseded socket must not write into this buffer** — the other half
      // of the defect the reset above fixes, found by F12 driving a compose
      // deploy and seeing all 175 lines of the log twice.
      //
      // `close()` clears `this.socket` and calls `socket.close()`, but a socket
      // that is still CONNECTING does not stop existing on the spot: the gateway
      // may have accepted it and started replaying (`tail -n +1 -f`) before the
      // close lands. Those frames used to arrive here, *after* the next dial had
      // reset the buffer, and every line ended up in it twice. React's
      // development double-mount makes that the common case rather than a race,
      // and so does any change of target — one Deployment's log to another's.
      if (this.socket !== socket || this.disposed) return;
      if (typeof event.data !== "string") return;
      if (this.resetOnFirstFrame) {
        this.resetOnFirstFrame = false;
        this.buffer.reset();
      }
      if (this.frameHandler) {
        this.frameHandler(event.data);
        return;
      }
      this.append(event.data);
    };

    socket.onclose = (event: CloseEvent) => {
      // A stale socket's close is not this store's business either: it must not
      // start the backoff for a connection nothing is listening to.
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.disposed) return;
      this.flush();
      this.handleClose(event);
    };
  }

  /**
   * A 4xxx code is the gateway saying the request itself was wrong — a bad
   * container id, a missing `logPath`. Redialling asks the same wrong question.
   *
   * A clean 1000 means the stream ended: `tail` reached the end of a finished
   * build, or the shell exited. Redialling would replay the whole log.
   *
   * That leaves the transport actually dropping, which is the one case worth
   * retrying. (A gateway also closes cleanly when the session is not valid, and
   * it sends no code to say so — an unauthenticated socket is indistinguishable
   * from a finished one here.)
   */
  private handleClose(event: CloseEvent): void {
    if (event.code >= 4000 && event.code < 5000) {
      this.emit({
        status: "refused",
        closeReason: event.reason || null,
        closeCode: event.code,
      });
      return;
    }
    // The code travels with a clean close too, and the reason does not: every
    // log card reads a reason as a refusal, but a terminal's pill has to tell a
    // shell that exited (`1000`) from a gateway that hung up without a word and
    // from a store that never dialled at all.
    if (event.code === 1000 || event.code === 1005) {
      this.emit({ status: "closed", closeCode: event.code });
      return;
    }
    const delay = BACKOFF_MS[this.attempt];
    if (delay === undefined) {
      this.emit({ status: "closed", closeCode: event.code });
      return;
    }
    this.attempt += 1;
    this.emit({ status: "reconnecting" });
    // Jittered, so a backend restart does not bring every open tab back at once.
    this.retryTimer = setTimeout(
      () => this.dial({ keepLines: true }),
      delay + Math.random() * 250,
    );
  }

  /**
   * A redial that kept its lines is through: the half line it had goes (the
   * gateway sends it again whole), a marked line says where it picked up, and
   * what the gateway sends again of what is held is skipped. Marked once the
   * socket opens rather than at the dial, so a redial that fails and backs off
   * again leaves no line of its own.
   */
  private pickUp(resume: LogResume): void {
    this.resuming = null;
    this.buffer.dropPartial();
    const held = resume.held(this.buffer.wholeLines(), this.buffer.received());
    this.buffer.mark(reconnectedLine(new Date()));
    this.buffer.skipHeld(held);
    this.flush();
  }

  /** Buffer a frame, and schedule one render for however many arrive next. */
  private append(chunk: string): void {
    if (!this.buffer.push(chunk)) return;
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.emit({
      lines: this.buffer.lines(),
      dropped: this.buffer.dropped(),
      marked: this.buffer.marked(),
    });
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.retryTimer = null;
    this.flushTimer = null;
  }

  private emit(change: Partial<SocketStreamSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
}

/** Query parameters as `gatewayUrl` takes them. */
export type DialParams = Record<
  string,
  string | number | boolean | undefined | null
>;

/** `url` with `params` set on its query, by the same rules as `gatewayUrl`. */
function withParams(url: string, params: DialParams | null): string {
  if (!params) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

/** A gateway URL. `undefined` and `null` parameters are left off entirely. */
export function gatewayUrl(path: string, params?: DialParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return `${WS_ORIGIN}${path}${query ? `?${query}` : ""}`;
}
