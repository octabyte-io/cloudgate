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
 * The line numbers are `aria-hidden` and the content is one `<pre>`, so
 * selecting the text copies the file rather than the file interleaved with a
 * column of numbers — which is what a numbered gutter built out of rows does,
 * and it is only discovered by someone trying to paste it somewhere.
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

  // `contain-inline-size` keeps the longest line out of the width this box
  // offers its parent. Without it a Modal — a grid whose one column is
  // as wide as its item's min-content — grew to that line and became the
  // sideways scroller, taking its title and Close button with it, while the
  // `<pre>` below never overflowed. The box still fills whatever it is given,
  // and its height still follows the content.
  return (
    <div
      className={cn(
        "max-h-log overflow-auto rounded-lg border border-line bg-well contain-inline-size",
        className,
      )}
    >
      <div className="flex min-w-0 font-mono text-meta leading-log">
        <div
          aria-hidden="true"
          className="num flex-none border-r border-line/40 py-3 pr-2.5 pl-3.5 text-right text-well-ts select-none"
        >
          {lines.map((_, index) => (
            // The index is the line number — there is nothing else it could be
            // keyed on, and a file's lines do not reorder.
            <div key={index}>{index + 1}</div>
          ))}
        </div>
        <pre
          aria-label={label}
          className="min-w-0 flex-1 overflow-x-auto px-3.5 py-3 text-well-tx"
        >
          {content.replace(/\n$/, "")}
        </pre>
      </div>
    </div>
  );
}
