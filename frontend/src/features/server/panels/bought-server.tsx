"use client";

import type { PanelProps } from "@/lib/shell/tab-registry";

import {
  BoughtServerActions,
  BoughtServerAside,
  BoughtServerMain,
} from "../bought-server/bought-server-tab";
import { ServerPanel } from "../server-panel";

/**
 * A **Bought Server**'s own tab (#198, ADR-0071, ADR-0093): Back up now in
 * the header; Server backups, then Size and storage; What you pay and About
 * this Server in the aside. Only a Server bought from Cloudgate has it
 * (`tabs/server.ts`). Delete stays on Settings.
 */
export default function Panel(props: PanelProps) {
  return (
    <ServerPanel
      panel={props}
      actions={(server) => <BoughtServerActions server={server} />}
      aside={(server) => <BoughtServerAside server={server} />}
    >
      {(server) => <BoughtServerMain server={server} />}
    </ServerPanel>
  );
}
