import type { ReactNode } from "react";

import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { cn } from "@/lib/utils";

/** Where a Template's name and logo lead, best first. */
const HOMES = [
  ["website", "website"],
  ["docs", "docs"],
  ["source", "source code"],
] as const;

/**
 * The page a Template's name and logo open: its website, else its docs, else
 * its source. `null` when it has none of the three, and the name stays text,
 * because a link that leads nowhere is worse than no link.
 */
export function templateHome(
  links: TemplateSummary["links"],
): { href: string; what: string } | null {
  for (const [key, what] of HOMES) {
    const href = links[key];
    if (href) return { href, what };
  }
  return null;
}

/**
 * A Template's name as a link to its home page, in a new tab, like the
 * Website / Docs / Source links beside it. The page it opens and the new tab
 * are said in an `sr-only` span rather than an `aria-label`, so the name a
 * screen reader reads still starts with the name on screen. `relative` holds
 * that span: an absolutely positioned `sr-only` with no containing block
 * widens the document (design-system.md, `table`).
 */
export function TemplateHomeName({
  template,
  className,
  children,
}: {
  template: TemplateSummary;
  className?: string;
  children: ReactNode;
}) {
  const home = templateHome(template.links);
  if (!home) return <span className={className}>{children}</span>;
  return (
    <a
      href={home.href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        "relative rounded-sm underline-offset-3 hover:underline focus-visible:underline",
        className,
      )}
    >
      {children}{" "}
      <span className="sr-only">{`(${home.what}, opens in a new tab)`}</span>
    </a>
  );
}

/**
 * A Template's logo tile, as a link to the same page as its name when it has
 * one. Out of the tab order and hidden from screen readers: the name beside
 * it is the same link, and two stops for one target is noise. The pointer
 * gets it, because the logo is the bigger target and the first one aimed at.
 */
export function TemplateHomeLogo({
  template,
  className,
  children,
}: {
  template: TemplateSummary;
  className: string;
  children: ReactNode;
}) {
  const home = templateHome(template.links);
  if (!home) return <span className={className}>{children}</span>;
  return (
    <a
      href={home.href}
      target="_blank"
      rel="noreferrer noopener"
      tabIndex={-1}
      aria-hidden
      className={cn(className, "transition-colors duration-100 hover:border-line-2")}
    >
      {children}
    </a>
  );
}
