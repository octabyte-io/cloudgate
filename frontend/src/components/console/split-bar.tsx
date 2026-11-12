import { SERIES_FILL, seriesSlot } from "@/lib/design/chart";
import { cn } from "@/lib/utils";

export type SplitPart = {
  id: string;
  /** The word for this part. It appears in the legend, always. */
  label: string;
  /** The number the geometry is built from. */
  value: number;
  /** How to write that number, if it is not just the number: "12.4 GB". */
  display?: string;
};

export type SplitBarProps = Omit<React.ComponentProps<"div">, "children"> & {
  /** What the whole is: "Disk used by Docker", "Deployments this week". */
  label: React.ReactNode;
  parts: SplitPart[];
  /** How to write the total. Defaults to the plain sum. */
  format?: (total: number) => string;
};

/**
 * A total split by its parts (e-console.html:674-681).
 *
 * The total is the **sum of the parts** — it is computed here and cannot be
 * passed in, which is deliberate: a bar drawn against a number nobody supplied
 * data for is a bar against an invented quota, and this product has no quotas.
 * If a real ceiling exists, that is a `Meter`.
 *
 * Colour here means *which part*, never how it is doing, so the segments take
 * the categorical `--series-*` ramp and not the status tones (see
 * `lib/design/chart.ts`). Two consequences, both non-negotiable:
 *
 * - **The legend is always rendered.** Two or more parts means identity can
 *   never rest on colour-matching alone, and the legend is also where the
 *   numbers live, since a 2px-wide segment has nowhere to put a label.
 * - **A fifth part is not a fifth hue.** Anything past the fourth is painted as
 *   "other". Aggregate before you get here if that is not what you want.
 *
 * Segments grow rather than being given widths, so the 2px seams between them
 * come out of the available space instead of pushing the last part past the
 * end of the bar.
 */
export function SplitBar({
  className,
  label,
  parts,
  format = String,
  ...props
}: SplitBarProps) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);

  return (
    <div data-slot="split-bar" className={className} {...props}>
      <div className="mb-1.75 flex items-baseline gap-2 text-ui">
        <span className="min-w-0 flex-1 text-tx-2">{label}</span>
        <span className="num font-medium text-tx">{format(total)}</span>
      </div>
      <div
        aria-hidden="true"
        className="flex h-2 gap-0.5 overflow-hidden rounded-pill bg-raise-2"
      >
        {parts.map((part, index) => (
          <span
            key={part.id}
            title={`${part.label}: ${part.display ?? format(part.value)}`}
            style={{ flexGrow: part.value }}
            className={cn(
              "h-full basis-0 rounded-xs",
              SERIES_FILL[seriesSlot(index)],
            )}
          />
        ))}
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta">
        {parts.map((part, index) => (
          <div key={part.id} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                "size-2 rounded-xs",
                SERIES_FILL[seriesSlot(index)],
              )}
            />
            <dt className="text-tx-2">{part.label}</dt>
            <dd className="num font-medium text-tx">
              {part.display ?? format(part.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
