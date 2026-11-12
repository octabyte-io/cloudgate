import { cn } from "@/lib/utils";

/**
 * A bar standing in for a line that has not arrived (e-console.html:849-850).
 *
 * Always `aria-hidden`: a screen reader gets nothing useful from four grey
 * rectangles. Put `aria-busy="true"` on the region that is loading and a real
 * sentence in a live region if the wait is long enough to need one.
 *
 * The pulse degrades to a settled snapshot under `prefers-reduced-motion`,
 * from the global rule in `globals.css` — it stops, rather than going faster.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        "block h-2.75 animate-pulse rounded-sm bg-raise",
        className,
      )}
      {...props}
    />
  );
}
