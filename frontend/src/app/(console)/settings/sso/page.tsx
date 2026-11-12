import type { Metadata } from "next";

import { SsoSection } from "@/features/enterprise/sso/sso-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Single sign-on" };

export default function Page() {
  return (
    <SettingsPage slug="sso">
      <SsoSection />
    </SettingsPage>
  );
}
