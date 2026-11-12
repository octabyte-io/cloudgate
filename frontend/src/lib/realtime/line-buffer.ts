import type { HeldLines } from "./log-resume";

/**
 * The append-only, capped line buffer behind a log stream.
 *
 * Frames off a socket are arbitrary chunks, not lines — a single write can carry
 * half a line, or forty. This turns that into lines, which is the unit a log well
 * renders, scrolls and caps by.
 *
 * Separate from `SocketStreamStore` because it is pure: no socket, no timers, no
 * React. Feed it chunks, read lines.
 */
export class LineBuffer {
  /** Whole lines, oldest first, never more than `cap` of them. */
  private committed: string[] = [];
  /** The tail that has no newline yet. */
  private partial = "";
  private droppedCount = 0;
  /**
   * Lines of the source taken in since the last reset, dropped ones included
   * and marks not: how far into a log replayed from the start this has got.
   */
  private receivedCount = 0;
  /** Marked lines, by position counted from the first line held since reset. */
  private marks: number[] = [];
  /** Lines a redial sends again, skipped until it says it is done. */
  private heldLines: HeldLines | null = null;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  /** Take a frame. Returns `true` when there is something new to render. */
  push(chunk: string): boolean {
    if (!chunk) return false;

    const parts = (this.partial + chunk).split("\n");
    this.partial = parts.pop() ?? "";

    const fresh = this.heldLines ? parts.filter(this.unheld) : parts;
    this.receivedCount += fresh.length;
    this.commit(fresh);

    return true;
  }

  /**
   * Commit a line of the buffer's own — where a log reconnected. It holds a
   * place and falls off the front like any line, but it is not the source's,
   * so a replay does not count it.
   */
  mark(text: string): void {
    this.marks.push(this.droppedCount + this.committed.length);
    this.commit([text]);
  }

  /** Throw away the unterminated tail: a redial sends that line again whole. */
  dropPartial(): void {
    this.partial = "";
  }

  /** Skip the lines `held` says are held, until it is done. */
  skipHeld(held: HeldLines): void {
    this.heldLines = held.done ? null : held;
  }

  /** The whole lines held, without the unterminated tail. */
  wholeLines(): readonly string[] {
    return this.committed;
  }

  /** How many of the source's lines were taken in since the last reset. */
  received(): number {
    return this.receivedCount;
  }

  /** Which of {@link lines} are marked, by index. */
  marked(): number[] {
    return this.marks.map((at) => at - this.droppedCount);
  }

  /**
   * What to render now.
   *
   * The unterminated tail is included as the last line, and replaced when the
   * rest of it arrives — so output appears as it is written rather than always a
   * line behind. A build that ends without a trailing newline still shows its
   * last line. While a redial is still sending lines already held, the tail may
   * be one of them, so it waits until it is known not to be.
   */
  lines(): string[] {
    return this.partial && !this.heldLines
      ? [...this.committed, this.partial]
      : [...this.committed];
  }

  /** How many lines fell off the front to stay under the cap. */
  dropped(): number {
    return this.droppedCount;
  }

  reset(): void {
    this.committed = [];
    this.partial = "";
    this.droppedCount = 0;
    this.receivedCount = 0;
    this.marks = [];
    this.heldLines = null;
  }

  private unheld = (line: string): boolean => {
    const held = this.heldLines;
    if (!held) return true;
    const skip = held.held(line);
    if (held.done) this.heldLines = null;
    return !skip;
  };

  private commit(lines: readonly string[]): void {
    if (lines.length === 0) return;
    this.committed.push(...lines);
    const excess = this.committed.length - this.cap;
    if (excess > 0) {
      this.committed.splice(0, excess);
      this.droppedCount += excess;
      this.marks = this.marks.filter((at) => at >= this.droppedCount);
    }
  }
}
