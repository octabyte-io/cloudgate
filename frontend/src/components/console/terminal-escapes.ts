/**
 * An ECMA-48 control sequence — `ESC [`, parameter bytes, intermediate bytes, one
 * final byte.
 *
 * That grammar rather than SGR's `ESC [ … m` alone because the alternative is not
 * "cursor moves left alone", it is `[2K` and `[1A` printed as text exactly the
 * way `[33m` was: the ESC is invisible and everything after it shows. Colour is
 * the one that reaches a log today — BuildKit colours its closing
 * `1 warning found` even into a file, and a service's logger colours its own
 * stdout — but a line-based well has no cursor to move, so there is nothing a
 * non-colour sequence could mean here that dropping it loses.
 */
const CONTROL_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * One log line without its terminal control sequences.
 *
 * Every line mapper for `LogWell` — `toLogLines`, `toBuildLines`, `toSetupLines`
 * — calls this **before** toning, because several tone rules are anchored to
 * the start of the line (a BuildKit step's `#7 [`, a setup step's `1. `,
 * `Skipping `) and a leading escape would put bytes in front of them. An
 * unanchored rule such as the build log's `warning` word matched with or
 * without the escape; what the escape cost there was the text, not the tone.
 */
export function stripTerminalEscapes(text: string): string {
  return text.replace(CONTROL_SEQUENCE, "");
}
