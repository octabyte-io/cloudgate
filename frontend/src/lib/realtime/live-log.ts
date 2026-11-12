import type { LogLine } from "./log-line";
import { logResume, type LogResumeKind } from "./log-resume";
import { socketRefusalEnding } from "./refusal";
import {
  SocketStreamStore,
  type DialParams,
  type SocketStreamSnapshot,
} from "./socket-stream-store";

/**
 * Who holds a Live log: the page whose log box built it, or the Dock.
 *
 * The holder is the one that ends it, as with `LiveTerminal`. A page's log box
 * disposes its Live log when it unmounts only while the page still holds it;
 * once docked, the Dock ends it.
 */
export type LiveLogOwner = "page" | "dock";

/**
 * How a log's source ended, when it said so — a Deployment that finished or
 * failed. `mark` is the tab's glyph, `words` its end word ("Succeeded") and
 * `sentence` what the page note says in the log's place.
 *
 * `refused` marks a docked log that lost access, or whose target went: its
 * `sentence` is the one a Docked shell's status line says for the same
 * refusal, and the Dock shows it under the log as well as on the page note.
 */
export type LogEnding = {
  mark: "finished" | "failed" | "stopped";
  words: string;
  sentence: string;
  refused?: true;
};

/** What the Dock needs to draw a log: its tab's name and how its lines read. */
export type LogAbout = {
  /** "Subject · what it is" — "storefront · Deploy #54". */
  name: string;
  /**
   * The page's own tone map. A log well renders lines and never parses them,
   * so the page that knows what its lines mean hands that over with the log.
   */
  toLines?: (lines: readonly string[]) => LogLine[];
};

/**
 * What a source publishes: a socket's snapshot, and, for a source whose lines
 * are not text off a socket — the cloud Runtime log's — those lines already
 * toned, which the Dock draws instead of mapping `lines` itself. `lines` is
 * still each line's text, for anything that only counts them.
 */
export interface LogSourceSnapshot extends SocketStreamSnapshot {
  toned?: readonly LogLine[];
  /**
   * A source that is not a socket says itself how a refusal ends a docked
   * log — the cloud poll's read answered not authorized, forbidden or not
   * found. A socket's is read off its close code (`socketRefusalEnding`).
   */
  refusal?: LogEnding | null;
  /**
   * A source that is a fixed record — a finished log's stored read
   * (`StoredLog`) — says itself how it ended, from the start: its Live log is
   * over from its first snapshot and never dials.
   */
  ending?: LogEnding | null;
  /** A fixed record being read again (Reload). */
  reading?: boolean;
}

/**
 * Where a Live log's lines come from. A `SocketStreamStore` for the
 * Deployment, Compose, database and setup logs; a REST poll for the cloud
 * Runtime log (`RuntimeLogPoll`), which reads `open`'s target as the Service
 * it polls and has nothing to `send`; a finished log's stored record
 * (`StoredLog`), which starts ended and is only ever read again.
 */
export interface LogSource {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LogSourceSnapshot;
  /** Point it at a target, or at `null` to hold it closed. */
  open: (target: string | null, once?: DialParams) => void;
  /** Stop it. Its lines stay. */
  close: () => void;
  setFrameHandler: (handler: ((frame: string) => void) | undefined) => void;
  send: (data: string) => boolean;
  clear: () => void;
  reconnect: () => void;
  reconnectOnce: (params?: DialParams) => void;
  /**
   * Whether anyone can see the log. Only a source that costs something to
   * keep reading takes it — the cloud poll pauses off screen. A socket stays
   * connected either way.
   */
  setOnScreen?: (onScreen: boolean) => void;
  /**
   * Read a fixed record again — the Dock's **Reload** on a docked finished
   * log. Only a stored record has it; a socket or a poll is followed, not
   * reloaded.
   */
  reload?: () => void;
}

export interface LiveLogSnapshot extends LogSourceSnapshot {
  /**
   * Whether the source is still writing to this log — dialling, open, or
   * backing off before a redial. `false` is ended, and `status`, `closeCode`
   * and `closeReason` say how.
   */
  live: boolean;
  /** How the source ended, once it said so; `null` until then. */
  ending: LogEnding | null;
  /**
   * Every line this log has been given since its source last dialled — the
   * ones held and the ones dropped off the front. The follow bar's "N lines",
   * and what a background tab's "+N new lines" counts from.
   */
  received: number;
  /** When the last line came in (epoch ms); `null` before the first. */
  lastLineAt: number | null;
  /** Lines received since following stopped: "N new lines below". */
  newBelow: number;
  /**
   * What the source says while it writes nothing for now — a stopped
   * database — or `null`. Not an ending: the socket stays, and it is lifted
   * when the source runs again. No cursor is drawn while it is set.
   */
  resting: LogEnding | null;
}

/** A log not yet built, or not yet dialled. */
export const NO_LOG: LiveLogSnapshot = {
  status: "closed",
  lines: [],
  following: true,
  closeReason: null,
  closeCode: null,
  dropped: 0,
  marked: [],
  live: false,
  ending: null,
  received: 0,
  lastLineAt: null,
  newBelow: 0,
  resting: null,
};

let sequence = 0;

/**
 * One log as a thing that can change hands: the log's counterpart of
 * `LiveTerminal` (CONTEXT.md, **Docked log**).
 *
 * Built by a page's log box from the start, not when docked, and owned outside
 * React so it can outlive the page. It holds the lines and the dropped count
 * (through its source), whether it is live or how it ended, and the
 * follow-tail flag — lifted out of `LogWell` so that a log paused on its page is
 * still paused wherever it is read next. `key` names what the log is (this
 * Deployment, this container, this Server's setup run), not how it was dialled.
 *
 * Its source is a `SocketStreamStore` for the Deployment, Compose, database
 * and setup logs, built from `cap`, or the {@link LogSource} it is handed —
 * the cloud Runtime log's poll. `useSocketStream` and `useRuntimeLog` read
 * it; whoever holds it (`owner`) ends
 * it with `dispose`. What else it watches — a Deployment's status — it holds
 * itself (`watch`), so the watch outlives the page with it, and `end` is how
 * that watch says the source is over.
 */
export class LiveLog {
  readonly id = `log-${++sequence}`;
  readonly source: LogSource;
  /** What the Dock draws it as. Set by the page box that built it. */
  about: LogAbout | null = null;
  /**
   * The console address of the page it was docked from — the follow bar's
   * **Go to its page**. Set by the Dock as it takes the log.
   */
  page: string | null = null;

  private held: LiveLogOwner;
  private following = true;
  private ended = false;
  private ending: LogEnding | null = null;
  private lastLineAt: number | null = null;
  /** `received` when following stopped; `null` while following. */
  private pausedAt: number | null = null;
  private resting: LogEnding | null = null;
  /** The last gateway it was pointed at, which `redial` dials again. */
  private target: string | null = null;
  private snapshot: LiveLogSnapshot = NO_LOG;
  private readonly listeners = new Set<() => void>();
  /** What the log watches besides its socket, by name, and how to stop it. */
  private readonly watches = new Map<string, () => void>();

  constructor(
    readonly key: string,
    owner: LiveLogOwner,
    options:
      | {
          cap: number;
          /**
           * How it picks up after its socket drops once docked: the lines are
           * kept, a marked line says where it reconnected, and what the
           * gateway sends again is skipped (`log-resume.ts`). Left out, a
           * redial starts over as a page box's does.
           */
          resume?: LogResumeKind;
        }
      | { source: LogSource },
  ) {
    this.held = owner;
    if ("source" in options) {
      this.source = options.source;
    } else {
      const store = new SocketStreamStore(options.cap);
      const resume = options.resume ? logResume(options.resume) : null;
      // Only a Docked log keeps its lines across a redial: a page's
      // own box is unchanged. Asked at each redial, so docking needs no call
      // here — and a log a refusal ended is never picked up again.
      if (resume) {
        store.setResume(() =>
          this.owner === "dock" && !this.over ? resume : null,
        );
      }
      this.source = store;
    }
    this.source.subscribe(this.publish);
    // A stored record has lines and an ending before anything is said.
    this.publish();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LiveLogSnapshot => this.snapshot;

  get owner(): LiveLogOwner {
    return this.held;
  }

  /**
   * Hand the log over, and say so: whoever reads the log — the page box that
   * built it — renders again and sees it docked, with no need to watch the
   * Dock. A log refused on its page and then docked ends as it arrives in the
   * Dock: its socket has said all it will.
   */
  set owner(owner: LiveLogOwner) {
    if (this.held === owner) return;
    this.held = owner;
    this.publish();
  }

  getServerSnapshot = (): LiveLogSnapshot => NO_LOG;

  /** Name it for the Dock. */
  describe = (about: LogAbout): void => {
    this.about = about;
    this.publish();
  };

  /**
   * Watch something besides the socket — a Deployment's status — for as long
   * as the log lives, whoever holds it. Once per `name`: a page box that
   * renders again, or runs its effects twice, starts one watch, and the log
   * stops it when it ends.
   *
   * `start` answers `null` when it cannot start yet — no Organization known
   * on the first render — and then takes no slot, so the box's next effect,
   * once the Organization is known, starts the real one.
   */
  watch = (name: string, start: () => (() => void) | null): void => {
    if (this.over || this.watches.has(name)) return;
    const stop = start();
    if (!stop) return;
    // A watch can end the log as it starts — a build already over.
    if (this.over) stop();
    else this.watches.set(name, stop);
  };

  /**
   * The source is over — a Deployment reached a final status. The socket
   * closes and nothing redials, but the log keeps every line and stays where
   * it is: a docked one is the record until its tab is closed.
   */
  end = (ending: LogEnding): void => {
    if (this.over) return;
    this.ending = ending;
    this.source.close();
    this.stopWatching();
    this.publish();
  };

  /**
   * The source is writing nothing for now, and says why — or, with `null`,
   * that it runs again. A database that stops keeps its socket, which sits
   * open on a service with no task; this is what hides the cursor.
   */
  rest = (resting: LogEnding | null): void => {
    if (this.resting === resting) return;
    this.resting = resting;
    this.publish();
  };

  /** Point the source at a gateway, or at `null` to hold it closed. */
  open = (url: string | null, once?: DialParams): void => {
    if (this.over) return;
    if (url) this.target = url;
    this.source.open(url, once);
  };

  /**
   * Hang up and dial the last gateway it was pointed at again, from the top —
   * even when it is held closed. What a watch uses once the page that knew the
   * gateway is gone: a database that finishes deploying is followed again.
   */
  redial = (): void => {
    if (this.over || !this.target) return;
    this.source.close();
    this.source.open(this.target);
  };

  /** Hang up the current dial — a change of target follows. Not an ending. */
  hangUp = (): void => {
    this.source.close();
  };

  /** End the log: its socket closes, and nothing redials. */
  dispose = (): void => {
    if (this.ended) return;
    this.ended = true;
    this.source.close();
    this.stopWatching();
    this.publish();
  };

  get disposed(): boolean {
    return this.ended;
  }

  setFollowing = (following: boolean): void => {
    if (this.following === following) return;
    this.following = following;
    this.pausedAt = following ? null : this.snapshot.received;
    this.publish();
  };

  setFrameHandler = (handler: ((frame: string) => void) | undefined): void =>
    this.source.setFrameHandler(handler);

  send = (data: string): boolean => this.source.send(data);

  clear = (): void => this.source.clear();

  /**
   * Whether the log is on screen — the Dock says so for its active log. A
   * source that pauses off screen (the cloud poll) hears it; a socket does not.
   */
  setOnScreen = (onScreen: boolean): void => {
    if (!this.over) this.source.setOnScreen?.(onScreen);
  };

  reconnect = (): void => {
    if (!this.over) this.source.reconnect();
  };

  reconnectOnce = (params?: DialParams): void => {
    if (!this.over) this.source.reconnectOnce(params);
  };

  /**
   * Whether **Reload** is offered: a fixed record, still held, that no read
   * has refused. A refusal is final here as it is for a socket.
   */
  get reloadable(): boolean {
    return (
      this.source.reload !== undefined &&
      !this.ended &&
      !this.snapshot.ending?.refused
    );
  }

  /** Read a fixed record again. Never dials: a record has no socket. */
  reload = (): void => {
    if (this.reloadable) this.source.reload?.();
  };

  private get over(): boolean {
    return (
      this.ended ||
      this.ending !== null ||
      Boolean(this.source.getSnapshot().ending)
    );
  }

  private stopWatching(): void {
    for (const stop of this.watches.values()) stop();
    this.watches.clear();
  }

  /**
   * A docked log that loses access — a lease close, or a dial refused as not
   * found or not permitted, which a deleted target also answers — ends the
   * way a Docked shell does (ADR-0012): every line kept, nothing redialled,
   * and how it ended in the shell's own words. A page's box is left to say
   * its own refusal and offer its own way back.
   */
  private endIfRefused(): void {
    if (this.over || this.held !== "dock") return;
    const source = this.source.getSnapshot();
    const refusal = source.refusal ?? socketRefusalEnding(source);
    if (refusal) this.end(refusal);
  }

  private publish = (): void => {
    // Ending publishes again, with the source already closed.
    this.endIfRefused();
    const source = this.source.getSnapshot();
    const dialling =
      source.status === "connecting" ||
      source.status === "open" ||
      source.status === "reconnecting";
    const received = source.dropped + source.lines.length;
    if (received > this.snapshot.received) this.lastLineAt = Date.now();
    // A redial replays from the top, so the count starts again; a mark past
    // it would count lines that were never below.
    if (this.pausedAt !== null && this.pausedAt > received) {
      this.pausedAt = received;
    }
    this.snapshot = {
      ...source,
      // A source hung up by `close` says nothing (that is an unmount's), so
      // an ended log says closed here rather than still "open".
      status: this.over && dialling ? "closed" : source.status,
      following: this.following,
      live: !this.over && dialling,
      ending: this.ending ?? source.ending ?? null,
      received,
      lastLineAt: this.lastLineAt,
      newBelow: this.pausedAt === null ? 0 : received - this.pausedAt,
      resting: this.resting,
    };
    for (const listener of this.listeners) listener();
  };
}
