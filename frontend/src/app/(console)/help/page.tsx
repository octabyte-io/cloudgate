import type { Metadata } from "next";

import { HelpScreen } from "@/features/help/help-screen";

export const metadata: Metadata = { title: "Help & support" };

export default function Page() {
  return <HelpScreen />;
}
