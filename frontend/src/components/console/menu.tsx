import type { ComponentProps } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * The row shape a menu is made of (e-console.html:862-874).
 *
 * Exported on its own because the reference leaves `.mi` unscoped on purpose:
 * the same row works inside a menu *and* as a compact list row on a card, and
 * the two must not be able to drift apart. Use `MenuRow` for the second case.
 */
export const menuRowClass =
  "flex h-8 w-full items-center gap-2.25 rounded-md px-2.25 text-left text-body text-tx hover:bg-raise";

export type MenuProps = ComponentProps<typeof DropdownMenuContent> & {
  /** The control that opens it. Rendered as-is; give it its own label. */
  trigger: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * An anchored menu of actions. Base UI's menu underneath, so the focus trap,
 * the arrow keys, type-ahead and Escape all come for free.
 */
export function Menu({
  trigger,
  children,
  className,
  open,
  onOpenChange,
  ...props
}: MenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={trigger as React.ReactElement} />
      <DropdownMenuContent
        className={cn(
          "w-auto min-w-53.5 rounded-xl border border-line bg-panel p-1.5 shadow-pop ring-0",
          className,
        )}
        {...props}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type MenuItemProps = ComponentProps<typeof DropdownMenuItem> & {
  icon?: IconName;
  /** A chevron on the right, for a row that opens something else. */
  chevron?: boolean;
  /** The current choice in a set — brand text, as the reference marks it. */
  selected?: boolean;
  /** This row deletes or disconnects something. */
  destructive?: boolean;
};

function MenuItem({
  icon,
  chevron,
  selected,
  destructive,
  className,
  children,
  ...props
}: MenuItemProps) {
  return (
    <DropdownMenuItem
      aria-pressed={selected}
      // base-nova repaints a highlighted row's text with the neutral hover
      // colour unless the row says it is destructive, so a red "Delete" went
      // grey the moment the pointer or the arrow keys reached it.
      variant={destructive ? "destructive" : undefined}
      className={cn(
        menuRowClass,
        "[&>svg:first-child]:text-tx-3",
        selected && "font-medium text-brand-tx",
        destructive && "text-bad [&>svg:first-child]:text-bad",
        className,
      )}
      {...props}
    >
      {icon ? <Icon name={icon} /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {chevron ? (
        <Icon name="chevR" className="flex-none text-tx-4" />
      ) : null}
    </DropdownMenuItem>
  );
}

export type MenuGroupProps = ComponentProps<typeof DropdownMenuGroup> & {
  /** Names the rows under it — "This Application", "Environment". */
  label: React.ReactNode;
};

/**
 * A labelled run of rows.
 *
 * The label and the group are one component on purpose. Base UI's group label
 * reads its group from context and *throws* without one, and a label that is
 * not inside the group it names is a label a screen reader never associates
 * with anything. Making them separable would make both mistakes available.
 */
function MenuGroup({ label, children, className, ...props }: MenuGroupProps) {
  return (
    <DropdownMenuGroup className={className} {...props}>
      <DropdownMenuLabel className="px-2.25 pt-1.75 pb-1 text-meta font-medium text-tx-3">
        {label}
      </DropdownMenuLabel>
      {children}
    </DropdownMenuGroup>
  );
}

function MenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuSeparator>) {
  return (
    <DropdownMenuSeparator
      className={cn("-mx-1.5 my-1.5 h-px bg-line", className)}
      {...props}
    />
  );
}

export type MenuRowProps = ComponentProps<"button"> & {
  icon?: IconName;
  chevron?: boolean;
  destructive?: boolean;
};

/**
 * The same row, outside a menu — a compact list of links or actions on a card.
 * One shape, two homes, defined once (e-console.html:862-864).
 */
export function MenuRow({
  icon,
  chevron,
  destructive,
  className,
  children,
  ...props
}: MenuRowProps) {
  return (
    <button
      type="button"
      className={cn(
        menuRowClass,
        "[&>svg:first-child]:text-tx-3",
        destructive && "text-bad [&>svg:first-child]:text-bad",
        className,
      )}
      {...props}
    >
      {icon ? <Icon name={icon} /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {chevron ? (
        <Icon name="chevR" className="flex-none text-tx-4" />
      ) : null}
    </button>
  );
}

Menu.Item = MenuItem;
Menu.Group = MenuGroup;
Menu.Separator = MenuSeparator;

export { MenuItem, MenuGroup, MenuSeparator };
