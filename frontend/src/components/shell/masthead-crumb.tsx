import Link from "next/link";

import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { organizationNav } from "./nav";
import { useScope } from "./scope-provider";

/**
 * The Organization-scope breadcrumb, which fades into the masthead once the page
 * has scrolled (e-console.html:249-262, 4771-4777).
 *
 * It is the reference's behaviour and it is the reason `<main>` owns scrolling
 * rather than the document: the masthead has to be able to watch one element's
 * scroll offset without the page moving under it.
 *
 * Only at Organization scope. A resource scope already has its identity up there
 * permanently, so there would be nothing for this to reveal.
 */
export function MastheadCrumb({ scrolled }: { scrolled: boolean }) {
  const { scope } = useScope();
  const here = currentPage(scope.tab);

  if (!here) return null;

  return (
    <Link
      href={here.href}
      // Invisible *and* unreachable until it fades in, or the tab order runs
      // through a control nobody can see. `aria-hidden` as well, because a
      // breadcrumb naming the page you are already on is noise when it is not
      // standing in for the title that has scrolled away.
      aria-hidden={!scrolled}
      tabIndex={scrolled ? undefined : -1}
      className={cn(
        "flex min-w-0 items-center gap-1.75 text-ui font-medium text-tx-2 transition-[opacity,translate] duration-200 ease-out-strong max-lbl:hidden",
        scrolled
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-0.75 opacity-0",
      )}
    >
      <Icon name={here.icon} size={15} />
      <span className="truncate font-semibold text-tx">{here.label}</span>
    </Link>
  );
}

/**
 * Which Organization page this is, read off the nav table — so the crumb cannot
 * name a page the rail does not offer, and a phase that adds a row gets the
 * crumb for free.
 */
function currentPage(
  tab: string,
): { label: string; icon: IconName; href: string } | null {
  for (const entry of organizationNav()) {
    if (entry.kind !== "item" && entry.kind !== "group") continue;
    if (entry.tab === undefined) continue;
    if (entry.tab === tab) {
      return { label: entry.label, icon: entry.icon, href: entry.tab };
    }
  }
  return null;
}
