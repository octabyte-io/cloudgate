import { cn } from "@/lib/utils";

export type StepState = "done" | "now" | "todo";

const SEGMENT: Record<StepState, string> = {
  done: "bg-ok",
  now: "bg-warn",
  todo: "bg-raise-2",
};

export type SegmentedProgressProps = Omit<
  React.ComponentProps<"div">,
  "children"
> & {
  /** What the run is, for the sentence a screen reader gets. */
  label: string;
  /** One entry per step, in the order they run. */
  steps: { id: string; label: string; state: StepState }[];
  /** What a step is called in this run: "step", "resource", "service". */
  noun?: string;
};

/**
 * One segment per step, filled as each finishes (e-console.html:663-672).
 *
 * This is the companion to `Meter`, not a substitute for it: the meter shows
 * *how far along* a run is, and this shows *which step is running* — the thing
 * an operator actually wants at 3am. Put them one above the other, as the
 * reference does.
 *
 * The ribbon itself is `aria-hidden` and the sentence underneath it is the
 * accessible version: "Deploy: 7 of 12 steps done, now building the image." A
 * row of amber and green rectangles is not information anyone can hear, and
 * three states in three hues is exactly the sort of thing that has to carry its
 * words. Each segment also takes a `title`, so a pointer can find out which one
 * it is looking at.
 *
 * Past about thirty steps the segments stop being individually readable. That
 * is the point to switch to `Stepper` for the named phases and leave the
 * per-step detail to the log.
 */
export function SegmentedProgress({
  className,
  label,
  steps,
  noun = "step",
  ...props
}: SegmentedProgressProps) {
  const done = steps.filter((step) => step.state === "done").length;
  const now = steps.find((step) => step.state === "now");

  return (
    <div data-slot="segmented-progress" className={className} {...props}>
      <div aria-hidden="true" className="flex gap-0.75">
        {steps.map((step) => (
          <span
            key={step.id}
            title={step.label}
            className={cn(
              "h-1 flex-1 rounded-xs transition-colors duration-200",
              SEGMENT[step.state],
            )}
          />
        ))}
      </div>
      <p className="sr-only">
        {label}: {done} of {steps.length} {noun}s done
        {now ? `, now ${now.label}` : null}
      </p>
    </div>
  );
}
