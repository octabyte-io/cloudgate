import Link from "next/link";

import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { CURRENT, LABEL, ROW } from "./rail-row";
import { RailTip } from "./rail-tip";

/**
 * An expandable group in the rail, and the sub-items that hang under it.
 *
 * Its own file because a group is the one row shape with *two* jobs — going
 * somewhere and opening something — and the reference splits those into two
 * controls (e-console.html:2118-2121). Everything else in the rail is one
 * control per row.
 */

export type RailGroupProps = {
  icon: IconName;
  label: string;
  /** A group that is also a destination. Then the chevron is its own control. */
  href?: string;
  current: boolean;
  open: boolean;
  onToggle: () => void;
  /** Names the sub-list for `aria-controls`. */
  panelId: string;
  onNavigate?: () => void;
};

/**
 * A group heading.
 *
 * When the group is *also* a page — Projects is — opening it and going to it are
 * two different clicks, so the chevron is a control of its own rather than a
 * glyph on a row that does both (e-console.html:2118-2121). When it is not,
 * the whole row is the toggle.
 */
export function RailGroup({
  icon,
  label,
  href,
  current,
  open,
  onToggle,
  panelId,
  onNavigate,
}: RailGroupProps) {
  const chevron = (
    <Icon
      name="chevR"
      size={14}
      className={cn(
        "flex-none text-tx-4 transition-transform duration-150 ease-out-strong railc:hidden",
        open && "rotate-90",
      )}
    />
  );

  if (!href) {
    return (
      <RailTip label={label}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className={cn(ROW, "w-full", current && CURRENT)}
        >
          <Icon name={icon} className={current ? "text-brand-tx" : "text-tx-3"} />
          <span className={cn(LABEL, current && "font-semibold")}>{label}</span>
          {chevron}
        </button>
      </RailTip>
    );
  }

  return (
    // The hover fill belongs to the row, not to either control, so a 34px row
    // still reads as one row while carrying two targets.
    <div
      className={cn(
        "flex h-nav w-full items-center rounded-md transition-colors duration-100 hover:bg-raise",
        current && CURRENT,
      )}
    >
      <RailTip label={label}>
        <Link
          href={href}
          onClick={onNavigate}
          aria-current={current ? "page" : undefined}
          className={cn(ROW, "min-w-0 flex-1 hover:bg-transparent")}
        >
          <Icon name={icon} className={current ? "text-brand-tx" : "text-tx-3"} />
          <span className={cn(LABEL, current && "font-semibold")}>{label}</span>
        </Link>
      </RailTip>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? "Hide" : "Show"} ${label}`}
        className="mr-1 grid size-7 flex-none place-items-center rounded-sm transition-colors duration-100 hover:bg-raise-2 railc:hidden"
      >
        {chevron}
      </button>
    </div>
  );
}

/** Sub-items hang under a hairline, indented to the parent's label. */
export function RailSubList({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className="mt-0.5 mb-1 ml-2.75 animate-fade border-l border-line pl-4.75 railc:hidden"
    >
      {children}
    </div>
  );
}

/** No icon: the parent's icon is what says what kind of thing these are. */
export function RailSubLink({
  href,
  label,
  current,
  onNavigate,
}: {
  href: string;
  label: string;
  current: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-8 w-full items-center rounded-md px-2.5 text-ui font-medium text-tx transition-colors duration-100 hover:bg-raise",
        current && `${CURRENT} font-semibold`,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </Link>
  );
}
