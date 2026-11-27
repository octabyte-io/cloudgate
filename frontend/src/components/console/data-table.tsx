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
 * **A table that does not fit its box stacks; it never scrolls sideways.**
 * This reverses an earlier call. At phone width most tables were wider than
 * their card, and the answer then was a horizontal scroll with a fade and the
 * Actions column pinned to the right edge. That kept the row's actions on
 * screen but left everything between the first column and the actions behind a
 * sideways gesture nobody makes on purpose. A stacked layout was turned down
 * because every column set would have to say which cell is its title; it does
 * not: the first column is the row's title by the console's own convention, and
 * a last column with an `sr-only` head is its actions. So when the table's
 * natural width is more than its box — measured, not guessed from a breakpoint,
 * because the same table sits in a full-width page and in a half-width card —
 * each row becomes a block: the title and the actions on one line, then the
 * other columns as label and value pairs. The table comes back once its box is
 * as wide as the table needed. Sorting is a table control and is not offered in
 * the stack, which keeps the order the table last had. The fade and the pinned
 * Actions stay as the table's own fallback for the moment before the measure.
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

/**
 * The one part of a column's `className` a stacked row keeps: its face. The
 * rest are widths and alignment for a table cell, which mean nothing in a
 * label and value pair.
 */
function stackFace<T>(column: Column<T>): string | undefined {
  return /(^|\s)font-mono(\s|$)/.test(column.className ?? "")
    ? "font-mono"
    : undefined;
}

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
function useScrollEdges(
  active: boolean,
): [React.RefObject<HTMLDivElement | null>, Edges] {
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
  }, [active]);

  return [ref, edges];
}

/**
 * Whether the table fits its box, or its rows should stack. jsdom has no
 * layout, so there it always fits.
 *
 * Measured in a layout effect so a table that does not fit is never painted:
 * the table renders, is found too wide, and the stack replaces it before the
 * frame. `needed` is the width the table asked for when it was last laid out,
 * and the box has to reach it before the table is tried again — otherwise a
 * box one pixel short would flip between the two on every resize. A change in
 * the number of rows or in the columns tries the table again, since what it
 * needs may have changed. `shape` is a string on purpose: most callers build
 * their rows and columns during render, so their identity changes every time,
 * and keying on it would measure, stack and reset in a loop.
 */
function useFits(
  ref: React.RefObject<HTMLDivElement | null>,
  shape: string,
): boolean {
  // Stacking is remembered for one shape only, so a new shape is a table again
  // without an effect having to reset it.
  const [stackedFor, setStackedFor] = React.useState<string | null>(null);
  const stacked = stackedFor === shape;
  const needed = React.useRef(0);
  const setStacked = React.useCallback(
    (on: boolean) => setStackedFor(on ? shape : null),
    [shape],
  );

  React.useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => {
      if (stacked) {
        if (box.clientWidth >= needed.current) setStacked(false);
        return;
      }
      const scroller = box.querySelector<HTMLElement>(
        '[data-slot="table-container"]',
      );
      if (!scroller || scroller.clientWidth === 0) return;
      if (scroller.scrollWidth > scroller.clientWidth + 1) {
        needed.current = scroller.scrollWidth;
        setStacked(true);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [ref, stacked, setStacked]);

  return !stacked;
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

  const boxRef = React.useRef<HTMLDivElement>(null);
  const fits = useFits(
    boxRef,
    `${rows.length}:${columns.map((column) => column.id).join(",")}`,
  );
  const [scrollRef, edges] = useScrollEdges(fits);
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


  if (!fits) {
    const [title, ...rest] = columns;
    const actions = pinned ? rest.at(-1) : undefined;
    const pairs = actions ? rest.slice(0, -1) : rest;
    return (
      <>
        <div ref={boxRef}>
          <ul
            data-slot="data-stack"
            aria-label={label}
            className="flex flex-col text-ui"
          >
            {sorted.map((row) => {
              const id = getRowId(row);
              const isSelected = selected.has(id);
              return (
                <li
                  key={id}
                  data-selected={isSelected || undefined}
                  className={cn(
                    "flex flex-col gap-2 border-b border-line px-3 py-2.75 last:border-b-0 data-selected:bg-brand-tint",
                    rowClassName?.(row),
                  )}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    {selectable ? (
                      <Checkbox
                        className="mt-0.5"
                        checked={isSelected}
                        onCheckedChange={(next) => toggle(id, next)}
                        aria-label={`Select ${rowName?.(row) ?? id}`}
                      />
                    ) : null}
                    {title ? (
                      <div
                        className={cn(
                          "min-w-0 flex-1 wrap-anywhere text-tx-2",
                          title.tone === "key" && CELL.key,
                          stackFace(title),
                        )}
                      >
                        {title.cell(row)}
                      </div>
                    ) : null}
                    {actions ? (
                      <div className="-my-0.5 flex shrink-0 items-center">
                        {actions.cell(row)}
                      </div>
                    ) : null}
                  </div>
                  {pairs.length > 0 ? (
                    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                      {pairs.map((column) => (
                        <React.Fragment key={column.id}>
                          <dt className="text-tx-3">{column.head}</dt>
                          <dd
                            className={cn(
                              "min-w-0 text-tx-2",
                              column.truncate ? "truncate" : "wrap-anywhere",
                              column.tone === "num" && "num",
                              column.tone === "key" && CELL.key,
                              column.tone === "muted" && CELL.muted,
                              stackFace(column),
                            )}
                          >
                            {column.cell(row)}
                          </dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
        {showEmpty ? <div data-slot="table-empty">{empty}</div> : null}
      </>
    );
  }

  return (
    <>
      <div
        ref={(node) => {
          scrollRef.current = node;
          boxRef.current = node;
        }}
        className="relative"
      >
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
