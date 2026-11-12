import { cn } from "@/lib/utils";
import { GEOMETRY, RADII, SHADOWS, TYPE_STEPS } from "../_lib/rows";
import { Label, Mono } from "./section";

/**
 * One class carries the whole recipe — size, leading, tracking and weight —
 * because a type decision made in four places is a type decision that drifts.
 * Weight is the one companion a component may override.
 */
export function TypeScale() {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {TYPE_STEPS.map((step) => (
        <li
          key={step.name}
          className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-4"
        >
          <p className={cn("min-w-0 flex-1 text-tx", step.cls)}>
            Deploy swarm-prod-2
          </p>
          <div className="flex flex-none flex-col gap-0.5 sm:w-64 sm:text-right">
            <Mono className="text-tx">text-{step.name}</Mono>
            <Mono className="text-tx-3">{step.recipe}</Mono>
            <span className="text-meta text-tx-3">{step.use}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Drawn, not listed. A geometry token is a measurement, and a measurement you
 * can only read as a number is a measurement nobody checks.
 */
export function Geometry() {
  return (
    <div className="flex flex-col gap-3">
      <Label>
        Every bar is that many pixels wide. The page measure is wider than a
        phone, so this scrolls inside its own box rather than pushing the page
        sideways.
      </Label>
      <div className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-3">
        <ul className="flex w-max flex-col gap-2">
          {GEOMETRY.map((item) => (
            <li key={item.name} className="flex items-center gap-3">
              <Mono className="w-24 flex-none text-tx">{item.name}</Mono>
              <span
                className={cn(
                  "h-4 flex-none rounded-sm bg-brand-tint ring-1 ring-brand-line",
                  item.barClass,
                )}
                aria-hidden="true"
              />
              <Mono className="flex-none text-tx">{item.px}px</Mono>
              <span className="flex-none text-meta text-tx-3">{item.use}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The radii are picked so base-nova's own class choices land on the prototype's
 * geometry: its buttons ask for rounded-lg, its cards for rounded-xl.
 */
export function Radii() {
  return (
    <ul className="flex flex-wrap gap-3">
      {RADII.map((r) => (
        <li key={r.name} className="flex flex-col gap-1.5">
          <span
            className={cn(
              "grid h-16 w-32 place-items-center border border-line bg-panel-2",
              r.cls,
            )}
            aria-hidden="true"
          >
            <Mono className="text-tx">{r.px}px</Mono>
          </span>
          <Mono className="text-tx">{r.cls}</Mono>
          <span className="max-w-32 text-meta text-tx-3">{r.use}</span>
        </li>
      ))}
    </ul>
  );
}

export function Shadows() {
  return (
    <ul className="flex flex-wrap gap-4">
      {SHADOWS.map((s) => (
        <li key={s.name} className="flex flex-col gap-1.5">
          <span
            className={cn(
              "grid h-16 w-40 place-items-center rounded-lg border border-line bg-panel",
              s.cls,
            )}
            aria-hidden="true"
          >
            <Mono className="text-tx">{s.cls}</Mono>
          </span>
          <span className="max-w-40 text-meta text-tx-3">{s.use}</span>
        </li>
      ))}
    </ul>
  );
}
