import { cn } from "@/lib/utils";

/**
 * The page measure and its gutters, declared once (e-console.html:404).
 *
 * Every screen in the console sits in this: 1360px of column, centred, with the
 * page gutter either side — 32px, or 16px below 900px, because `--spacing-pad`
 * is re-declared at that width rather than joined by a second token. The bottom
 * padding is deliberately deeper than the top: a page that ends flush with the
 * viewport reads as cut off.
 *
 * It is a `<div>` and not a `<main>`: the console has exactly one `<main>`, in
 * `console-shell.tsx`, and it is the scroll region this sits inside.
 */
export function Page({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page"
      className={cn("mx-auto max-w-col px-pad pt-6.5 pb-18", className)}
      {...props}
    />
  );
}
