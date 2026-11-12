import type { Metadata } from "next";

import { MembersSection } from "@/features/members/members-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Members" };

export default function Page() {
  return (
    <SettingsPage slug="members">
      <MembersSection />
    </SettingsPage>
  );
}
