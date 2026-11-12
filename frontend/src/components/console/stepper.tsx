import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

export type Step = {
  id: string;
  label: string;
  /** Finished. Shown as a tick, and reachable again if `onSelect` is given. */
  done?: boolean;
};

export type StepperProps = {
  /** Names the flow for a screen reader — "Create an Application". */
  label: string;
  steps: Step[];
  currentId: string;
  /** Omit to make the stepper a read-out rather than a control. */
  onSelect?: (id: string) => void;
  className?: string;
};

/**
 * Where someone is in a multi-step flow (e-console.html:803-822).
 *
 * A `<nav>` around an ordered list, because that is what it is: the steps have
 * a sequence, and `aria-current="step"` is the one attribute that says which
 * one you are on. Steps wrap onto a second line rather than shrinking — a
 * step whose label is clipped is a step nobody can use to navigate.
 */
export function Stepper({
  label,
  steps,
  currentId,
  onSelect,
  className,
}: StepperProps) {
  return (
    <nav aria-label={label}>
      <ol
        className={cn(
          "flex flex-wrap overflow-hidden rounded-xl border border-line bg-panel",
          className,
        )}
      >
        {steps.map((step, index) => {
          const current = step.id === currentId;
          const inner = (
            <>
              <span
                className={cn(
                  "grid size-pill flex-none place-items-center rounded-pill border text-chip font-semibold",
                  step.done
                    ? "border-transparent bg-ok text-primary-foreground"
                    : current
                      ? "border-transparent bg-brand text-primary-foreground"
                      : "border-line-2 text-tx-3",
                )}
                aria-hidden="true"
              >
                {step.done ? <Icon name="check" size={13} /> : index + 1}
              </span>
              <span
                className={cn(
                  "min-w-0 text-ui",
                  current
                    ? "font-semibold text-tx"
                    : step.done
                      ? "font-medium text-tx"
                      : "font-medium text-tx-2",
                )}
              >
                {step.label}
              </span>
            </>
          );

          // The current step keeps its tint under the pointer. A hover fill
          // that overwrote it would make "where I am" flicker off exactly
          // when someone reaches for it.
          const shared = cn(
            "flex w-full items-center gap-2.25 border-r border-line px-3.75 py-3.25 text-left last:border-r-0",
            current ? "bg-brand-tint" : "hover:bg-panel-2",
          );

          const state = step.done
            ? " — done"
            : current
              ? " — you are here"
              : "";

          return (
            <li key={step.id} className="flex min-w-0 flex-[1_1_150px]">
              {onSelect ? (
                <button
                  type="button"
                  aria-current={current ? "step" : undefined}
                  onClick={() => onSelect(step.id)}
                  className={shared}
                >
                  {inner}
                  <span className="sr-only">{state}</span>
                </button>
              ) : (
                <div
                  aria-current={current ? "step" : undefined}
                  className={shared}
                >
                  {inner}
                  <span className="sr-only">{state}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
