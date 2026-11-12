import { cn } from "@/lib/utils";

export type DiffKind = "add" | "del" | "ctx";

/**
 * What a diff row's mark means. Its own three words, not `GUT`'s six: that map
 * is about what a *plan* does to a resource — create, replace, destroy — and
 * this is about whether a *line* is in the new version. Same glyphs, different
 * vocabulary, and folding them together is how a diff starts announcing that a
 * line was "created".
 */
const MARK: Record<
  DiffKind,
  { glyph: string; word: string; row: string; gutter: string }
> = {
  // A changed row's sign takes the row's colour; an unchanged one stays a
  // label, which is what keeps the gutter reading as a column of changes.
  add: { glyph: "+", word: "added", row: "bg-ok-tint text-ok", gutter: "" },
  del: { glyph: "−", word: "removed", row: "bg-bad-tint text-bad", gutter: "" },
  ctx: { glyph: " ", word: "unchanged", row: "text-tx-2", gutter: "text-tx-3" },
};

export type DiffRow = {
  kind: DiffKind;
  text: string;
};

export type DiffViewProps = Omit<React.ComponentProps<"div">, "children"> & {
  /** What changed: "Environment variables", "docker-compose.yml". */
  label: string;
  rows: DiffRow[];
};

/**
 * A diff (e-console.html:782-795): a gutter of signs, a tinted row per change,
 * and lines that keep their whitespace.
 *
 * **It scrolls sideways inside itself.** Diff lines cannot wrap — a wrapped line
 * in a diff is a line whose indentation lies — so this is one of the two
 * components in the console that owns a horizontal scrollbar, and the page
 * behind it never gets one. The gutter is `sticky` at the left edge, so the
 * signs stay put while a long line scrolls under them; the reference lets them
 * scroll away, and losing the column that says which lines changed while
 * reading the change is not a trade worth keeping.
 *
 * Every row's sign carries its word for a screen reader. `+` and `−` are a
 * pixel apart at 12px, and the difference between them is what the deploy will
 * do.
 */
export function DiffView({ className, label, rows, ...props }: DiffViewProps) {
  return (
    <div
      data-slot="diff"
      role="group"
      aria-label={label}
      className={cn(
        "overflow-x-auto overscroll-x-contain rounded-lg border border-line bg-panel-2 font-mono text-meta leading-diff",
        className,
      )}
      {...props}
    >
      {rows.map((row, index) => {
        const mark = MARK[row.kind];
        return (
          <div
            key={index}
            className={cn("flex w-max min-w-full whitespace-pre", mark.row)}
          >
            <span
              className={cn(
                "sticky left-0 w-6.5 flex-none border-r border-line bg-panel text-center",
                mark.gutter,
              )}
            >
              <span aria-hidden="true">{mark.glyph}</span>
              <span className="sr-only">{mark.word}</span>
            </span>
            <span className="flex-1 px-3">{row.text}</span>
          </div>
        );
      })}
    </div>
  );
}
