import { useEffect, useState, useSyncExternalStore } from "react";

import { SocketStreamStore, gatewayUrl } from "./socket-stream-store";
import type { SocketStreamSnapshot } from "./socket-stream-store";
import type { SocketStream } from "./use-socket-stream";

/**
 * The two interactive gateways — a shell on a Server, and `docker exec` inside a
 * container. Re-exported from `gateways.ts`; import from there.
 *
 * Both are bidirectional and neither buffers lines: splitting a terminal stream
 * on newlines destroys its escape sequences, so frames go straight to whatever
 * emulator is attached.
 */

// No `reconnectOnce`: a terminal's URL carries nothing that belongs on one dial
// only, and a channel shared with the Dock has no single owner to send it. No
// `log`, `live`, `ending`, `resting` or the follow bar's counts either: a shell
// is a `LiveTerminal`, not a Live log.
export interface TerminalStream extends Omit<
  SocketStream,
  | "reconnectOnce"
  | "log"
  | "live"
  | "ending"
  | "resting"
  | "received"
  | "lastLineAt"
  | "newBelow"
> {
  /**
   * Whether the gateway has said the shell is open. The socket opens
   * before the SSH handshake starts, so `status === "open"` alone is not a
   * running session — this is.
   */
  shellOpen: boolean;
  /** Hand frames to a terminal emulator. Call again to replace the sink. */
  attach: (write: (frame: string) => void) => void;
  /**
   * Tell the gateway how big the window is now. `false` if the socket was not
   * open, in which case say it again when it is — the size is not queued here.
   */
  resize: (cols: number, rows: number) => boolean;
}

/**
 * The terminal socket's one control frame (`terminal-protocol.ts` on the
 * Server).
 *
 * Everything else either end sends is raw terminal bytes, so a resize is told
 * apart from typing by a reserved leading NUL — and only in this direction.
 * Output is never inspected for it, because a program is free to print any byte
 * it likes. The Server treats a NUL that is not followed by a JSON object as the
 * keystroke it is (Ctrl-Space), so this cannot swallow input.
 */
const resizeFrame = (cols: number, rows: number): string =>
  `\x00${JSON.stringify({ cols, rows })}`;

/**
 * The one frame a terminal gateway sends that is not terminal bytes: the shell
 * is open (`SHELL_OPEN_FRAME` in `terminal-protocol.ts` on the Server).
 *
 * The gateway sends it once, the moment its channel exists and before any of
 * that channel's bytes — so it is looked for only until it is seen, and output
 * is never inspected for it after. Pinned against the backend's copy from
 * `backend/test/realtime/server-terminal-close.spec.ts`.
 */
export const SHELL_OPEN_FRAME = '\x00{"shell":"open"}';

/**
 * `/terminal`'s close-code contract, mirrored from
 * `backend/src/realtime/terminal-protocol.ts`'s `TERMINAL_CLOSE`.
 * Duplicated
 * rather than fetched, the way `LEASE_CLOSE_CODE` already is — and pinned
 * against the backend's copy from
 * `backend/test/realtime/server-terminal-close.spec.ts`, so a value that drifts
 * fails a test rather than a sentence.
 *
 * `4500`–`4502` are this gateway's alone: `/docker-container-terminal` runs
 * `docker exec` through a pty and closes `4000`, `4003`, `4010`, `4012`, `4404`
 * ({@link NO_SHELL_CLOSE_CODE}), `1000` when the shell ends, and `1005`.
 *
 * The `4012` was missing from that list rather than from the gateway
 * (the code was added first and this sentence and the mirror left behind,
 * because a mirror assertion would have been red before the backend half
 * existed; both landed later). A stale list here is not a comment that merely
 * rots: it is the inventory `refusalSentence` is written against, so a code
 * missing from it is a close frame nothing has words for.
 */
export const TERMINAL_CLOSE = {
  badRequest: 4400,
  forbidden: 4403,
  sshFailed: 4500,
  authFailed: 4501,
  keyUnavailable: 4502,
  /** The shell ended and nothing went wrong — on both terminal gateways. A
   *  clean close, so the store reports it as `closed` with this `closeCode`. */
  shellClosed: 1000,
} as const;

/**
 * `/docker-container-terminal`'s *"the image has no such shell"* — `docker exec`
 * could not start it, and asking again will not put it there
 * (`CONTAINER_TERMINAL_CLOSE.noShell`, pinned from
 * `backend/test/realtime/container-terminal-close.spec.ts`).
 */
export const NO_SHELL_CLOSE_CODE = 4404;

/** A malformed parameter, from either terminal gateway's validators. */
export const MALFORMED_CLOSE_CODE = 4000;

/** `socket-access.ts`'s one denial frame, byte-identical across every way a
 *  container-addressed socket can be refused (ADR-0008). */
export const DENIED_CLOSE_CODE = 4003;

/**
 * `socket-access.ts`'s *"the machine was never reached"* frame — the carve-out
 * ADR-0008 was amended for.
 *
 * Deliberately **not** {@link DENIED_CLOSE_CODE}, and the distinction is a
 * security argument rather than a nicety: 4003 is byte-identical across
 * not-entitled, unknown container and an ambiguous resolution, because a caller
 * who can tell those apart can walk another organization's id space.
 * That rule governs the outcome of a resolution that *ran* — a transport
 * failure is answered before one, so no id was looked up and no label was read,
 * and this frame discloses nothing. Without it an unreachable machine's
 * containers were refused with an *authorization* claim about a machine nothing
 * spoke to.
 *
 * **One code for both machines, and the reason is that the reason carries it.**
 * The backend publishes two codes over HTTP — a Server and the platform host
 * are two different things to be told about
 * — but a socket
 * has no `code` field, so `closeIfHostUnreachable` sends the thrown exception's
 * own message as the close reason instead of a constant of its own. Whichever
 * of the two sentences applies is therefore already on the wire, and
 * `refusalSentence` adds only the tense.
 */
export const UNREACHABLE_CLOSE_CODE = 4012;

/** `docker exec` inside a container. Only these shells are accepted. */
export type ContainerShell =
  | "sh"
  | "bash"
  | "zsh"
  | "ash"
  | "/bin/sh"
  | "/bin/bash"
  | "/bin/zsh"
  | "/bin/ash";

/**
 * The URL of an interactive SSH shell on a Server, or `null` while it cannot
 * be dialled. `serverId: "local"` reaches the host the platform itself runs on,
 * and then `port` and `username` are required — the gateway closes the socket
 * without them.
 *
 * **The `isLocal` clause is load-bearing and stays.** Every other target's
 * connection details live on its Server row and the gateway reads them there;
 * `local` has no row, so these two come from the caller, and a socket dialled
 * without them is refused — `4400 port and username are required for
 * serverId=local`
 * Answering
 * `null` until both are known is the same rule as `enabled` for an id that has
 * not loaded yet: do not ask a question whose answer is already known to be a
 * refusal. It is not a way of hiding the local terminal — the console supplies
 * both (`features/server/local/`), and the local terminal is reachable through
 * them.
 */
export function serverTerminalUrl(options: {
  serverId: string | null | undefined;
  /** Required when `serverId` is `"local"`. */
  port?: number;
  /** Required when `serverId` is `"local"`. */
  username?: string;
}): string | null {
  const { serverId, port, username } = options;
  const isLocal = serverId === "local";
  if (!serverId || (isLocal && !(port && username))) return null;
  return gatewayUrl("/terminal", {
    serverId,
    port: isLocal ? port : undefined,
    username: isLocal ? username : undefined,
  });
}

/** The URL of a `docker exec` inside a container, or `null` without an id. */
export function containerTerminalUrl(options: {
  containerId: string | null | undefined;
  serverId?: string | null;
  /**
   * A stack on its own Stack VM (ADR-0070): the gateway reaches it by the
   * stack, never by a Server, so `serverId` is left out beside it.
   */
  composeId?: string | null;
  shell?: ContainerShell;
}): string | null {
  const { containerId, serverId, composeId, shell } = options;
  if (!containerId) return null;
  // The gateway calls this parameter `activeWay`.
  return gatewayUrl("/docker-container-terminal", {
    containerId,
    serverId: composeId ? undefined : serverId,
    composeId: composeId ?? undefined,
    activeWay: shell,
  });
}

export interface TerminalSnapshot extends SocketStreamSnapshot {
  /** See {@link TerminalStream.shellOpen}. */
  shellOpen: boolean;
}

/**
 * Every channel with a socket open or dialling — what {@link endAllTerminals}
 * reaches. Module-level on purpose: a shell docked in the console layout and
 * one still on a page are both a socket held open in this tab, and neither may
 * outlive the Organization or the sign-in it was opened under.
 */
const live = new Set<TerminalChannel>();
const endedListeners = new Set<() => void>();

/**
 * The words a terminal {@link endAllTerminals} ended shows in place of its
 * status. A page's own shell is ended too and stays on screen, so it must not
 * go on reading `open`; its *Connect again* dials afresh, under
 * whichever Organization and sign-in are current by then.
 */
export const TERMINALS_ENDED_REASON =
  "This shell was closed when the Organization changed or you signed out";

/**
 * Close every terminal in this tab, now.
 *
 * Switching Organization does not reload the page (`setActive` and then a
 * query invalidation), so a shell the console layout holds would outlive the
 * switch. The authorization lease would end it within 30 s (ADR-0012); the
 * Dock closes it *at once* instead. Signing out calls this too, before
 * the request rather than after the navigation that follows it.
 *
 * Closing the socket is the whole teardown: the gateway's `close` reaps the
 * shell's processes. The Dock disposes what it holds; a shell still on
 * a page stays on screen saying {@link TERMINALS_ENDED_REASON}, and its
 * *Connect again* dials afresh (`TerminalChannel.end`).
 *
 * `reason` is what each ended shell shows; leaving the page passes
 * {@link TERMINALS_LEFT_REASON} ({@link endTerminalsOnPageHide}).
 */
export function endAllTerminals(reason: string = TERMINALS_ENDED_REASON): void {
  for (const channel of [...live]) channel.end(reason);
  for (const listener of [...endedListeners]) listener();
}

/** What a shell ended by {@link endTerminalsOnPageHide} shows when the page
 *  comes back from the back/forward cache. */
export const TERMINALS_LEFT_REASON =
  "This shell was closed when you left the page";

/**
 * A page the browser keeps in its back/forward cache is frozen, not unloaded:
 * its sockets stay open and so does every shell behind them, out of sight and
 * for as long as the browser keeps the page. Chrome kept one for over five
 * minutes on a full-document navigation away from a page with a live shell.
 * And on Back, the restored page found its frozen socket dropped and the
 * store's backoff dialled a new shell no one had asked for.
 *
 * So when the page is hidden into that cache (`persisted`), end every terminal
 * exactly as an Organization switch does. The gateway reaps each shell when its
 * socket closes, the Dock closes, and a page's own shell comes back saying
 * {@link TERMINALS_LEFT_REASON}, with *Connect again* to dial afresh. A
 * `pagehide` that is not `persisted` is a real unload, which closes the sockets
 * anyway. In-app navigation never fires `pagehide`, so docked shells still
 * survive it.
 */
export function endTerminalsOnPageHide(event: PageTransitionEvent): void {
  if (event.persisted) endAllTerminals(TERMINALS_LEFT_REASON);
}

/** Installed once, the first time a terminal dials in this tab. */
let pageHideInstalled = false;
function installPageHide(): void {
  if (pageHideInstalled || typeof window === "undefined") return;
  pageHideInstalled = true;
  window.addEventListener("pagehide", endTerminalsOnPageHide);
}

/** Told after {@link endAllTerminals} — the Dock, so it closes its panel too. */
export function onTerminalsEnded(listener: () => void): () => void {
  endedListeners.add(listener);
  return () => {
    endedListeners.delete(listener);
  };
}

/**
 * One terminal socket, owned outside React.
 *
 * It used to live in a hook, which tied the session to the component that
 * rendered it: unmount — a navigation, a closed dialog — and the socket went
 * with it. The docked panel moves a live session from a page into the console
 * layout without a redial, so the socket needs an owner that can be handed
 * over; this is it, and the hooks below are thin wrappers that own one for a
 * component's lifetime.
 *
 * What it adds to `SocketStreamStore` is the two things only a terminal needs:
 * frames go to an emulator rather than a line buffer, and the gateway's
 * `SHELL_OPEN_FRAME` is read off the front of the stream.
 */
export class TerminalChannel {
  // Frames bypass the line buffer, so its cap is never reached.
  private readonly store = new SocketStreamStore(1);
  private readonly listeners = new Set<() => void>();
  private sink: ((frame: string) => void) | null = null;
  /** Only `onFrame` reads this; `shellOpen` is the snapshot's copy. */
  private opened = false;
  private shellOpen = false;
  private snapshot: TerminalSnapshot;
  /** The last gateway dialled — what *Connect again* redials after `end`. */
  private url: string | null = null;
  /** Set by `end`: closed, and saying so, but still the holder's to redial. */
  private ended = false;
  /** What an `end`ed snapshot says in place of its status. */
  private endedReason = TERMINALS_ENDED_REASON;
  /** Set by `close`: closed for good. */
  private closed = false;

  constructor() {
    this.snapshot = { ...this.store.getSnapshot(), shellOpen: false };
    this.store.setFrameHandler(this.onFrame);
    this.store.subscribe(this.onStore);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TerminalSnapshot => this.snapshot;

  getServerSnapshot = (): TerminalSnapshot => SERVER_SNAPSHOT;

  /** Dial `url`, or hold the connection closed with `null`. */
  open = (url: string | null): void => {
    this.url = url;
    this.ended = false;
    this.closed = false;
    if (url) {
      live.add(this);
      installPageHide();
    } else live.delete(this);
    this.store.open(url);
  };

  /** Close the socket for good. The gateway reaps the shell behind it. */
  close = (): void => {
    this.closed = true;
    live.delete(this);
    this.store.close();
  };

  /**
   * {@link endAllTerminals}' close: the socket goes exactly as with `close`,
   * but the snapshot says the session ended and *Connect again* still dials.
   * `SocketStreamStore.close` reports nothing, so without this a page's shell
   * kept reading `open` over a dead socket.
   */
  end = (reason: string = TERMINALS_ENDED_REASON): void => {
    live.delete(this);
    this.store.close();
    this.ended = true;
    this.endedReason = reason;
    this.opened = false;
    this.shellOpen = false;
    this.publish();
  };

  /** Hand frames to a terminal emulator. Call again to replace the sink. */
  attach = (write: (frame: string) => void): void => {
    this.sink = write;
  };

  send = (data: string): boolean => this.store.send(data);

  resize = (cols: number, rows: number): boolean =>
    this.store.send(resizeFrame(cols, rows));

  reconnect = (): void => {
    if (this.closed) return;
    // The store is disposed after `end`, so its own reconnect would not dial.
    if (this.ended) this.open(this.url);
    else this.store.reconnect();
  };

  setFollowing = (following: boolean): void =>
    this.store.setFollowing(following);

  clear = (): void => this.store.clear();

  private onFrame = (frame: string): void => {
    // Only before the shell is open: after it, every byte is the shell's.
    if (!this.opened && frame === SHELL_OPEN_FRAME) {
      this.opened = true;
      this.shellOpen = true;
      this.publish();
      return;
    }
    this.sink?.(frame);
  };

  private onStore = (): void => {
    // A redial is a new session, which says so again when its shell opens.
    const { status } = this.store.getSnapshot();
    if (status === "connecting" || status === "reconnecting") {
      this.opened = false;
      this.shellOpen = false;
    }
    this.publish();
  };

  private publish(): void {
    const store = this.store.getSnapshot();
    this.snapshot = this.ended
      ? {
          ...store,
          status: "closed",
          closeCode: null,
          closeReason: this.endedReason,
          shellOpen: false,
        }
      : { ...store, shellOpen: this.shellOpen };
    for (const listener of this.listeners) listener();
  }
}

const SERVER_SNAPSHOT: TerminalSnapshot = {
  status: "closed",
  lines: [],
  following: true,
  closeReason: null,
  closeCode: null,
  dropped: 0,
  marked: [],
  shellOpen: false,
};

/**
 * A channel, read from React: its snapshot and its bound methods, in the
 * `TerminalStream` shape every terminal view takes. Whoever owns the channel
 * opens and closes it — this only reads.
 */
export function useTerminalChannel(channel: TerminalChannel): TerminalStream {
  const snapshot = useSyncExternalStore(
    channel.subscribe,
    channel.getSnapshot,
    channel.getServerSnapshot,
  );
  return {
    ...snapshot,
    send: channel.send,
    setFollowing: channel.setFollowing,
    clear: channel.clear,
    reconnect: channel.reconnect,
    attach: channel.attach,
    resize: channel.resize,
  };
}

/**
 * A channel owned by one component for its lifetime: dialled on mount and on a
 * change of `url`, closed on unmount. The page terminal and the Dock own theirs
 * through `LiveTerminal` instead, which is what lets a session change hands.
 */
function useOwnedTerminal(url: string | null): TerminalStream {
  const [channel] = useState(() => new TerminalChannel());
  useEffect(() => {
    channel.open(url);
    return () => channel.close();
  }, [channel, url]);
  return useTerminalChannel(channel);
}

/** An interactive SSH shell on a Server — {@link serverTerminalUrl}. */
export function useServerTerminal(options: {
  serverId: string | null | undefined;
  port?: number;
  username?: string;
  enabled?: boolean;
}): TerminalStream {
  const { enabled = true, ...rest } = options;
  return useOwnedTerminal(enabled ? serverTerminalUrl(rest) : null);
}

/** `docker exec` inside a container — {@link containerTerminalUrl}. */
export function useContainerTerminal(options: {
  containerId: string | null | undefined;
  serverId?: string | null;
  composeId?: string | null;
  shell?: ContainerShell;
  enabled?: boolean;
}): TerminalStream {
  const { enabled = true, ...rest } = options;
  return useOwnedTerminal(enabled ? containerTerminalUrl(rest) : null);
}
