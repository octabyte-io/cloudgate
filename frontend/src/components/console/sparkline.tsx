import {
  PERCENT,
  PLOT_AREA,
  PLOT_FILL,
  PLOT_STROKE,
  plotGeometry,
  type PlotTone,
} from "@/lib/design/chart";
import { cn } from "@/lib/utils";

export type SparklineProps = {
  /** What this is a picture of. Read out; never only drawn. */
  label: string;
  values: number[];
  /** `hot` in trouble, `mute` when nothing is reporting, `dead` when stopped. */
  tone?: PlotTone;
  /** Defaults to 0–100. Everything the stats gateway streams is a percentage. */
  domain?: readonly [number, number];
  /** How to write a value in the summary: `(v) => `${v}%``. */
  format?: (value: number) => string;
  /** A dashed rule across the middle, for a series with a meaningful baseline. */
  baseline?: boolean;
  className?: string;
};

/**
 * The shape of a series, in a table cell or beside a figure
 * (e-console.html:748-754). Thirty pixels tall and no axes: it says *what has
 * been happening*, and the number beside it says what is happening now.
 *
 * The svg is `aria-hidden` and the component carries `role="img"` with a
 * sentence — low, high, latest — because a screen reader gets nothing from a
 * path and everything from "CPU, last 24 hours: 4% to 91%, now 62%". A `dead`
 * series is dashed as well as red, so "stopped" survives being printed in
 * greyscale or read by someone who cannot see the hue.
 */
export function Sparkline({
  label,
  values,
  tone = "brand",
  domain = PERCENT,
  format = String,
  baseline,
  className,
}: SparklineProps) {
  const height = 30;
  const { line, area } = plotGeometry(values, { height, domain });
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 0;
  const now = values.at(-1);

  return (
    <div
      role="img"
      data-slot="sparkline"
      aria-label={
        values.length
          ? `${label}: ${format(low)} to ${format(high)}, now ${format(now ?? 0)}`
          : `${label}: no data`
      }
      className={cn("h-spark w-full", className)}
    >
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="h-full w-full overflow-visible"
      >
        {baseline ? (
          <polyline
            points={`0,${height / 2} 100,${height / 2}`}
            className="nonscaling dash-thin fill-none stroke-line"
            strokeWidth={1}
          />
        ) : null}
        <polyline
          points={area}
          className={cn("stroke-none", PLOT_FILL[tone], PLOT_AREA[tone])}
        />
        <polyline
          points={line}
          strokeWidth={1.4}
          className={cn(
            "nonscaling fill-none",
            tone === "dead" && "dash-thin",
            PLOT_STROKE[tone],
          )}
        />
      </svg>
    </div>
  );
}
