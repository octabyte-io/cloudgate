import type { Metadata } from "next";

import { DestinationsSection } from "@/features/integrations/destinations/destinations-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Destinations" };

export default function Page() {
  return (
    <SettingsPage slug="destinations">
      <DestinationsSection />
    </SettingsPage>
  );
}
