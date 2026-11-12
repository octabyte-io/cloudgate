import type { Metadata } from "next";

import { BuyScreen } from "@/features/server/buy/buy-screen";

export const metadata: Metadata = { title: "Buy a Server" };

/**
 * A static segment beside `[serverId]`, which Next matches first: no Server
 * id is the word `buy`, since ids are nanoids. Hosted only; the screen
 * itself answers not-found anywhere else.
 */
export default function Page() {
  return <BuyScreen />;
}
