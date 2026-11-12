import type { Metadata } from "next";

import { RolesSection } from "@/features/enterprise/roles/roles-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Roles" };

export default function Page() {
  return (
    <SettingsPage slug="roles">
      <RolesSection />
    </SettingsPage>
  );
}
