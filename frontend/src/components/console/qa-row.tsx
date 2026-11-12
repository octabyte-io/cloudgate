import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * A list of things worth doing next (e-console.html:708-714) — what the
 * reference's organization home puts under "Recommendations".
 */
export function QAList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="qa-list"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

// `title` is omitted as well as `children` (F16). A `<div>` already has a
// `title` attribute typed `string`, and intersecting rather than overriding it
// silently narrowed this prop to `React.ReactNode & string` — so the row could
// only ever hold a bare string, and a title with a chip or an emphasis in it
// failed to typecheck for a reason that pointed at the call site rather than at
// here. `CardHeaderProps` was already doing it correctly two files away.
export type QARowProps = Omit<React.ComponentProps<"div">, "children" | "title"> & {
  /** What to do, as a thing you would do: "Add a health check". */
  title: React.ReactNode;
  /** Why it is worth doing, in one line. */
  description: React.ReactNode;
  /** Where to read more. External by definition — it leaves this screen. */
  link?: { label: string; href: string };
  /** The control that does it, or the switch that turns it on. */
  action?: React.ReactNode;
};

/**
 * One recommendation: what to do, why, and the way to do it.
 *
 * The title is a `<p>` and not a heading — a list of twelve findings is not
 * twelve sections of the document, and a screen reader's heading list is a
 * table of contents, not a to-do list. The action carries its own accessible
 * name, because "Enable" on its own is a control that could be about anything.
 */
export function QARow({
  className,
  title,
  description,
  link,
  action,
  ...props
}: QARowProps) {
  return (
    <div
      data-slot="qa-row"
      className={cn(
        // `flex-wrap` and a basis on the text (F16). The row was a
        // non-wrapping flex, so at 380px an action wide enough — a `Switch` is
        // 44px plus its gap — pushed the row 11px past its card and the switch
        // scrolled inside a box nobody can scroll. It is the same answer
        // `PageHeader` already gives at 620px: the action drops under the text
        // and takes the full width rather than squeezing it.
        "flex flex-wrap gap-3 border-b border-line py-3.5 last:border-b-0",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-center gap-1.75 text-body font-medium text-tx">
          {title}
        </p>
        <p className="mt-0.75 text-meta text-tx-2 wrap-anywhere">
          {description}
        </p>
        {link ? (
          <a
            href={link.href}
            className="mt-1.25 inline-flex items-center gap-1 text-meta font-medium text-brand-tx hover:underline"
          >
            {link.label}
            <Icon name="ext" size={12} />
          </a>
        ) : null}
      </div>
      {action ? <div className="flex-none">{action}</div> : null}
    </div>
  );
}
