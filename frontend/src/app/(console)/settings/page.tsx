import type { Metadata } from "next";

import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";

import { SettingsIndexGroups } from "./_components/settings-index-groups";

export const metadata: Metadata = { title: "Settings" };

/**
 * The index. Every section, with the sentence that says what it is for.
 *
 * It is this page's only navigation: the section list that sits beside
 * every other settings screen would be a second copy of these cards, so it is
 * not drawn here. On a phone it is settings' navigation outright — a section's
 * screen links back here rather than carrying the list — because "which of
 * these do I want" is a question a label alone does not answer.
 *
 * **F16 grouped it and retitled it.** Twelve cards in one grid is a wall, and
 * the four groups are already declared in the registry, so the page reads them
 * rather than restating the order. The title moved from "Organization settings"
 * to "Settings" in the same change: Account is the signed-in person's and the
 * Platform group is the whole instance's, so the old title was true of exactly
 * half of what is now on this screen.
 */
export default function Page_() {
  return (
    <Page>
      <PageHeader
        title="Settings"
        icon="cog"
        lede="Your account, this Organization, what it connects to, and the instance it all runs on."
      />
      <SettingsIndexGroups />
    </Page>
  );
}
