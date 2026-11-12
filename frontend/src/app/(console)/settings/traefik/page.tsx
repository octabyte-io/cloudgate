import type { Metadata } from "next";

import { TraefikSection } from "@/features/settings/platform/traefik-section";
import { PlatformHostGate } from "@/features/operator/platform-host-gate";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Traefik" };

export default function Page() {
  return (
    <SettingsPage slug="traefik">
      <PlatformHostGate>
        <TraefikSection />
      </PlatformHostGate>
    </SettingsPage>
  );
}
