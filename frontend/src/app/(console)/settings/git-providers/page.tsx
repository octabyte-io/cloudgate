import type { Metadata } from "next";

import { GitProvidersSection } from "@/features/integrations/git-providers/git-providers-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Git providers" };

export default function Page() {
  return (
    <SettingsPage slug="git-providers">
      <GitProvidersSection />
    </SettingsPage>
  );
}
