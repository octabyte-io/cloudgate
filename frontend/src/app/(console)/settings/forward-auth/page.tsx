import type { Metadata } from "next";

import { ForwardAuthSection } from "@/features/enterprise/forward-auth/forward-auth-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Forward auth" };

export default function Page() {
  return (
    <SettingsPage slug="forward-auth">
      <ForwardAuthSection />
    </SettingsPage>
  );
}
