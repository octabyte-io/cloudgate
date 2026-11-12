import type { Metadata } from "next";

import { OperatorSection } from "@/features/operator/operator-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Operator" };

export default function Page() {
  return (
    <SettingsPage slug="operator">
      <OperatorSection />
    </SettingsPage>
  );
}
