import type { Metadata } from "next";

import { InstanceSection } from "@/features/settings/platform/instance-section";
import { PlatformHostGate } from "@/features/operator/platform-host-gate";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Instance" };

export default function Page() {
  return (
    <SettingsPage slug="instance">
      <PlatformHostGate>
        <InstanceSection />
      </PlatformHostGate>
    </SettingsPage>
  );
}
