import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PagerProps = Omit<React.ComponentProps<"nav">, "children"> & {
  /** How many rows are on screen, and how many there are altogether. */
  shown: number;
  total: number;
  /** What is being counted, plural: "Applications", "Deployments", "Servers". */
  noun: string;
  /** Where the window starts, 1-based. Defaults to the first row. */
  from?: number;
  onPrevious?: () => void;
  onNext?: () => void;
};

/**
 * The strip under a table (e-console.html:647-652). It says where you are
 * before it offers to move you: **1 – 25** of **312** Deployments.
 *
 * A step that leads nowhere is `aria-disabled` rather than removed, so the pair
 * of controls keeps its shape and its place in the tab order at the ends of the
 * list — the same rule as every other inert action in the console. Neither one
 * takes an `aria-label`: "Previous" is already the whole truth about what the
 * control does, and a label that replaced it would leave the visible word and
 * the spoken one saying different things.
 *
 * Counts sit in `<strong>` and carry `.num`: a pager's figures change under the
 * pointer, and a proportional `1` would shuffle the words beside it.
 */
export function Pager({
  className,
  shown,
  total,
  noun,
  from = 1,
  onPrevious,
  onNext,
  ...props
}: PagerProps) {
  const to = Math.min(from + shown - 1, total);
  const atStart = from <= 1;
  const atEnd = to >= total;

  return (
    <nav
      data-slot="pager"
      aria-label={`${noun} pages`}
      className={cn(
        "flex flex-wrap items-center gap-2.5 border-t border-line px-4 py-2.75 text-meta text-tx-2",
        className,
      )}
      {...props}
    >
      <p>
        <strong className="num font-semibold text-tx">
          {shown === 0 ? 0 : `${from} – ${to}`}
        </strong>{" "}
        of <strong className="num font-semibold text-tx">{total}</strong> {noun}
      </p>
      <div className="ml-auto flex items-center gap-2">
        <Button size="xs" onClick={onPrevious} disabled={atStart}>
          Previous
        </Button>
        <Button size="xs" onClick={onNext} disabled={atEnd}>
          Next
        </Button>
      </div>
    </nav>
  );
}
