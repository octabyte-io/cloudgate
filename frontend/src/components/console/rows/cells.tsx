import Link from "next/link";

import { Dash } from "@/components/console/dash";

import { timeAgo, timeExact } from "@/lib/format/time";
import { cn } from "@/lib/utils";

/**
 * The cells the three shared row shapes are made of (e-console.html:636).
 *
 * Small, and worth existing: a table's link and a table's "no value" are the two
 * things every list in this app repeats, and the second one is the one people get
 * wrong.
 */

/**
 * The link in a table's key cell — the reference's `.lk`.
 *
 * A real link, not a `<button onClick={push}>`: a row that names a resource is a
 * row you can open in a new tab, copy the address of, or reach with a middle
 * click, and a button is none of those.
 */
export function RowLink({
  href,
  className,
  title,
  children,
}: {
  href: string;
  className?: string;
  /** The whole value, where the cell may cut it short. */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      className={cn(
        "font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** The quieter second line under a key cell — an appName, a description. */
export function RowSub({
  mono,
  className,
  children,
}: {
  mono?: boolean;
  /** A width cap, for the one sub-line with no natural limit — a description. */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "truncate text-meta text-tx-3",
        mono && "font-mono tracking-mono",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * When something happened, relatively — with the exact stamp on the element, so
 * "14 minutes ago" can still be correlated with a log line.
 *
 * A `<time>` element, so the machine-readable value is in the markup rather than
 * only in a tooltip.
 */
export function RowTime({ iso }: { iso: string | null | undefined }) {
  const relative = timeAgo(iso);
  if (relative === null || !iso) return <Dash word="Never" />;

  return (
    <time dateTime={iso} title={timeExact(iso)}>
      {relative}
    </time>
  );
}
