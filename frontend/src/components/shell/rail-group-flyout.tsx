import Link from "next/link";

import { Menu } from "@/components/console/menu";
import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { CURRENT, LABEL, ROW } from "./rail-row";
import { RailTip } from "./rail-tip";

/**
 * A group on the 60px icon strip.
 *
 * Expanded, a group opens its sub-list under itself. On the strip there is no
 * room under it — `RailSubList` is `railc:hidden` — so a click used to flip
 * `aria-expanded` and show nothing, and Recents and Starred looked dead. Here the
 * same items open beside the icon instead, as a menu anchored to it: Base UI's,
 * so focus, the arrow keys and Escape come with it.
 *
 * Only for a group that is not also a page. Projects' icon is a link to the
 * Projects list on the strip already, which is the whole list in one click.
 */
export function RailGroupFlyout({
  icon,
  label,
  current,
  open,
  onOpenChange,
  items,
  empty,
  onNavigate,
}: {
  icon: IconName;
  label: string;
  current: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: { href: string; label: string }[];
  /** What the menu says when the group has nothing in it. */
  empty: string;
  onNavigate?: () => void;
}) {
  return (
    <Menu
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      align="start"
      sideOffset={8}
      trigger={
        <RailTip label={label}>
          <button type="button" className={cn(ROW, "w-full", current && CURRENT)}>
            <Icon name={icon} className={current ? "text-brand-tx" : "text-tx-3"} />
            <span className={LABEL}>{label}</span>
          </button>
        </RailTip>
      }
    >
      <Menu.Group label={label}>
        {items.length === 0 ? (
          <p className="px-2.25 py-1.5 text-ui text-tx-3">{empty}</p>
        ) : (
          items.map((item) => (
            <Menu.Item
              key={item.href}
              render={<Link href={item.href} />}
              onClick={onNavigate}
            >
              {item.label}
            </Menu.Item>
          ))
        )}
      </Menu.Group>
    </Menu>
  );
}
