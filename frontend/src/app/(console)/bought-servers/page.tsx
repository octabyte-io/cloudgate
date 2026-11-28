import type { Metadata } from "next";

import { BoughtServersScreen } from "@/features/server/bought-servers/bought-servers-screen";

export const metadata: Metadata = { title: "Bought Servers" };

/** Hosted only; the screen itself answers not-found anywhere else. */
export default function Page() {
  return <BoughtServersScreen />;
}
