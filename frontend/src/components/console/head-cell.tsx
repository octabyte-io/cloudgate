import { TableHead } from "@/components/ui/table";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/** Which column a table is ordered by, and which way. */
export type SortState = { id: string; dir: "asc" | "desc" };

/** Ascending, then descending. A third click does not clear it: a table with no
 *  order is not a state anyone asks a header for. */
export const nextSort = (
  current: SortState | undefined,
  id: string,
): SortState =>
  current?.id === id && current.dir === "asc"
    ? { id, dir: "desc" }
    : { id, dir: "asc" };

export type HeadCellProps = React.ComponentProps<"th"> & {
  /**
   * `"none"` means "this column sorts, but not right now". Omit the prop
   * entirely for a column that does not sort at all — the difference matters,
   * because `aria-sort="none"` is a promise that the header is actionable.
   */
  sort?: "asc" | "desc" | "none";
  onSort?: () => void;
  align?: "left" | "right";
};

/**
 * A table head cell, sortable or not (e-console.html:621-626).
 *
 * `aria-sort` goes on the `th` — that is the element the header row is made of
 * — and the button inside it is what a pointer and the keyboard actually hit.
 * The arrow is `--tx-4` while the column is unsorted and `--tx-2` once it is:
 * decoration until it means something.
 *
 * **The button fills the cell's height, and that is a hit-target fix** (F19).
 * It used to size to its own text — 18px tall inside a 38px header row — so the
 * one control on every table in the console was the one control below the 26px
 * floor the rest of the system keeps (`Button`'s smallest size, `xs`, is exactly
 * `h-6.5`). The row already reserved the space; the target simply was not
 * claiming it. Nothing moves visually: `items-center` keeps the label where it
 * was, and the target goes 18px → 38px.
 *
 * **A header is one line, in the table's one face**. It is a label
 * over values, so it does not take the values' styling: a column's `className`
 * reaches its header too (for widths), and on the Servers, Deployments,
 * Variables and Domains tables that carried `font-mono` up into "Address",
 * "Duration", "Key" and "Host" beside sans neighbours. `font-sans` and
 * `whitespace-nowrap` therefore come *after* the caller's classes.
 *
 * An earlier fix once let headers wrap, because a `nowrap` header is its column's
 * minimum and "Container port" and "Sign-in required" held the Application
 * Domains row's Remove behind the scroll at 1470px. Two-line headers were the
 * cost of that, and they showed at desktop width; the answer is short
 * header words ("Port", "Sign-in", "Service"), which `data-table.test.tsx`
 * pins, rather than a header that wraps.
 *
 * **A right-aligned header is right-aligned all the way down**: the sort
 * button fills the cell, so it is the button that has to push its label to the
 * end, or a numeric column's head sits at the left over values at the right.
 *
 * Exported on its own so a screen with one bespoke table (a matrix, a nested
 * head) still gets the console's header rather than reinventing it.
 */
export function HeadCell({
  className,
  sort,
  onSort,
  align = "left",
  children,
  ...props
}: HeadCellProps) {
  const inner = (
    <span
      className={cn(
        "flex items-center gap-1.25",
        align === "right" && "justify-end",
      )}
    >
      {children}
      {sort ? (
        <Icon
          name={sort === "asc" ? "chevU" : sort === "desc" ? "chevD" : "chevUD"}
          size={13}
          className={sort === "none" ? "text-tx-4" : "text-tx-2"}
        />
      ) : null}
    </span>
  );

  return (
    <TableHead
      aria-sort={
        sort === "asc"
          ? "ascending"
          : sort === "desc"
            ? "descending"
            : sort
              ? "none"
              : undefined
      }
      className={cn(
        "h-thead border-b border-line bg-panel-2 px-3 text-ui font-semibold text-tx-2",
        align === "right" && "text-right",
        className,
        "font-sans whitespace-nowrap",
      )}
      {...props}
    >
      {sort ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "flex min-h-thead w-full cursor-pointer items-center hover:text-tx",
            align === "right" && "justify-end",
          )}
        >
          {inner}
        </button>
      ) : (
        inner
      )}
    </TableHead>
  );
}
