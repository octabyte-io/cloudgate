import type { Metadata } from "next";

import { MaintenanceSection } from "@/features/settings/platform/maintenance-section";
import { PlatformHostGate } from "@/features/operator/platform-host-gate";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Maintenance" };

export default function Page() {
  return (
    <SettingsPage slug="maintenance">
      <PlatformHostGate>
        <MaintenanceSection />
      </PlatformHostGate>
    </SettingsPage>
  );
}
