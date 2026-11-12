import type { Metadata } from "next";

import { WhitelabelingSection } from "@/features/enterprise/whitelabeling/whitelabeling-section";
import { PlatformHostGate } from "@/features/operator/platform-host-gate";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Branding" };

export default function Page() {
  return (
    <SettingsPage slug="branding">
      <PlatformHostGate>
        <WhitelabelingSection />
      </PlatformHostGate>
    </SettingsPage>
  );
}
