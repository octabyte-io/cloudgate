import Link from "next/link";

import { menuRowClass } from "@/components/console/menu";
import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * One row of a "what you own" list on the home page (e-console.html:2790-2810).
 *
 * The reference builds these out of `.mi`, the same row a menu is made of, and
 * leaves the class unscoped so the two cannot drift apart — `menuRowClass` is
 * that class, exported by `console/menu` for exactly this. `MenuRow` itself is a
 * `<button>`, and these go somewhere, so this is the row as a link.
 *
 * 38px rather than the menu's 32px: the reference gives these lists a little more
 * air because they are the page's content rather than a popup's options.
 */
export function HomeRow({
  href,
  icon,
  label,
  /** A quieter prefix — "storefront / " in front of an Environment's name. */
  path,
  /** A status dot or a count chip, before the chevron. */
  mark,
}: {
  href: string;
  icon: IconName;
  label: string;
  path?: string;
  mark?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(menuRowClass, "h-9.5 transition-colors duration-100 [&>svg:first-child]:text-tx-3")}
    >
      <Icon name={icon} size={15} />
      <span className="min-w-0 flex-1 truncate">
        {path ? <span className="text-tx-3">{path}</span> : null}
        {label}
      </span>
      {mark ? <span className="flex flex-none items-center">{mark}</span> : null}
      <Icon name="chevR" size={13} className="flex-none text-tx-4" />
    </Link>
  );
}

/**
 * The negative margin the reference puts around these lists
 * (`margin:-6px -8px`): the rows are inset by the card's padding *and* by their
 * own, so their hover fill would otherwise sit in from the card's edge by twice
 * as much as it should.
 */
export const homeListClass = "-mx-2 -my-1.5";
