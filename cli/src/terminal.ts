import { usageError } from './errors.js';

/**
 * What a run may do to the person in front of it (CLI spec, Output
 * conventions): colour, a spinner, a question. Decided once per run, from
 * facts about the process, so every command follows the same rule.
 */
export interface TerminalMode {
  /** Colour on stdout: only when stdout is a terminal. */
  stdoutColour: boolean;
  /** Colour on stderr: only when stderr is a terminal. */
  stderrColour: boolean;
  /**
   * A spinner, drawn on stderr: only when both streams are terminals and CI is
   * not set, so `| cat` and a CI log never receive carriage-return frames.
   */
  spinner: boolean;
  /**
   * Whether a question may be asked. Never when stdin or stdout is not a
   * terminal, when `CI` is set, or with `--no-input`; and "don't ask" never
   * means "yes" — a command that cannot ask refuses ({@link requireInputs}).
   */
  canAsk: boolean;
}

export interface TerminalFacts {
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  /** `--no-color`. */
  noColor?: boolean;
  /** `--no-input`. */
  noInput?: boolean;
}

/** Set means non-empty, as no-color.org defines it for `NO_COLOR`. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

export function terminalMode(facts: TerminalFacts): TerminalMode {
  const ci = isSet(facts.env.CI);
  const colourAllowed =
    !facts.noColor && !isSet(facts.env.NO_COLOR) && facts.env.TERM !== 'dumb';
  return {
    stdoutColour: colourAllowed && facts.stdoutIsTTY,
    stderrColour: colourAllowed && facts.stderrIsTTY,
    spinner: !ci && facts.stdoutIsTTY && facts.stderrIsTTY,
    canAsk: !ci && !facts.noInput && facts.stdinIsTTY && facts.stdoutIsTTY,
  };
}

/** One input a command needs, and the flag and variable that can give it. */
export interface InputSpec {
  /** Finishes "no …": `Service to deploy to`, `Environment`. */
  name: string;
  /** The flag that gives it, e.g. `--service`. */
  flag: string;
  /** The variable that stands in for the flag, e.g. `CLOUDGATE_SERVICE`. */
  env?: string;
  /** The value already found, from a flag, a variable or a Folder link. */
  value?: string;
}

/**
 * The shared rule for a missing input (CLI spec): when the run may ask, the
 * missing inputs come back, in order, for the command to ask about; when it may
 * not, the run refuses with exit 2 and names the **first** missing flag (and
 * its variable), so a CI author fixes the pipeline from the top.
 *
 * Only the first, not all of them: a later input often depends on an earlier
 * one (an Environment is looked up inside a Project), so naming it before the
 * earlier one is given would send the author after the wrong thing.
 */
export function requireInputs(
  inputs: readonly InputSpec[],
  mode: Pick<TerminalMode, 'canAsk'>,
): InputSpec[] {
  const missing = inputs.filter((input) => !input.value);
  const [first] = missing;
  if (!first || mode.canAsk) return missing;
  const how = first.env
    ? `Pass ${first.flag} or set ${first.env}.`
    : `Pass ${first.flag}.`;
  throw usageError(`no ${first.name}. ${how}`);
}
