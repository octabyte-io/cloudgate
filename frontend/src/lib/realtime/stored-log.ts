import type { LogEnding, LogSource, LogSourceSnapshot } from "./live-log";

/**
 * What one read of a stored log answered.
 *
 * - `lines` — the record, read again: it replaces the lines held.
 * - `ending` — the record is gone (the retention sweep reaped it) or the read
 *   was refused: the log ends with this, and the lines held stay. No line is
 *   added for it: an ending is said beside the log, never in it.
 * - `failed` — the read did not work this time, in the console's words: the
 *   lines and the ending stay, the words are said after the ending's own
 *   sentence, and Reload can be pressed again.
 */
export type StoredRead =
  | { lines: readonly string[] }
  | { ending: LogEnding }
  | { failed: string };

/**
 * A finished log's stored record, as the source of a Live log: the third kind
 * beside the socket (`SocketStreamStore`) and the cloud poll
 * (`RuntimeLogPoll`), and the one a docked finished log has (CONTEXT.md,
 * **Docked log**; #1340).
 *
 * **It starts ended and never dials.** It is built with the lines the page
 * already read and how the log ended, and says that ending itself
 * (`ending`), which is what makes its `LiveLog` over from the first snapshot
 * — so `open`, `redial` and a watch are all refused there and nothing here
 * opens a socket. `reload` is its one way to change: a re-read of the stored
 * record, which replaces the lines.
 *
 * Rejected: making the record a `SocketStreamStore` opened once. A socket to a
 * file nothing appends to connects, replays and then sits open for ever —
 * `DeploymentLog`'s own reason for reading a finished build over REST.
 */
export class StoredLog implements LogSource {
  private snapshot: LogSourceSnapshot;
  private readonly listeners = new Set<() => void>();
  /** How the record ended, before a failed read's words are added to it. */
  private recordEnding: LogEnding;
  private failed: string | null = null;
  private reading = false;
  /** Set by `close` — the log disposed: a read that lands after is dropped. */
  private closed = false;

  constructor(
    private readonly read: () => Promise<StoredRead>,
    lines: readonly string[],
    ending: LogEnding,
  ) {
    this.recordEnding = ending;
    this.snapshot = {
      status: "closed",
      lines,
      following: true,
      closeReason: null,
      closeCode: null,
      dropped: 0,
      marked: [],
      ending,
      reading: false,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LogSourceSnapshot => this.snapshot;

  /**
   * Read the stored record again — the Dock's **Reload**. One read at a time;
   * a refused record is not read again.
   */
  reload = (): void => {
    if (this.reading || this.closed || this.recordEnding.refused) return;
    this.reading = true;
    this.emit();
    void this.read()
      .catch((error: unknown): StoredRead => ({ failed: String(error) }))
      .then((result) => {
        if (this.closed) return;
        this.reading = false;
        if ("lines" in result) {
          this.failed = null;
          this.emit(result.lines);
        } else if ("ending" in result) {
          this.failed = null;
          this.recordEnding = result.ending;
          this.emit();
        } else {
          this.failed = result.failed;
          this.emit();
        }
      });
  };

  /** Nothing to dial. */
  open = (): void => {};

  /** The log is done with: a read still out is dropped when it lands. */
  close = (): void => {
    this.closed = true;
  };

  setFrameHandler = (): void => {};
  send = (): boolean => false;
  clear = (): void => {};
  reconnect = (): void => {};
  reconnectOnce = (): void => {};

  private emit(lines: readonly string[] = this.snapshot.lines): void {
    const ending = this.failed
      ? {
          ...this.recordEnding,
          sentence: `${this.recordEnding.sentence} ${this.failed}`,
        }
      : this.recordEnding;
    this.snapshot = { ...this.snapshot, lines, ending, reading: this.reading };
    for (const listener of this.listeners) listener();
  }
}
