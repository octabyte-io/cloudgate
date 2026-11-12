"use client";

import type { PanelProps } from "@/lib/shell/tab-registry";

import { ServerPanel } from "../server-panel";
import { BoughtServerCard } from "../settings/bought-server-card";
import { ConnectionCard } from "../settings/connection-card";
import { HousekeepingCard } from "../settings/housekeeping-card";
import { IdentityCard } from "../settings/identity-card";
import { MaintenanceCard } from "../settings/maintenance-card";
import { DnsChallengeServerCard } from "../settings/dns-challenge-server-card";
import { RequestLoggingServerCard } from "../settings/request-logging-server-card";
import { RequestMetricsServerCard } from "../settings/request-metrics-server-card";
import { DangerCard } from "../settings/server-danger-card";
import { SetupCommandCard } from "../settings/setup-command-card";

/**
 * Rename it, re-point it, replace its setup script, delete it.
 *
 * **Separate cards rather than one form, and the split is by consequence.** Identity is
 * safe to edit; the connection is where a typo makes a working Server unreachable; the
 * setup command replaces a script that installs software. Saving all of it together
 * would make one Save button mean three different sizes of change — which is why each
 * card is its own file with its own schema and its own Save.
 *
 * `PATCH /servers/:id` takes seven columns and six of them are here. The seventh —
 * `enableDockerCleanup` — is **not on this controller at all**: `updateServerSchema`
 * does not carry it, so `POST /settings/docker-cleanup` is the only writer there is
 * (`housekeeping-card.tsx`).
 *
 * The DNS-01 card is this machine's Traefik setting — the one a Server
 * has, since a Server has no Traefik screen of its own — and is saved by
 * `PUT /settings/traefik/dns-challenge` with this Server's id. Enable request
 * metrics sits under it for the same reason: it is this machine's Traefik, and
 * Request logging under that, at `#request-logging`.
 *
 * Maintenance sits with Housekeeping: both are about running this Server
 * rather than how Cloudgate reaches it (spec #1420).
 */
export default function Panel(props: PanelProps) {
  return (
    <ServerPanel panel={props}>
      {(server) => (
        <>
          <IdentityCard server={server} />
          <BoughtServerCard server={server} />
          <ConnectionCard server={server} />
          <SetupCommandCard server={server} />
          <HousekeepingCard server={server} />
          <MaintenanceCard server={server} />
          <DnsChallengeServerCard server={server} />
          <RequestMetricsServerCard server={server} />
          <RequestLoggingServerCard server={server} />
          <DangerCard server={server} />
        </>
      )}
    </ServerPanel>
  );
}
