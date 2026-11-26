import type { Mark } from "@/lib/design/status";

/** Where one step of a moment restore is. */
export type MomentStepState =
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "not run";

export interface MomentStep {
  name: string;
  state: MomentStepState;
}

/** Each state as a mark: the word is the status, the glyph decoration. */
export const MOMENT_STEP_MARK: Record<MomentStepState, Mark> = {
  waiting: { glyph: "○", tone: "mute", label: "waiting" },
  running: { glyph: "◐", tone: "warn", label: "running" },
  done: { glyph: "●", tone: "ok", label: "done" },
  failed: { glyph: "✕", tone: "bad", label: "failed" },
  "not run": { glyph: "⊘", tone: "mute", label: "not run" },
};

/**
 * The steps of a Stack backup's moment restore (ADR-0092), read off its
 * run's log: Remove containers (Stop on a swarm stack), each volume in name
 * order, then Start — the order `buildMomentRestoreScript` runs them in, and
 * the `Step started: …` / `Step done: …` lines it writes for each.
 *
 * `outcome` is the restore request's own answer, which outranks the log: a
 * success marks every step done even if its last lines have not arrived yet,
 * and a failure marks the step the log was in failed and the rest not run.
 */
export function momentRestoreSteps({
  composeType,
  volumes,
  lines,
  outcome,
}: {
  composeType: "docker-compose" | "stack";
  volumes: readonly string[];
  lines: readonly string[];
  outcome: "running" | "done" | "failed";
}): MomentStep[] {
  const names = [
    composeType === "stack" ? "Stop" : "Remove containers",
    ...[...volumes].sort().map((volume) => `Restore ${volume}`),
    "Start",
  ];
  const said = (line: string) => lines.some((held) => held.includes(line));

  return names.map((name) => {
    if (outcome === "done" || said(`Step done: ${name}`)) {
      return { name, state: "done" };
    }
    const started = said(`Step started: ${name}`);
    if (outcome === "failed") {
      return { name, state: started ? "failed" : "not run" };
    }
    return { name, state: started ? "running" : "waiting" };
  });
}
