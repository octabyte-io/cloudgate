import type { Metadata } from "next";

import { NotificationsSection } from "@/features/integrations/notifications/notifications-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Notifications" };

export default function Page() {
  return (
    <SettingsPage slug="notifications">
      <NotificationsSection />
    </SettingsPage>
  );
}
