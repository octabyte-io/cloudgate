import { Plot, type PlotProps } from "@/components/console/plot";
import { cn } from "@/lib/utils";

export type ChartProps = PlotProps & {
  /** What is being measured. The plot's own label, said out loud. */
  label: string;
  /** Where it stands now — the number the eye lands on. */
  value: React.ReactNode;
  /** The unit, set small beside the figure. */
  unit?: string;
  /** The line under the figure: the period, a delta, what it is an average of. */
  detail?: React.ReactNode;
};

/**
 * A number and its history, side by side (e-console.html:720-726, 2535-2540).
 *
 * The reading comes first and the plot explains it. That order is the whole
 * design: an operator wants "62%" and only then wants to know whether it has
 * been 62% all afternoon. Under 620px the two stack, number above plot, in the
 * same order.
 *
 * The figure wears text ink, never the series colour — a chart line can be a
 * pale amber and still read fine as a 1.5px stroke, while the same value as
 * 26px text on `--panel` would not. Identity comes from the mark beside the
 * words, not from tinting them.
 */
export function Chart({
  className,
  label,
  value,
  unit,
  detail,
  ...plot
}: ChartProps) {
  return (
    <div
      data-slot="chart"
      className={cn(
        "flex flex-col gap-4 hd:flex-row hd:items-stretch hd:gap-4.5",
        className,
      )}
    >
      <div className="flex-none pt-0.5 hd:w-chart-side">
        <p className="text-ui text-tx-2">{label}</p>
        <p className="mt-1.25 text-hero text-tx">
          {value}
          {unit ? (
            <small className="ml-0.75 text-meta font-medium text-tx-3">
              {unit}
            </small>
          ) : null}
        </p>
        {detail ? <p className="mt-1 text-meta text-tx-3">{detail}</p> : null}
      </div>
      <Plot label={label} className="flex-1" {...plot} />
    </div>
  );
}
