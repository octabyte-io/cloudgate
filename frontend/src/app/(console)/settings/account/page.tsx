import type { Metadata } from "next";

import { AccountSection } from "@/features/settings/account/account-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Account" };

export default function Page() {
  return (
    <SettingsPage slug="account">
      <AccountSection />
    </SettingsPage>
  );
}
