import type { Metadata } from "next";

import { AiSection } from "@/features/integrations/ai/ai-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "AI" };

export default function Page() {
  return (
    <SettingsPage slug="ai">
      <AiSection />
    </SettingsPage>
  );
}
