import { cn } from "@/lib/utils";

export type ColsProps = {
  children: React.ReactNode;
  /** The right rail. Leave it out and the main column takes the full measure. */
  aside?: React.ReactNode;
  /** Names the rail for a screen reader. Required whenever `aside` is given. */
  asideLabel?: string;
  className?: string;
};

/**
 * A page's main column and its right rail (e-console.html:422-425).
 *
 * Below 1040px it becomes one column with the rail underneath, in DOM order —
 * no `order` juggling, so what a screen reader hears and what the eye reads
 * are the same sequence at both widths.
 */
export function Cols({ children, aside, asideLabel, className }: ColsProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 items-start gap-6.5",
        aside &&
          "cols:grid-cols-[minmax(0,1fr)_var(--spacing-aside)] cols:gap-6.5",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-4.5">{children}</div>
      {aside ? (
        <aside
          aria-label={asideLabel}
          className="flex min-w-0 flex-col gap-4.5"
        >
          {aside}
        </aside>
      ) : null}
    </div>
  );
}
