import type { Metadata } from "next";

import { RegistriesSection } from "@/features/integrations/registries/registries-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Registries" };

export default function Page() {
  return (
    <SettingsPage slug="registries">
      <RegistriesSection />
    </SettingsPage>
  );
}
