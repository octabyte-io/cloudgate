import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  icon?: IconName;
  /** What is not here yet — a noun, not an apology. */
  title: string;
  /** One sentence: what this thing is for, and what pressing the button does. */
  children?: React.ReactNode;
  /** The invitation. An empty screen with no way out of it is a dead end. */
  action?: React.ReactNode;
  className?: string;
};

/**
 * Nothing here yet (e-console.html:843-847).
 *
 * An empty state is an invitation to act, not a report that a query returned
 * zero rows. It names the thing, says in one sentence what it is for, and
 * carries the control that creates the first one.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        // `animate-fade`: an empty state replaces a skeleton or a filtered
        // list in place, so it arrives by opacity alone.
        "grid animate-fade place-items-center gap-2.25 px-5 py-14 text-center",
        className,
      )}
    >
      {icon ? (
        <Icon name={icon} size={28} className="mb-1 text-tx-4" />
      ) : null}
      <h3 className="text-sect wrap-anywhere text-tx">{title}</h3>
      {children ? (
        <p className="max-w-copy text-body text-tx-2">{children}</p>
      ) : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}
