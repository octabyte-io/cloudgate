import type { Metadata } from "next";

import { BillingSection } from "@/features/billing/billing-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Billing" };

export default function Page() {
  return (
    <SettingsPage slug="billing">
      <BillingSection />
    </SettingsPage>
  );
}
