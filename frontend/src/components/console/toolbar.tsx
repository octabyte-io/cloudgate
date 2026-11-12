import { cn } from "@/lib/utils";

/**
 * The row of controls above a table or a list (e-console.html:481).
 *
 * A layout primitive and nothing more: it wraps rather than scrolls, which is
 * what keeps a filter bar from pushing the page sideways on a phone. It does
 * not carry `role="toolbar"` — that role promises arrow-key navigation between
 * the controls, and promising a keyboard contract we do not implement is worse
 * than not claiming one.
 */
export function Toolbar({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="toolbar"
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

/**
 * The spring inside a Toolbar: everything after it is pushed to the far end.
 * A `<div className="flex-1" />` in six places is six chances to write
 * `flex-auto` by mistake.
 */
export function ToolbarGap() {
  return <div aria-hidden="true" className="flex-1" />;
}
