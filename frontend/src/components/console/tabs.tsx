import type { ComponentProps } from "react";

import {
  Tabs as TabsRoot,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * The console's tab strip (e-console.html:490-500): an underline, a brand rule
 * under the current tab, and a strip that scrolls sideways on a narrow screen
 * with the scrollbar hidden — so an Application with eleven tabs never widens
 * the page it sits on.
 *
 * Base UI's tabs underneath, via shadcn's `line` variant, which is where the
 * roving focus, the arrow keys and the `aria-controls` wiring come from. Only
 * the geometry and the rule's colour are ours.
 */
function Tabs({ className, ...props }: ComponentProps<typeof TabsRoot>) {
  return <TabsRoot className={cn("gap-0", className)} {...props} />;
}

/** The strip itself. Scrolls sideways, silently, before it ever wraps. */
function TabsBar({ className, ...props }: ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      variant="line"
      className={cn(
        "no-scrollbar w-full justify-start gap-0.5 overflow-x-auto rounded-none border-b border-line p-0",
        // The list's own height is set behind an orientation selector, so
        // ours has to be too or it loses on specificity rather than on order.
        "group-data-horizontal/tabs:h-thead",
        className,
      )}
      {...props}
    />
  );
}

function Tab({ className, ...props }: ComponentProps<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      className={cn(
        "h-full flex-none rounded-none border-transparent px-3 text-body font-medium text-tx-2 hover:text-tx",
        "data-active:text-tx dark:data-active:text-tx",
        // The rule sits *on* the strip's hairline rather than above it, which
        // is what makes the current tab read as attached to its panel.
        "after:bg-brand group-data-horizontal/tabs:after:-bottom-px group-data-horizontal/tabs:after:h-0.5",
        className,
      )}
      {...props}
    />
  );
}

// A panel mounts when its tab is chosen, so `animate-fade` runs once per swap:
// content replaced in place, opacity only, nothing moves under the strip.
function TabPanel({ className, ...props }: ComponentProps<typeof TabsContent>) {
  return <TabsContent className={cn("animate-fade pt-4", className)} {...props} />;
}

Tabs.Bar = TabsBar;
Tabs.Tab = Tab;
Tabs.Panel = TabPanel;

export { Tabs, TabsBar, Tab, TabPanel };
