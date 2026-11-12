import * as React from "react";

import { SeriesTable } from "@/components/console/series-table";
import {
  PERCENT,
  PLOT_AREA,
  PLOT_DOT,
  PLOT_FILL,
  PLOT_STROKE,
  plotGeometry,
  type PlotTone,
} from "@/lib/design/chart";
import { cn } from "@/lib/utils";

const HEIGHT = 40;
/** Four dashed rules, evenly spaced, plus the floor (e-console.html:2528-2530). */
const GRID = [1, 10.75, 20.5, 30.25, 40];

/**
 * Which points a strip of `count` evenly-spaced labels lands on.
 *
 * **`count` is capped at the number of points (F14).** Asking for four labels
 * from a two-point series sampled indices `0, 0, 1, 1` — so the strip printed
 * every label twice *and* React logged "two children with the same key" twice
 * per plot, because the caller's `tickCount` is a request about the ruler and
 * the series length is a fact about the data. Found on a real chart: a request
 * count bucketed by hour has two points in its first two hours.
 */
const ticksAt = (count: number, points: number) => {
  const wanted = Math.max(2, Math.min(count, points));
  return Array.from({ length: wanted }, (_, tick) =>
    Math.round((tick / (wanted - 1)) * (points - 1)),
  );
};

export type PlotProps = {
  /** What this is a picture of. Carried by the readout and the table. */
  label: string;
  values: number[];
  tone?: PlotTone;
  domain?: readonly [number, number];
  /** How to write a value: `(v) => `${v}%``. */
  format?: (value: number) => string;
  /** What to call the nth point: a time, a date, a build number. */
  labelAt?: (index: number) => string;
  /**
   * How many labels to put under the plot, **sampled from `labelAt`** rather
   * than passed in: a `justify-between` strip is evenly spaced whatever it
   * holds, so a caller's own round numbers land in the wrong places — the bug
   * the reference has. Sampled, the ruler and the line cannot disagree.
   */
  tickCount?: number;
  /**
   * A stretch at the start of the series that was never read, so its values
   * are unknown rather than zero: striped from the first point to `until`, a
   * fractional point index, and named by `label` both on the stripe and in
   * the frame's accessible name (`role="img"` hides what is inside it).
   */
  unread?: { until: number; label: string };
  className?: string;
};

/**
 * One series, plotted (e-console.html:716-747): dashed gridlines, a thin line,
 * a faint wash under it, time labels beneath.
 *
 * **Scrubbing.** A pointer moves a hairline that snaps to the nearest point, and
 * that value appears in a corner of the frame — a fixed place, so the readout
 * cannot collide with the line it describes or fall off the panel. The frame is
 * focusable, the arrow keys walk the series, and a live region says what hover
 * shows: a chart that only answers a mouse answers half its readers. Neither is
 * load-bearing — an `sr-only` table holds every value.
 *
 * The dot and the hairline are HTML over the svg rather than shapes inside it:
 * `preserveAspectRatio="none"` stretches the box to the panel's width, and a
 * circle in a stretched box is an ellipse.
 */
export function Plot({
  label,
  values,
  tone = "brand",
  domain = PERCENT,
  format = String,
  labelAt = (index) => `Point ${index + 1}`,
  tickCount = 0,
  unread,
  className,
}: PlotProps) {
  const [active, setActive] = React.useState<number | null>(null);
  const frame = React.useRef<HTMLDivElement>(null);
  const { line, area, at } = plotGeometry(values, { height: HEIGHT, domain });

  function scrubTo(clientX: number) {
    const box = frame.current?.getBoundingClientRect();
    if (!box || values.length === 0) return;
    const ratio = (clientX - box.left) / box.width;
    const index = Math.round(ratio * (values.length - 1));
    setActive(Math.max(0, Math.min(values.length - 1, index)));
  }

  function step(by: number) {
    setActive((current) => {
      const next = (current ?? values.length - 1) + by;
      return Math.max(0, Math.min(values.length - 1, next));
    });
  }

  /** Everything the scrub layer needs, or null when nothing is being scrubbed. */
  const cursor =
    active !== null && active < values.length
      ? { at: at[active], value: values[active], label: labelAt(active) }
      : null;

  /** Where the unread stretch ends, as a share of the frame's width. */
  const unreadWidth =
    unread && values.length > 0
      ? values.length === 1
        ? 100
        : Math.max(0, Math.min(1, unread.until / (values.length - 1))) * 100
      : null;

  return (
    // `relative` is load-bearing: an `sr-only` box with no containing block here
    // resolves against the initial one and widens the document (e-console:617).
    <div data-slot="plot" className={cn("relative min-w-0", className)}>
      <div
        ref={frame}
        tabIndex={0}
        role="img"
        aria-label={`${label}.${unread && unreadWidth !== null ? ` ${unread.label}.` : ""} Use the arrow keys to read each point.`}
        className="relative h-plot cursor-crosshair rounded-sm"
        onPointerMove={(event) => scrubTo(event.clientX)}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((current) => current ?? values.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") step(1);
          else if (event.key === "ArrowLeft") step(-1);
          else return;
          event.preventDefault();
        }}
      >
        <svg
          viewBox={`0 0 100 ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="h-full w-full overflow-visible"
        >
          {/* `nonscaling` on every line, never on the `<g>`: dasharray
              inherits and `vector-effect` does not, so a group carrying it
              dashes the grid and lets the viewBox stretch the dashes to 35px. */}
          <g className="dash-grid stroke-line" strokeWidth={1}>
            {GRID.map((y) => (
              <line
                key={y}
                className="nonscaling"
                x1={0}
                y1={y}
                x2={100}
                y2={y}
              />
            ))}
          </g>
          <polyline
            points={area}
            className={cn("stroke-none", PLOT_FILL[tone], PLOT_AREA[tone])}
          />
          <polyline
            points={line}
            strokeWidth={1.5}
            className={cn(
              "nonscaling fill-none [stroke-linecap:round] [stroke-linejoin:round]",
              tone === "dead" && "dash-thin",
              PLOT_STROKE[tone],
            )}
          />
        </svg>

        {unread && unreadWidth !== null ? (
          <span
            data-slot="plot-unread"
            style={{ width: `${unreadWidth}%` }}
            className="pointer-events-none absolute inset-y-0 left-0 grid place-items-center overflow-hidden border-r border-dashed border-warn-line unread-stripes p-1 text-center text-tick text-warn"
          >
            {unread.label}
          </span>
        ) : null}

        {cursor ? (
          <>
            <span
              aria-hidden="true"
              style={{ left: `${cursor.at.x}%` }}
              className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-line-2"
            />
            <span
              aria-hidden="true"
              style={{ left: `${cursor.at.x}%`, top: `${cursor.at.y}%` }}
              className={cn(
                "pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-pill ring-2 ring-panel",
                PLOT_DOT[tone],
              )}
            />
            {/* Value first: whoever is scrubbing knows which series they are on. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0 right-0 rounded-md border border-line bg-panel px-1.5 py-0.5 text-meta shadow-float"
            >
              <span className="num font-semibold text-tx">
                {format(cursor.value)}
              </span>{" "}
              <span className="text-tx-3">{cursor.label}</span>
            </span>
          </>
        ) : null}
      </div>

      {/* Outside the frame: `role="img"` prunes its own subtree, live region included. */}
      <p aria-live="polite" className="sr-only">
        {cursor ? `${cursor.label}: ${format(cursor.value)}` : ""}
      </p>

      {tickCount > 1 && values.length > 1 ? (
        <div className="mt-1.75 flex justify-between text-tick text-tx-3">
          {/* Keyed by its position in the strip, not by the point it names: two
              ticks can legitimately land on the same point once the cap above
              rounds, and a key has to identify the label rather than the datum. */}
          {ticksAt(tickCount, values.length).map((index, tick) => (
            <span key={tick} className="num">
              {labelAt(index)}
            </span>
          ))}
        </div>
      ) : null}

      <SeriesTable
        label={label}
        values={values}
        labelAt={labelAt}
        format={format}
      />
    </div>
  );
}
