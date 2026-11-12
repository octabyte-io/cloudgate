import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

export type StatTileProps = Omit<React.ComponentProps<"div">, "children"> & {
  label: string;
  value: React.ReactNode;
  /** The unit, set small beside the figure: `%`, `GB`, `req/s`. */
  unit?: string;
  /** The line under the figure — a delta, a period, what it is measured over. */
  detail?: React.ReactNode;
  /** A sparkline, sitting under the figure. Optional by design. */
  trend?: React.ReactNode;
  /** A number that ticks in place. Switches the figure to tabular. */
  live?: boolean;
  /** Marks the label as having something to explain. */
  info?: boolean;
  /** Takes the full width of a `StatGrid`. */
  wide?: boolean;
};

/**
 * One figure and what it is (e-console.html:686-692). Label, value, unit,
 * detail — in that order, because the label is what someone is looking *for*
 * and the figure is what they are looking *at*.
 *
 * Figures are proportional by default and tabular only when `live`: a
 * standalone number at 22px looks loose in tabular figures, where every digit
 * takes the width of a `0` — but a number that ticks in place must not shuffle
 * the words beside it on every tick. Columns of figures in a table are always
 * tabular; that is `DataTable`'s `num` cell, not this.
 */
export function StatTile({
  className,
  label,
  value,
  unit,
  detail,
  trend,
  live,
  info,
  wide,
  ...props
}: StatTileProps) {
  return (
    <div
      data-slot="stat"
      className={cn(
        "rounded-lg border border-line bg-panel px-3 py-2.75",
        wide && "col-span-full",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-1 text-meta text-tx-3">
        {label}
        {info ? <Icon name="info" size={12} /> : null}
      </div>
      <div className={cn("mt-1.5 text-fig text-tx", live && "num")}>
        {value}
        {unit ? (
          <small className="ml-0.75 text-meta font-medium text-tx-3">
            {unit}
          </small>
        ) : null}
      </div>
      {detail ? (
        <div className="mt-0.75 text-meta text-tx-3">{detail}</div>
      ) : null}
      {trend ? <div className="mt-2">{trend}</div> : null}
    </div>
  );
}

/**
 * Two columns of tiles, which is what the reference's right rail holds
 * (e-console.html:686). A `wide` tile spans both.
 */
export function StatGrid({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-grid"
      className={cn("grid grid-cols-2 gap-2.5", className)}
      {...props}
    />
  );
}
