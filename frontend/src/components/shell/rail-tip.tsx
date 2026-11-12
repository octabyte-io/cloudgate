import type { ComponentProps } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { useRailCollapsed } from "./rail-state";

/**
 * A rail row's name, beside it, while the rail is an icon strip.
 *
 * Collapsed, every row's label is `sr-only`, so the icon was the whole
 * affordance — fine for a screen reader, which still reads the label, and a
 * guessing game for everyone else: a rocket, a globe and a book. This puts the
 * label to the right of the strip on hover and on keyboard focus.
 *
 * **Why a portal, and not a CSS-only label.** The rows live in a scroll region
 * with `overflow-x: hidden`, so anything positioned past the 60px strip is
 * clipped by the rail itself. The tooltip (`components/ui/tooltip`, Base UI's
 * underneath) renders into `<body>` and places itself against the row, which is
 * the only way out of that box.
 *
 * **Hover and keyboard focus, not a click.** Base UI opens on focus only when
 * the row matches `:focus-visible` (Mac Safari: only after a keydown rather than
 * a pointerdown), so clicking a row does not pin its name open. jsdom has no
 * `:focus-visible`, and Base UI treats every focus there as visible — which is
 * why the test can only speak for the keyboard half.
 *
 * **Why it is not announced.** The popup is never tied to the row by
 * `aria-describedby`, and it is outside the row's subtree, so the row's
 * accessible name stays its one `sr-only` label — a tooltip that is also read
 * would make every row "Deployments Deployments".
 *
 * **Only on the strip.** Expanded, the label is already on screen, so the
 * tooltip is disabled outright — off the same attribute the rail's width is.
 * Disabled rather than unwrapped, so collapsing the rail does not remount every
 * row under the operator's pointer. And as a drawer the rail is never an icon
 * strip whatever the stored preference says, which is the `railc` variant's
 * *other* condition: the popup is shown only under `railc`, so the two can
 * never disagree about when the strip is a strip.
 *
 * Extra props are the trigger's, so a control that is *already* someone's
 * trigger — the Organization switcher is a menu's — can be handed straight
 * through: the menu clones this element with its own props, and they land on
 * the row.
 */
export function RailTip({
  label,
  side = "right",
  children,
  ...props
}: {
  label: string;
  /** Right of the strip for a row; below, for the masthead's cell above it. */
  side?: "right" | "bottom";
  children: React.ReactElement;
} & Omit<ComponentProps<typeof TooltipTrigger>, "render" | "children">) {
  const collapsed = useRailCollapsed();

  return (
    <Tooltip disabled={!collapsed}>
      <TooltipTrigger {...props} render={children} />
      <TooltipContent role="tooltip" side={side} className="hidden railc:flex">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
