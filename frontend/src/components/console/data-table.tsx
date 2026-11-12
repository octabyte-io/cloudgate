import * as React from "react";

import {
  HeadCell,
  nextSort,
  type SortState,
} from "@/components/console/head-cell";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The console's table (e-console.html:612-652). Column definitions in, rows
 * out — so a screen declares what its columns *are* rather than assembling
 * `<td>`s, and every table in the app sorts, selects and truncates the same way.
 *
 * Two things are structural, not cosmetic. **The horizontal scroll belongs to
 * the table**, never the page — it lives in `ui/table.tsx`'s container. And
 * **selection is carried by the checkbox, not the row**: `aria-selected` is only
 * meaningful inside a `grid`/`treegrid`, so the checkbox announces the state and
 * the `--brand-tint` fill follows it through `data-selected`.
 *
 * **A table that scrolls says so**. At phone width most tables are
 * wider than their card, and nothing showed it: the row's actions sat
 * off-screen and read as missing. So the side that has more gets a fade, and a
 * last column with no visible head — the row's actions, by the console's own
 * convention of an `sr-only` "Actions" head — is pinned to the right edge, so
 * the thing a row is *for* is always on screen. A stacked card layout below
 * the small breakpoint was the other option; it would mean every column set
 * saying which of its cells is the title, for the same result.
 *
 * **The empty state sits under the scroller, not in it.** In a `colSpan` cell
 * it was centred across the table's full scroll width, so at 390px its text
 * ran off both edges of the card.
 *
 * Sorting and selection are held here, uncontrolled, with a callback out. No
 * `@tanstack/react-table`: a table library is a dependency to justify, not a
 * default, and two `useState`s and a `useMemo` do it in one file.
 */

export type CellTone = "key" | "num" | "wrap" | "muted";

/**
 * The cell recipes from `.dt td`: what the row *is*, a figure (right-aligned and
 * tabular), prose that wraps and stops shrinking at 220px, and an aside.
 */
const CELL: Record<CellTone, string> = {
  key: "font-medium text-tx",
  num: "text-right num",
  // `wrap-anywhere` because the values that are too long for a row are mostly
  // identifiers — an image, a path — with no space in them to wrap at, and
  // without it such a cell is exactly as wide as the string. Prose still
  // wraps at its spaces first: this only breaks a word that cannot fit at all.
  wrap: "min-w-55 whitespace-normal wrap-anywhere",
  muted: "text-tx-3",
};

export type Column<T> = {
  id: string;
  head: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  tone?: CellTone;
  /** Give a column a comparator and its head becomes a sort button. */
  compare?: (a: T, b: T) => number;
  /** Width or shrink behaviour, when the content cannot decide it alone. */
  className?: string;
  /**
   * A long single-line value — a user agent, a host, a container name — that
   * should end in an ellipsis rather than widen the table.
   *
   * **A `truncate` class inside a cell does nothing on its own**
   * The table is
   * auto-layout, so a cell is as wide as its longest unbreakable line, and an
   * ellipsis needs a box whose width something else decided. At five sites that
   * pushed the row's Actions behind the horizontal scroll at desktop width. So
   * the bound is the table's: the truncating columns share, equally, whatever
   * width the others leave, down to a floor, and the cell's content is clipped to
   * that. Carry the full value on a `title`. `truncating-cells-are-bounded.test.ts`
   * holds every cell that truncates to saying so here.
   */
  truncate?: boolean;
};

/**
 * Whether a column is the row's actions: the last column, with a head that is
 * there for a screen reader only. That is how every Actions column in the
 * console is written, so no column set has to opt in to being pinned.
 */
function isActions<T>(column: Column<T> | undefined): boolean {
  if (!column || !React.isValidElement<{ className?: unknown }>(column.head)) {
    return false;
  }
  const { className } = column.head.props;
  return typeof className === "string" && /(^|\s)sr-only(\s|$)/.test(className);
}

type Edges = { start: boolean; end: boolean };

/**
 * Which sides of the table's scroller have more table beyond them. Read off the
 * container `ui/table.tsx` renders, on scroll and whenever it or the table
 * resizes. jsdom has no layout, so there it is always `{false, false}`.
 */
function useScrollEdges(): [React.RefObject<HTMLDivElement | null>, Edges] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState<Edges>({ start: false, end: false });

  React.useEffect(() => {
    const scroller = ref.current?.querySelector<HTMLElement>(
      '[data-slot="table-container"]',
    );
    if (!scroller) return;
    const measure = () => {
      const { scrollLeft, scrollWidth, clientWidth } = scroller;
      const start = scrollLeft > 1;
      const end = scrollLeft + clientWidth < scrollWidth - 1;
      setEdges((prev) =>
        prev.start === start && prev.end === end ? prev : { start, end },
      );
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(scroller);
    if (scroller.firstElementChild)
      observer?.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  return [ref, edges];
}

/** The fade on a side that has more table beyond it. Tokens, not a shadow value. */
const FADE =
  "pointer-events-none absolute inset-y-0 z-20 w-6 from-panel to-transparent";

export type DataTableProps<T> = {
  /** The table's accessible name. Rendered as an `sr-only` caption. */
  label: string;
  columns: Column<T>[];
  rows: T[];
  /** Stable per row. Required for selection, and the React key throughout. */
  getRowId: (row: T) => string;
  defaultSort?: SortState;
  /** Turn on the checkbox column. */
  selectable?: boolean;
  onSelectionChange?: (ids: string[]) => void;
  /** What the row is, for its checkbox's label. */
  rowName?: (row: T) => string;
  /** Shown in place of the body when there are no rows. */
  empty?: React.ReactNode;
  className?: string;
  /**
   * Extra classes for one row's `<tr>` — `animate-rise` on a row a mutation
   * just added, `animate-fade` on one whose status just changed. Never on
   * every row: motion marks the row that is new, not the list.
   */
  rowClassName?: (row: T) => string | undefined;
};

export function DataTable<T>({
  label,
  columns,
  rows,
  getRowId,
  defaultSort,
  selectable,
  onSelectionChange,
  rowName,
  empty,
  className,
  rowClassName,
}: DataTableProps<T>) {
  const [sort, setSort] = React.useState<SortState | undefined>(defaultSort);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    new Set(),
  );

  const sorted = React.useMemo(() => {
    const column = columns.find((c) => c.id === sort?.id);
    if (!column?.compare) return rows;
    const out = [...rows].sort(column.compare);
    return sort?.dir === "desc" ? out.reverse() : out;
  }, [columns, rows, sort]);

  function commit(next: ReadonlySet<string>) {
    setSelected(next);
    onSelectionChange?.([...next]);
  }

  function toggle(id: string, on: boolean) {
    const draft = new Set(selected);
    if (on) draft.add(id);
    else draft.delete(id);
    commit(draft);
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;

  // A percentage width is what makes a column take the slack in an auto-layout
  // table: every other column gets the width its content needs, and these split
  // the rest. It is a share of the table, not a design value, so it is computed
  // rather than a token — and the shares add up to 100%, because percentages
  // past that are cut back in column order, which would hand one column all of
  // the slack and leave the others at their floor.
  const truncating = columns.filter((column) => column.truncate).length;
  const share = truncating > 0 ? `${100 / truncating}%` : undefined;

  const [scrollRef, edges] = useScrollEdges();
  const pinned = isActions(columns.at(-1)) ? columns.at(-1)?.id : undefined;
  // The pinned cell is opaque, so rows pass *under* it, and while there is
  // more table to its left it carries the fade on its own left edge — the
  // scroller's right edge is the pinned column, not the table's end.
  const pin = (head: boolean) =>
    cn(
      "sticky right-0 z-10",
      head
        ? "bg-panel-2"
        : "bg-panel group-hover/row:bg-panel-2 group-data-selected/row:bg-brand-tint",
      edges.end &&
        cn(
          "before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-6 before:bg-linear-to-l before:to-transparent",
          head ? "before:from-panel-2" : "before:from-panel",
        ),
    );
  const showEmpty = sorted.length === 0 && !!empty;

  return (
    <>
      <div ref={scrollRef} className="relative">
        <Table className={cn("w-full text-ui", className)}>
          <caption className="sr-only">{label}</caption>
          <TableHeader>
            <TableRow className="hover:bg-panel-2">
              {selectable ? (
                <HeadCell className="w-8.5 pr-0">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={selected.size > 0 && !allSelected}
                    onCheckedChange={(next) =>
                      commit(next ? new Set(rows.map(getRowId)) : new Set())
                    }
                    aria-label={
                      allSelected ? "Clear selection" : "Select all rows"
                    }
                  />
                </HeadCell>
              ) : null}
              {columns.map((column) => (
                <HeadCell
                  key={column.id}
                  align={column.tone === "num" ? "right" : "left"}
                  className={cn(
                    column.truncate && "min-w-32",
                    column.className,
                    column.id === pinned && pin(true),
                  )}
                  style={column.truncate ? { width: share } : undefined}
                  sort={
                    !column.compare
                      ? undefined
                      : sort?.id === column.id
                        ? sort.dir
                        : "none"
                  }
                  onSort={() =>
                    setSort((current) => nextSort(current, column.id))
                  }
                >
                  {column.head}
                </HeadCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => {
              const id = getRowId(row);
              const isSelected = selected.has(id);
              return (
                <TableRow
                  key={id}
                  data-selected={isSelected || undefined}
                  className={cn(
                    "group/row border-b border-line transition-colors duration-100 hover:bg-panel-2 data-selected:bg-brand-tint",
                    rowClassName?.(row),
                  )}
                >
                  {selectable ? (
                    <TableCell className="h-row w-8.5 px-3 pr-0">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(next) => toggle(id, next)}
                        aria-label={`Select ${rowName?.(row) ?? id}`}
                      />
                    </TableCell>
                  ) : null}
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      className={cn(
                        "h-row px-3 text-tx-2",
                        column.tone && CELL[column.tone],
                        column.className,
                        column.id === pinned && pin(false),
                      )}
                    >
                      {column.truncate ? (
                        // A fixed width takes the string out of the column's
                        // measure, so it cannot widen it, and is the column's
                        // floor. It was `w-0`, which let the Sessions Device
                        // column shrink to nothing at phone width.
                        // `min-w-full` gives it the width the column was dealt.
                        <div className="w-32 min-w-full truncate">
                          {column.cell(row)}
                        </div>
                      ) : (
                        column.cell(row)
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {edges.start ? (
          <div aria-hidden className={cn(FADE, "left-0 bg-linear-to-r")} />
        ) : null}
        {edges.end && !pinned ? (
          <div aria-hidden className={cn(FADE, "right-0 bg-linear-to-l")} />
        ) : null}
      </div>
      {/* The head stays: the columns are the promise of what will be here. */}
      {showEmpty ? <div data-slot="table-empty">{empty}</div> : null}
    </>
  );
}
