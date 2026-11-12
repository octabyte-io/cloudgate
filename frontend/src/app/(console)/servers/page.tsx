import type { Metadata } from "next";

import { FleetScreen } from "@/features/server/fleet/fleet-screen";

export const metadata: Metadata = { title: "Servers" };

export default function Page() {
  return <FleetScreen />;
}
