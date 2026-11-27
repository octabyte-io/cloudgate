import { hangStyle } from "@/lib/format/hang";
import { cn } from "@/lib/utils";

/**
 * A file, read. Mono, numbered, on the same near-black well a log uses.
 *
 * `LogWell`'s sibling, and separate from it on purpose: that one renders a
 * *stream* — it has a tail to follow, a cursor, a per-line tone and a cap on how
 * much it holds — and none of those mean anything about a file that is simply
 * sitting there. Sharing the surface is the point (an operator reading YAML and
 * an operator reading build output are doing the same kind of looking), sharing
 * the machinery is not.
 *
 * The content is one `<pre>`, and the line numbers are generated content
 * (`counter(line)` in each line's `::before`) rather than text, so selecting the
 * text copies the file rather than the file interleaved with a column of
 * numbers — which is what a numbered gutter built out of rows does, and it is
 * only discovered by someone trying to paste it somewhere.
 *
 * **Long lines wrap; nothing here scrolls sideways.** `pre-wrap` keeps every
 * space the file has and `wrap-anywhere` breaks the digests and paths that no
 * word boundary is ever found in — `LogWell`'s rule. Each line is its own block
 * so its number sits beside its *first* row and a wrapped line keeps one number,
 * and the continuation rows **hang at the line's own indentation** (padding plus
 * an equal negative `text-indent`), so a wrapped YAML value still reads as
 * belonging to its key instead of looking like a line at column zero.
 */
export function CodeWell({
  content,
  label,
  className,
}: {
  content: string;
  /** What this file is, for a screen reader arriving at a wall of mono. */
  label: string;
  className?: string;
}) {
  const lines = content.replace(/\n$/, "").split("\n");
  // The gutter is as wide as the largest line number, plus its padding.
  const digits = String(lines.length).length;
  const gutter = `calc(${digits}ch + var(--spacing) * 6)`;

  // `contain-inline-size` keeps the content out of the width this box offers
  // its parent. Lines wrap now, so the `<pre>`'s min-content is a character
  // rather than the longest line — but a Modal is a grid whose one column is as
  // wide as its item's min-content, and this is the guard that was measured to
  // keep it from becoming the sideways scroller, so it stays.
  return (
    <div
      className={cn(
        "max-h-log overflow-y-auto rounded-lg border border-line bg-well contain-inline-size",
        className,
      )}
    >
      <div
        className="relative min-w-0 font-mono text-meta leading-log"
        style={{ "--gutter": gutter } as React.CSSProperties}
      >
        {/* The gutter's rule, drawn once down the whole file. */}
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-(--gutter) border-r border-line/40"
        />
        <pre
          aria-label={label}
          className="min-w-0 py-3 pr-3.5 whitespace-pre-wrap wrap-anywhere text-well-tx [counter-reset:line]"
        >
          {lines.map((line, index) => (
            // The index is the line number — there is nothing else it could be
            // keyed on, and a file's lines do not reorder.
            <span
              key={index}
              data-line
              className={cn(
                "relative block min-h-[1lh] [counter-increment:line]",
                "pl-[calc(var(--gutter)+var(--spacing)*3.5+var(--hang))] indent-[calc(var(--hang)*-1)]",
                "before:absolute before:left-0 before:w-(--gutter) before:pr-2.5 before:indent-0 before:text-right before:text-well-ts before:tabular-nums before:content-[counter(line)]",
              )}
              style={hangStyle(line)}
            >
              {line}
              {index < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}
