import { LogWell, type LogLine } from "@/components/console/log-well";
import { SegmentedProgress } from "@/components/console/segmented-progress";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { toSetupLines } from "../server/infrastructure/setup-log-tones";
import {
  SETUP_STEP_LABELS,
  setupProgress,
  setupStepStates,
} from "./setup-progress";

/**
 * A Setup run in the wizard, while it runs: which step of eight it is on, in
 * plain words, a ribbon of the eight, and the newest line the machine
 * printed, so a run that takes minutes visibly moves. The whole output is
 * one press away, folded, for whoever wants to read it.
 *
 * The headline is the live region, not the newest line: a screen reader is
 * told each step as it starts, never each line `apt-get` prints.
 *
 * Rejected: a turning mark beside "Installing what apps need" for the whole
 * run. It said nothing for five minutes, and a run that had stalled looked
 * the same as one that was working.
 */
export function SetupProgressView({
  lines,
  dropped = 0,
  live,
  finished = false,
  label = "Setting up your server",
}: {
  /** The run's output so far. */
  lines: readonly string[];
  dropped?: number;
  /** The run is going and its output still arriving. */
  live: boolean;
  /** The run has finished well: every step done. */
  finished?: boolean;
  /** What the ribbon is, for a screen reader. */
  label?: string;
}) {
  const progress = setupProgress(lines);
  const { step, total } = progress;
  // Over without finishing: the step it stopped on, and no live mark.
  const stopped = !live && !finished && lines.length > 0;
  const headline = finished
    ? "Every step is done"
    : stopped
      ? step !== null
        ? `Stopped at step ${step}: ${SETUP_STEP_LABELS[step - 1]}`
        : "Stopped"
      : progress.waitingForSsh
        ? "Waiting for the new machine to start up"
        : step !== null
          ? SETUP_STEP_LABELS[step - 1]
          : lines.length > 0
            ? "Setting up"
            : "Connecting to your server";

  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p
          aria-live="polite"
          className="flex min-w-0 items-center gap-2 text-body font-medium wrap-anywhere text-tx"
        >
          {finished ? (
            <Icon name="check" size={14} className="flex-none text-ok" />
          ) : stopped ? (
            <Icon name="alert" size={14} className="flex-none text-bad" />
          ) : (
            <span
              aria-hidden="true"
              className="size-2 flex-none rounded-pill bg-warn motion-safe:animate-pulse"
            />
          )}
          <span>{headline}</span>
        </p>
        {step !== null && !finished && !stopped ? (
          <p className="num flex-none text-meta text-tx-3">
            Step {step} of {total}
          </p>
        ) : null}
      </div>
      {/* A custom setup command has no steps to count, so no ribbon. */}
      {step !== null || finished || lines.length === 0 ? (
        <SegmentedProgress
          label={label}
          steps={setupStepStates(step, finished)}
        />
      ) : null}
      {progress.latest && live ? (
        // Keyed on the line, so each new one fades in where the last stood:
        // the motion is the run moving, and it never shifts the row.
        <p
          key={progress.latest}
          title={progress.latest}
          className="animate-fade truncate font-mono text-meta text-tx-3"
        >
          {progress.latest}
        </p>
      ) : null}
      {lines.length > 0 ? (
        <OutputFold
          label="Setup output"
          lines={toSetupLines(lines)}
          live={live}
          dropped={dropped}
        />
      ) : null}
    </div>
  );
}

/**
 * A run's whole output, folded under "Show what's happening": there for
 * whoever wants it, out of the way of whoever doesn't.
 */
export function OutputFold({
  label,
  lines,
  live,
  dropped,
  className,
}: {
  label: string;
  lines: readonly LogLine[];
  live: boolean;
  dropped?: number;
  className?: string;
}) {
  return (
    <details className={cn("group grid gap-2", className)}>
      {/* Our own chevron in place of the browser's marker, turning as the
          output folds open. */}
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-ui text-tx-2 transition-colors duration-100 hover:text-tx [&::-webkit-details-marker]:hidden">
        <Icon
          name="chevR"
          size={14}
          className="flex-none transition-transform duration-150 ease-out-strong group-open:rotate-90"
        />
        Show what&rsquo;s happening
      </summary>
      <LogWell
        label={label}
        lines={lines}
        live={live}
        dropped={dropped}
        className="mt-2"
      />
    </details>
  );
}
