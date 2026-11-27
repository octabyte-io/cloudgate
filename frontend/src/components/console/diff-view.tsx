import { hangStyle } from "@/lib/format/hang";
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
 * **Long lines wrap, and the wrap does not lie about indentation.** A diff
 * used to own a horizontal scrollbar on the argument that a wrapped diff line is
 * one whose indentation lies — and a wrap that sends the continuation back to
 * the left edge, under the sign, does exactly that. So each row is a flex row: a
 * fixed sign gutter, then a content column that is `pre-wrap` (every space
 * kept) and `wrap-anywhere` (a digest still breaks). A continuation row starts
 * at the content column, never under the gutter, so the signs stay one clean
 * column of changes; and it **hangs at the line's own indentation** (padding
 * plus an equal negative `text-indent`), so a wrapped value still sits inside
 * its block rather than reading as a line at column zero. The page never
 * scrolls sideways and neither does the diff.
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
        "min-w-0 overflow-hidden rounded-lg border border-line bg-panel-2 font-mono text-meta leading-diff",
        className,
      )}
      {...props}
    >
      {rows.map((row, index) => {
        const mark = MARK[row.kind];
        return (
          <div
            key={index}
            className={cn("flex", mark.row)}
          >
            <span
              className={cn(
                "w-6.5 flex-none border-r border-line bg-panel text-center whitespace-pre",
                mark.gutter,
              )}
            >
              <span aria-hidden="true">{mark.glyph}</span>
              <span className="sr-only">{mark.word}</span>
            </span>
            <span
              data-slot="diff-text"
              className="min-h-[1lh] min-w-0 flex-1 pr-3 pl-[calc(var(--spacing)*3+var(--hang))] indent-[calc(var(--hang)*-1)] whitespace-pre-wrap wrap-anywhere"
              style={hangStyle(row.text)}
            >
              {row.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
