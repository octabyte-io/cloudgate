import type { LogLine } from "@/components/console/log-well";
import { isApiError } from "@/lib/api/api-error";
import { applicationsApi } from "@/lib/api/endpoints/applications";
import { errorMessage } from "@/lib/api/error-message";
import type {
  LogEnding,
  LogSource,
  LogSourceSnapshot,
} from "@/lib/realtime/live-log";
import {
  COULD_NOT_CONNECT,
  NO_LONGER_AUTHORIZED,
} from "@/lib/realtime/refusal";

import {
  mergeRuntimeLines,
  RUNTIME_LOG_HELD,
  toRuntimeLogLines,
  unreadSpan,
  withUnreadSpan,
  type HeldRuntimeLog,
} from "./runtime-log-lines";

/** How often the log asks for new lines: the "few seconds" it is behind. */
export const RUNTIME_LOG_POLL_MS = 4_000;

/** What the page card reads: the lines held and how the last read went. */
export interface RuntimeLogState extends HeldRuntimeLog {
  /** The first read has come back. */
  loaded: boolean;
  /** The last read's failure, cleared by the next read that works. */
  error: unknown;
  /** The last read said the Google project's log reads are backing off. */
  delayed: boolean;
}

export const NO_RUNTIME_LOG: RuntimeLogState = {
  lines: [],
  dropped: 0,
  loaded: false,
  error: null,
  delayed: false,
};

const NO_TONED: readonly LogLine[] = [];

/**
 * How a docked cloud log ends on a read refused as not authorized, forbidden
 * or not found — access gone, or the Service deleted — or `null` for a failure
 * that is not a refusal, which the poll tries again on its beat. The end word
 * is the one a Docked shell's tab says for the same refusal; the sentence is
 * the console's own for the read, then the tense.
 */
export function refusedRead(error: unknown): LogEnding | null {
  if (!isApiError(error)) return null;
  const { status } = error;
  if (status !== 401 && status !== 403 && status !== 404) return null;
  return {
    mark: "stopped",
    words: status === 404 ? COULD_NOT_CONNECT : NO_LONGER_AUTHORIZED,
    sentence: `${errorMessage(error)} This log stopped reading; the lines it had read stay.`,
    refused: true,
  };
}

/**
 * A cloud Service's Runtime log, polled: the source of its Live log. The
 * backend reads the cloud's log store on the Service's behalf (CloudWatch, or
 * the Google project's own) and hands back the lines and where the next read
 * starts; this asks again every {@link RUNTIME_LOG_POLL_MS}, or at once when
 * the backend left lines for the next read. A failed read keeps the lines held
 * and tries again on the same beat — except, once docked, a read refused as
 * not authorized, forbidden or not found ({@link refusedRead}): the Live log
 * ends there and closes the poll, so a lost Service is not asked every 4 s.
 *
 * The cursor (`since`) and the held lines live here, outside React, so they
 * go with the Live log into the Dock.
 *
 * **Off screen it pauses** (`setOnScreen`), which only the Dock asks for — a
 * Google project's reads are shared, and a forgotten tab must not spend them.
 * Back on screen it reads at once from its cursor. A pause longer than the
 * backend's lookback leaves one marked line naming the span it skipped.
 */
export class RuntimeLogPoll implements LogSource {
  private state: RuntimeLogState = NO_RUNTIME_LOG;
  private snapshot: LogSourceSnapshot = {
    status: "closed",
    lines: [],
    following: true,
    closeReason: null,
    closeCode: null,
    dropped: 0,
    // Its one marked line (a span not read) is toned in `toned` itself.
    marked: [],
    toned: NO_TONED,
  };
  private readonly listeners = new Set<() => void>();

  /** The Service polled; `null` while closed. */
  private target: string | null = null;
  private since: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading = false;
  private paused = false;
  /** Bumped on every open and close, so a read that lands late is dropped. */
  private generation = 0;

  constructor(private readonly cap = RUNTIME_LOG_HELD) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LogSourceSnapshot => this.snapshot;

  /** The page card's view: typed lines, and whether the last read failed. */
  getState = (): RuntimeLogState => this.state;

  /** Start polling a Service, or hold the poll closed with `null`. */
  open = (target: string | null): void => {
    if (target === this.target) return;
    this.stop();
    this.target = target;
    this.emit();
    if (target && !this.paused) void this.read();
  };

  /** Stop polling. The lines stay. */
  close = (): void => {
    if (this.target === null) return;
    this.stop();
    this.target = null;
    this.emit();
  };

  setOnScreen = (onScreen: boolean): void => {
    if (!onScreen) {
      if (this.paused) return;
      this.paused = true;
      this.clearTimer();
      return;
    }
    if (!this.paused) return;
    this.paused = false;
    if (!this.target) return;
    const skipped = unreadSpan(this.since, Date.now());
    if (skipped) {
      this.state = {
        ...this.state,
        ...withUnreadSpan(this.state, skipped, this.cap),
      };
      this.emit();
    }
    if (!this.reading) void this.read();
  };

  /** A poll has no socket to frame. */
  setFrameHandler = (): void => {};

  /** Nothing is written to a poll. */
  send = (): boolean => false;

  clear = (): void => {
    this.state = { ...this.state, lines: [], dropped: 0 };
    this.emit();
  };

  /** Read now, rather than at the next beat. */
  reconnect = (): void => {
    if (!this.target || this.paused || this.reading) return;
    this.clearTimer();
    void this.read();
  };

  reconnectOnce = (): void => this.reconnect();

  private async read(): Promise<void> {
    const target = this.target;
    if (!target) return;
    const generation = this.generation;
    this.reading = true;
    let wait = RUNTIME_LOG_POLL_MS;
    try {
      const read = await applicationsApi.runtimeLog(target, this.since);
      if (generation !== this.generation) return;
      this.since = read.next;
      if (read.more) wait = 0;
      this.state = {
        ...mergeRuntimeLines(this.state, read.lines, this.cap),
        loaded: true,
        error: null,
        delayed: read.delayed === true,
      };
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = { ...this.state, loaded: true, error };
    } finally {
      if (generation === this.generation) this.reading = false;
    }
    this.emit();
    // Hearing the read may have stopped the poll — a docked log refused.
    if (!this.paused && generation === this.generation) {
      this.timer = setTimeout(() => void this.read(), wait);
    }
  }

  private stop(): void {
    this.generation += 1;
    this.reading = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    const toned = toRuntimeLogLines(this.state.lines);
    // A refused read says so to the Live log, which ends a docked one. The
    // page's own box keeps reading on its beat and shows the error itself.
    const refusal = this.target ? refusedRead(this.state.error) : null;
    this.snapshot = {
      status: !this.target ? "closed" : refusal ? "refused" : "open",
      lines: toned.map((line) => line.text),
      following: true,
      closeReason: refusal?.sentence ?? null,
      closeCode: null,
      dropped: this.state.dropped,
      marked: [],
      toned,
      refusal,
    };
    for (const listener of this.listeners) listener();
  }
}
