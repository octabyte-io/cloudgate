import { Chip } from "@/components/console/chip";
import type { FieldDiff } from "@/lib/api/endpoints/project-config";

/**
 * The fields a plan step's create or change writes, as the config names
 * them, each a native line marked native. Out of
 * `plan-step-row.tsx`, which holds what a step is; this is what one line of
 * it reads.
 */
export function FieldList({
  fields,
  created,
}: {
  fields: FieldDiff[];
  created: boolean;
}) {
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 border-l border-line pl-3 text-meta">
      {fields.map((diff) => (
        <div key={diff.field} className="contents">
          <dt className="min-w-0 font-mono wrap-anywhere text-tx-2">
            {diff.field}
          </dt>
          <dd className="min-w-0 font-mono wrap-anywhere text-tx">
            {created ? null : (
              <>
                <span className="text-tx-3 line-through">
                  {sideValue(diff.from, sideOf(diff, "from"))}
                </span>
                <span className="px-1.5 text-tx-3" aria-label="becomes">
                  →
                </span>
              </>
            )}
            <span>{sideValue(diff.to, sideOf(diff, "to"))}</span>
            {diff.native ? (
              <Chip variant="mono" className="ml-2">
                native
              </Chip>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Where one side of a line's value comes from: written in the file, or, on
 * a native line, the kind's default, the console's value of a
 * setting it owns, or the size's value of a size-bearing setting
 * One at a time: the API sends at most one flag per side.
 */
export type FieldSide = "written" | "default" | "console" | "size";

/** The side `end` of `diff` is, read from the API's flags. */
export function sideOf(diff: FieldDiff, end: "from" | "to"): FieldSide {
  const from = end === "from";
  if (from ? diff.fromSize : diff.toSize) return "size";
  if (from ? diff.fromConsole : diff.toConsole) return "console";
  if (from ? diff.fromDefault : diff.toDefault) return "default";
  return "written";
}

/**
 * One side of a line: its value as written, or what it stands for, its
 * value in brackets: `default (none)`, `console (50)`,
 * `size (db.t4g.medium)`.
 */
export function sideValue(value: unknown, side: FieldSide = "written"): string {
  if (side === "written") return formatValue(value);
  const shown =
    value === null || value === undefined ? "none" : formatValue(value);
  return `${side} (${shown})`;
}

/** A field's value as the config would write it. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (Array.isArray(value)) {
    return value.length === 0 ? "none" : value.map(formatValue).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => `${key}: ${formatValue(inner)}`)
      .join(", ");
  }
  return String(value);
}
