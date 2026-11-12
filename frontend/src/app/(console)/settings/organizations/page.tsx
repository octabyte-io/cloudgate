import type { Metadata } from "next";

import { OrganizationsSection } from "@/features/settings/organization/organizations-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Organizations" };

export default function Page() {
  return (
    <SettingsPage slug="organizations">
      <OrganizationsSection />
    </SettingsPage>
  );
}
