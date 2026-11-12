import { style } from './format.js';
import type { TerminalMode } from './terminal.js';

/**
 * Where a command writes (CLI spec, Output conventions): **data** on stdout,
 * and everything else — progress, warnings, questions, `Using instance` — on
 * stderr, so stdout can be piped into `jq` or `grep` safely.
 *
 * A command never writes to a stream itself; it goes through this, which is
 * what makes the rule one rule.
 */
export class Output {
  constructor(
    private readonly streams: {
      stdout: (text: string) => void;
      stderr: (text: string) => void;
    },
    readonly mode: TerminalMode,
  ) {}

  /** Data, on stdout. */
  data(text: string): void {
    this.streams.stdout(text);
  }

  /** One JSON value on stdout, and nothing else beside it. */
  json(value: unknown): void {
    this.streams.stdout(`${JSON.stringify(value)}\n`);
  }

  /** A line for the person, on stderr. */
  note(text: string): void {
    this.streams.stderr(`${text}\n`);
  }

  /** Styling for stdout, the identity when stdout may not be coloured. */
  get dataStyle() {
    return { dim: style(this.mode.stdoutColour, 'dim') };
  }

  /** Styling for stderr, the identity when stderr may not be coloured. */
  get noteStyle() {
    return { dim: style(this.mode.stderrColour, 'dim') };
  }

  /**
   * Runs `work` behind a spinner on stderr, drawn only when the mode allows
   * one; otherwise it simply runs. The spinner's line is erased when the work
   * settles, so nothing of it is left in a scrollback.
   */
  async withSpinner<T>(label: string, work: () => Promise<T>): Promise<T> {
    if (!this.mode.spinner) return work();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frame = 0;
    const draw = () =>
      this.streams.stderr(`\r${frames[frame++ % frames.length]} ${label}`);
    draw();
    const timer = setInterval(draw, 80);
    try {
      return await work();
    } finally {
      clearInterval(timer);
      this.streams.stderr('\r\u001b[2K');
    }
  }
}
