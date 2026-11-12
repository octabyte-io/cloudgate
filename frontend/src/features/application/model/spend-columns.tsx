import * as React from "react";

import { SERIES_FILL } from "@/lib/design/chart";
import { readCount } from "@/lib/format/token-spend";
import { cn } from "@/lib/utils";

import { dayLabel, type SpendDay } from "./token-spend-view";

/**
 * The estimated part's texture, over its own `--series-2` fill: panel-coloured
 * stripes at 45°, so "estimated" is a pattern as well as a hue — readable
 * under colour-vision deficiency, in print and in forced colours, where the
 * hue alone is not (`dataviz`: identity never rests on colour alone). Not
 * `hatch`, which means "does not exist yet"; these tokens do.
 */
const ESTIMATED_TEXTURE: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(45deg, color-mix(in oklab, var(--panel) 60%, transparent) 0 1.5px, transparent 1.5px 4px)",
};

/** The two parts, in stacking order: reported at the baseline, estimated on top. */
export const SPEND_PARTS = [
  {
    key: "reported" as const,
    label: "Reported",
    sub: "counted by the inference runtime",
    fill: SERIES_FILL[0],
    style: undefined,
  },
  {
    key: "estimated" as const,
    label: "Estimated",
    sub: "counted by the Gateway when the runtime did not",
    fill: SERIES_FILL[1],
    style: ESTIMATED_TEXTURE,
  },
];

/** A part's swatch, the same paint as its column segment. */
export function SpendSwatch({ part }: { part: (typeof SPEND_PARTS)[number] }) {
  return (
    <span
      aria-hidden="true"
      data-part={part.key}
      style={part.style}
      className={cn("size-2.5 flex-none rounded-xs", part.fill)}
    />
  );
}

/** Past this many columns the 1px seams between days would eat the columns. */
const SEAMLESS_AFTER = 120;

/**
 * Tokens per UTC day, a column each, the reported part at the baseline and
 * the estimated part stacked on it.
 *
 * One axis, from zero to the window's busiest day, which is written on the top
 * rule so the height of a column has a number to be read against. **Hovering
 * or arrowing** onto a day shows its date, both parts and their sum in a fixed
 * corner of the frame, and a live region says the same; an `sr-only` table
 * holds every day, so neither is load-bearing.
 */
export function SpendColumns({
  label,
  days,
  className,
}: {
  label: string;
  days: SpendDay[];
  className?: string;
}) {
  const [active, setActive] = React.useState<number | null>(null);
  const frame = React.useRef<HTMLDivElement>(null);
  const peak = Math.max(0, ...days.map((d) => d.reported + d.estimated));
  const last = days.length - 1;

  function pointAt(clientX: number) {
    const box = frame.current?.getBoundingClientRect();
    if (!box || days.length === 0 || box.width === 0) return;
    const index = Math.floor(((clientX - box.left) / box.width) * days.length);
    setActive(Math.max(0, Math.min(last, index)));
  }

  function step(by: number) {
    setActive((current) => Math.max(0, Math.min(last, (current ?? last) + by)));
  }

  const cursor = active !== null && active <= last ? days[active] : null;
  const reading = cursor
    ? `${dayLabel(cursor.day)}: ${readCount(cursor.reported + cursor.estimated)} tokens, ${readCount(cursor.reported)} reported, ${readCount(cursor.estimated)} estimated`
    : "";
  const ticks =
    days.length > 2 ? [0, Math.floor(last / 2), last] : days.map((_, i) => i);

  return (
    // `relative`: the `sr-only` table needs a containing block (series-table.tsx).
    <div
      data-slot="spend-columns"
      className={cn("relative min-w-0", className)}
    >
      <div className="mb-1 flex justify-between text-tick text-tx-3">
        <span className="num">{readCount(peak)}</span>
        <span>tokens a day</span>
      </div>
      <div
        ref={frame}
        tabIndex={0}
        role="img"
        aria-label={`${label}. Use the arrow keys to read each day.`}
        className={cn(
          "relative flex h-plot cursor-crosshair items-end rounded-sm border-y border-dashed border-line",
          days.length <= SEAMLESS_AFTER && "gap-px",
        )}
        onPointerMove={(event) => pointAt(event.clientX)}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((current) => current ?? last)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") step(1);
          else if (event.key === "ArrowLeft") step(-1);
          else return;
          event.preventDefault();
        }}
      >
        {days.map((day, index) => {
          const total = day.reported + day.estimated;
          return (
            <div
              key={day.day}
              aria-hidden="true"
              className={cn(
                "flex h-full min-w-0 flex-1 basis-0 flex-col-reverse",
                active !== null && active !== index && "opacity-55",
              )}
            >
              {SPEND_PARTS.map((part) =>
                day[part.key] > 0 ? (
                  <span
                    key={part.key}
                    data-part={part.key}
                    style={{
                      ...part.style,
                      height: `${(day[part.key] / (peak || 1)) * 100}%`,
                    }}
                    className={cn(
                      "block flex-none",
                      part.fill,
                      // The top of the stack gets the rounded data-end.
                      (part.key === "estimated" || day.estimated === 0) &&
                        "rounded-t-xs",
                      // A 1px surface seam between the two parts.
                      part.key === "estimated" &&
                        day.reported > 0 &&
                        "border-b border-panel",
                    )}
                  />
                ) : null,
              )}
              {total === 0 ? <span className="block h-px bg-line" /> : null}
            </div>
          );
        })}

        {cursor ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1 right-0 rounded-md border border-line bg-panel px-1.5 py-0.5 text-meta shadow-float"
          >
            <span className="num font-semibold text-tx">
              {readCount(cursor.reported + cursor.estimated)}
            </span>{" "}
            <span className="text-tx-3">
              {dayLabel(cursor.day)} · {readCount(cursor.estimated)} estimated
            </span>
          </span>
        ) : null}
      </div>

      {/* Outside the frame: `role="img"` prunes its own subtree. */}
      <p aria-live="polite" className="sr-only">
        {reading}
      </p>

      {days.length > 1 ? (
        <div className="mt-1.75 flex justify-between text-tick text-tx-3">
          {ticks.map((index, tick) => (
            <span key={tick} className="num">
              {dayLabel(days[index].day)}
            </span>
          ))}
        </div>
      ) : null}

      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Reported tokens</th>
            <th scope="col">Estimated tokens</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}>
              <th scope="row">{dayLabel(day.day)}</th>
              <td>{readCount(day.reported)}</td>
              <td>{readCount(day.estimated)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
