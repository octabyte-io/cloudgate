import { stripTerminalEscapes } from "@/components/console/terminal-escapes";

/**
 * How far a Setup run has gone, read from its own output, for the wizard's
 * reader: someone who may know nothing about servers, waiting minutes for
 * one to be made ready.
 *
 * The default setup script echoes a numbered header before each of its
 * steps (`backend/src/servers/server-setup.ts`: `1. Installing required
 * packages` … `8. Setting up boot recovery`), the same numbers
 * `server/infrastructure/setup-steps.ts` lists for an operator. So the
 * newest header is the step running now, and the wizard can say "Step 2
 * of 8" instead of turning a mark for five minutes.
 *
 * A Server with a custom setup command prints no such headers: `step` stays
 * null and only the newest line says what is happening.
 *
 * Rejected: a percentage. The steps take very different times (Docker's
 * install is most of a run), so a bar filled by step count would rush
 * through six steps and sit still on one, which reads as stuck.
 */

/** The default script's steps, in its own numbering, said for the wizard's reader. */
export const SETUP_STEP_LABELS = [
  "Installing the basic tools",
  "Installing Docker, which runs your apps",
  "Getting Docker ready to run apps",
  "Creating the network your apps share",
  "Making Cloudgate's folders",
  "Starting the web gateway that serves your apps",
  "Getting the network for AI models ready",
  "Making apps start again after a restart",
] as const;

/** What the backend prints while a just-made machine does not answer yet. */
const WAITING_FOR_SSH = "Waiting for the machine to accept SSH";

/** `1. Installing required packages`: a step header, and its number. */
const STEP_HEADER = /^(\d)\.\s/;

/** The lines a run ends with (`server-setup-runs.ts`), which are not progress. */
const OUTCOME = /^(✅ Setup finished\.|❌ Setup failed:)/;

/** Where a Setup run is, from its output so far. */
export type SetupProgress = {
  /** The step running now, from 1; null before the first header, or with a custom command. */
  step: number | null;
  /** How many steps the default script has. */
  total: number;
  /** The machine was just made and does not accept SSH yet. */
  waitingForSsh: boolean;
  /** The newest line of output worth showing, as the machine said it; null with none yet. */
  latest: string | null;
};

export function setupProgress(lines: readonly string[]): SetupProgress {
  let step: number | null = null;
  let waitingForSsh = false;
  let latest: string | null = null;
  for (const raw of lines) {
    // A chunk can hold several lines; each counts on its own.
    for (const part of raw.split(/\r?\n/)) {
      const text = stripTerminalEscapes(part).trim();
      if (text === "" || OUTCOME.test(text)) continue;
      const header = STEP_HEADER.exec(text);
      if (header) {
        const number = Number(header[1]);
        if (number >= 1 && number <= SETUP_STEP_LABELS.length) {
          step = number;
          waitingForSsh = false;
          continue;
        }
      }
      if (text.startsWith(WAITING_FOR_SSH)) {
        waitingForSsh = step === null;
        continue;
      }
      // Any other line means the machine answered and the script runs.
      if (step === null) waitingForSsh = false;
      latest = text;
    }
  }
  return { step, total: SETUP_STEP_LABELS.length, waitingForSsh, latest };
}

/** Each step as done, now or to do, for a run at `step` (null: none started yet). */
export function setupStepStates(
  step: number | null,
  finished = false,
): { id: string; label: string; state: "done" | "now" | "todo" }[] {
  return SETUP_STEP_LABELS.map((label, index) => ({
    id: String(index + 1),
    label,
    state:
      finished || (step !== null && index + 1 < step)
        ? "done"
        : step === index + 1
          ? "now"
          : "todo",
  }));
}
