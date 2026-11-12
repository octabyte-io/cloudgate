import { cn } from "@/lib/utils";

/**
 * The inset strip the reference puts above a table, inside the card
 * (e-console.html:547-553) — "12 Applications, 3 need attention", a filter
 * summary, a row count.
 *
 * It sits on `--panel-2` so the card reads as having a lip before the data
 * starts. Figures inside it go in a `<strong>`: the strip is a sentence, and
 * the numbers are the part of the sentence someone is actually scanning for.
 */
export function MetaStrip({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="meta-strip"
      className={cn(
        "border-b border-line bg-panel-2 px-4 py-2.5 text-ui text-tx-2",
        "[&_strong]:font-semibold [&_strong]:text-tx",
        className,
      )}
      {...props}
    />
  );
}
