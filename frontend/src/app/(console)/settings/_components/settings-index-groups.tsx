"use client";

import Link from "next/link";

import { Card } from "@/components/console/card";
import { Icon } from "@/lib/design/icons";
import { settingsHref } from "@/lib/settings/sections";

import { useSettingsGroups } from "./use-settings-groups";

/**
 * The index's grouped cards. A client component, apart from the page, only
 * because whether the Operator card is among them depends on who is reading
 * (`useSettingsGroups`, ADR-0050).
 */
export function SettingsIndexGroups() {
  const groups = useSettingsGroups();

  return (
    <div className="grid gap-7">
      {groups.map((group) => (
        <section key={group.label} aria-labelledby={groupId(group.label)}>
          <h2
            id={groupId(group.label)}
            className="mb-2.5 text-ui font-medium text-tx-3"
          >
            {group.label}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.sections.map((section) => (
              <Card key={section.slug} tone="plain">
                <Link
                  href={settingsHref(section.slug)}
                  className="flex h-full items-start gap-3 rounded-xl p-4 transition-colors duration-100 hover:bg-raise"
                >
                  <Icon
                    name={section.icon}
                    size={18}
                    className="mt-0.5 flex-none text-tx-2"
                  />
                  <span className="min-w-0">
                    <span className="block text-body font-semibold text-tx">
                      {section.label}
                    </span>
                    <span className="mt-1 block text-meta text-tx-2">
                      {section.lede}
                    </span>
                  </span>
                </Link>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const groupId = (label: string) =>
  `settings-group-${label.toLowerCase().replace(/\W+/g, "-")}`;
