import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { settingsSection } from "@/lib/settings/sections";

import { SettingsNav } from "./settings-nav";

/**
 * One settings screen's frame: the page measure, the section list beside it
 * (`SettingsNav`, a link back to the index on a phone), and this section's own
 * header taken from the registry.
 *
 * The `<h1>`, the icon and the lede come from `SETTINGS_SECTIONS` rather than
 * from the page, so the strip's label and the heading it leads to are one
 * declaration and cannot disagree — F07's contract rule 4, in the one part of
 * the app that is not a resource scope.
 *
 * `min-w-0` on the content column is load-bearing: a grid track's items default
 * to their min-content width, and a wide table would otherwise push the column
 * past the page rather than scroll inside its card.
 */
export function SettingsPage({
  slug,
  actions,
  children,
}: {
  slug: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const section = settingsSection(slug);

  return (
    <Page className="grid gap-x-8 cols:grid-cols-[var(--spacing-subnav)_minmax(0,1fr)]">
      <SettingsNav />
      <div className="min-w-0">
        <PageHeader
          title={section?.label ?? "Settings"}
          icon={section?.icon ?? "cog"}
          lede={section?.lede}
          actions={actions}
        />
        <div className="grid gap-5.5">{children}</div>
      </div>
    </Page>
  );
}
