"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "@/lib/design/icons";
import { settingsHref } from "@/lib/settings/sections";
import { cn } from "@/lib/utils";

import { useSettingsGroups } from "./use-settings-groups";

/**
 * Settings' one navigation, beside every settings screen.
 *
 * **A vertical list, not the horizontal strip it replaces.** The strip held
 * twenty-odd sections in one row: at 1440 it ran off the right edge with no
 * scroll cue, the active section could be the clipped one (on Cloud accounts
 * you could not see which page you were on), and at 390 even the second group
 * was off screen. Scrolling the active tab into view and fading the edge would
 * have treated the symptoms of a row that is simply too long for the set. A
 * column holds every section at once, in its groups, with the current one
 * always on screen — and grows by a line when a section is added.
 *
 * **Only where there is room for a column.** At `cols` and above it sits beside
 * the screen, the way an aside does. Below, the screen gets a single "Settings"
 * link back to the index instead, whose grouped cards are the navigation on a
 * phone — so the console never shows two navigations for one set of
 * destinations, and the `/settings` index shows only its cards.
 *
 * Links, not `console/tabs`: each section is its own route with its own address
 * and a person sends a colleague a link to *Notifications*. `aria-current="page"`
 * marks the one you are on. Each group is a list named by its visible label.
 * The Operator section is listed only for an Operator (`useSettingsGroups`).
 */
export function SettingsNav() {
  const pathname = usePathname();
  const groups = useSettingsGroups();

  return (
    <>
      <nav aria-label="Settings sections" className="max-cols:hidden">
        <div className="grid gap-4.5">
          {groups.map((group) => {
            const id = `settings-nav-${group.label.toLowerCase().replace(/\W+/g, "-")}`;
            return (
              <div key={group.label}>
                <p id={id} className="mb-1 px-2.5 text-meta font-medium text-tx-3">
                  {group.label}
                </p>
                <ul aria-labelledby={id} className="grid gap-px">
                  {group.sections.map((section) => {
                    const href = settingsHref(section.slug);
                    const current =
                      pathname === href || pathname.startsWith(`${href}/`);
                    return (
                      <li key={section.slug}>
                        <Link
                          href={href}
                          aria-current={current ? "page" : undefined}
                          className={cn(
                            "flex h-8 items-center gap-2 rounded-md px-2.5 text-ui font-medium transition-colors duration-100",
                            current
                              ? "bg-raise text-tx"
                              : "text-tx-2 hover:bg-raise hover:text-tx",
                          )}
                        >
                          <Icon
                            name={section.icon}
                            size={15}
                            className={current ? "text-brand-tx" : "text-tx-3"}
                          />
                          <span className="min-w-0 truncate">{section.label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </nav>

      <Link
        href="/settings"
        className="mb-4 inline-flex items-center gap-1.5 justify-self-start rounded-md text-ui font-medium text-tx-2 transition-colors duration-100 hover:text-tx cols:hidden"
      >
        <Icon name="back" size={15} />
        Settings
      </Link>
    </>
  );
}
