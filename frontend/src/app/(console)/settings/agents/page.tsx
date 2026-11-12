import type { Metadata } from "next";

import { AgentsSection } from "@/features/agents/agents-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Agents" };

export default function Page() {
  return (
    <SettingsPage slug="agents">
      <AgentsSection />
    </SettingsPage>
  );
}
