import type { Metadata } from "next";

import { DeploymentsScreen } from "@/features/deployments/deployments-screen";

export const metadata: Metadata = { title: "Deployments" };

export default function Page() {
  return <DeploymentsScreen />;
}
