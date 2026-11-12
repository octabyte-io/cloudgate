import type { Metadata } from "next";

import { MonitoringScreen } from "@/features/monitoring/monitoring-screen";

export const metadata: Metadata = { title: "Monitoring" };

export default function Page() {
  return <MonitoringScreen />;
}
