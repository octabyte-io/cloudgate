import Link from "next/link";

import { Skeleton } from "@/components/console/skeleton";
import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { CURRENT, LABEL, ROW } from "./rail-row";
import { RailTip } from "./rail-tip";

/**
 * The rows a scope rail is made of (e-console.html:295-401).
 *
 * A destination, a quiet heading, the rule, and the "Back to …" pill. The
 * expandable group is in `rail-group.tsx`; the recipe they all share is in
 * `rail-row.tsx`.
 *
 * **Collapsed** (`railc:`, the 60px icon strip) hides labels, chevrons and tags
 * outright, and the row's own icon becomes the whole affordance — named in a
 * tooltip on hover and focus (`rail-tip.tsx`). A column of identical chevrons
 * carries no information, which is the reference's argument for hiding rather
 * than shrinking (e-console.html:379-383).
 */

export type RailLinkProps = {
  href: string;
  icon: IconName;
  label: string;
  current: boolean;
  /** A quiet marker on the right — a count, a note. Never a status. */
  tag?: string;
  onNavigate?: () => void;
};

export function RailLink({
  href,
  icon,
  label,
  current,
  tag,
  onNavigate,
}: RailLinkProps) {
  return (
    <RailTip label={label}>
      <Link
        href={href}
        onClick={onNavigate}
        aria-current={current ? "page" : undefined}
        className={cn(ROW, "w-full", current && CURRENT)}
      >
        <Icon
          name={icon}
          className={current ? "text-brand-tx" : "text-tx-3"}
        />
        <span className={cn(LABEL, current && "font-semibold")}>{label}</span>
        {tag ? <RailTag>{tag}</RailTag> : null}
      </Link>
    </RailTip>
  );
}

function RailTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex-none rounded-sm border border-line bg-panel-2 px-1.25 py-0.75 text-chip text-tx-3 railc:hidden">
      {children}
    </span>
  );
}

/**
 * A quiet heading over the rows beneath it. Sentence case, muted, 13px — the
 * reference does *not* shout its group labels, and uppercasing them is the
 * fastest way to look like a different product (e-console.html:337-341).
 *
 * Collapsed, it becomes the hairline it was already acting as.
 */
export function RailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-3.5 pb-1.5 text-ui font-medium text-tx-3 railc:mx-1.5 railc:my-3 railc:h-px railc:overflow-hidden railc:bg-line railc:p-0 railc:text-transparent">
      {children}
    </div>
  );
}

/** The rule that separates settings from the work. Full-bleed across the rail. */
export function RailRule() {
  return <div aria-hidden="true" className="-mx-3 mt-0.5 mb-2.5 h-px bg-line" />;
}

/**
 * The pill's row, before its label is known.
 *
 * A deep link into an Environment or an Application has the right rail from the
 * first frame but not the parent's *name*, and dropping a 44px row in once it
 * arrives shifts every nav item below it. So the row is held, empty. `aria-hidden`
 * because there is nothing here to read or reach yet — the tab order gains the
 * link when the link gains a destination.
 */
export function RailBackToPending() {
  return (
    <div
      aria-hidden="true"
      className="mt-0.5 mb-2.5 flex h-nav w-full items-center gap-2.5 rounded-md bg-raise px-2.5 railc:justify-center railc:gap-0 railc:px-0"
    >
      <Icon name="back" size={15} className="text-tx-4" />
      <Skeleton className="h-3 w-28 railc:hidden" />
    </div>
  );
}

/** The scope-exit pill. Rendered only off Organization scope. */
export function RailBackTo({
  href,
  label,
  onNavigate,
}: {
  href: string;
  label: string;
  onNavigate?: () => void;
}) {
  return (
    <RailTip label={label}>
      <Link
        href={href}
        onClick={onNavigate}
        className="relative mt-0.5 mb-2.5 flex h-nav w-full items-center gap-2.5 rounded-md bg-raise px-2.5 text-ui font-medium text-tx transition-colors duration-100 hover:bg-raise-2 railc:justify-center railc:gap-0 railc:px-0"
      >
        <Icon name="back" size={15} className="text-tx-3" />
        <span className="min-w-0 flex-1 truncate railc:sr-only">{label}</span>
      </Link>
    </RailTip>
  );
}
