import type { Metadata } from "next";

import { CloudAccountsSection } from "@/features/settings/cloud-accounts/cloud-accounts-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Cloud accounts" };

export default function Page() {
  return (
    <SettingsPage slug="cloud-accounts">
      <CloudAccountsSection />
    </SettingsPage>
  );
}
