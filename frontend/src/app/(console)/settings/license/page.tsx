import type { Metadata } from "next";

import { LicenseSection } from "@/features/enterprise/license/license-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "License" };

export default function Page() {
  return (
    <SettingsPage slug="license">
      <LicenseSection />
    </SettingsPage>
  );
}
