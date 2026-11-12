"use client";

import { HealthPanel } from "@/features/service-health/health-panel";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposeFactsCard } from "../compose-facts-card";
import { useCompose } from "../use-compose";

/**
 * A Compose stack's Health tab: HTTP Uptime checks on the stack's own
 * Domains, whichever service inside it each routes to. The whole tab is
 * `HealthPanel`, shared by all seven Service kinds, beside the facts card every
 * other Compose tab carries — read from the scope's own cache entry.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const row = useCompose(id).data;
  return (
    <HealthPanel
      serviceType="compose"
      serviceId={id}
      label={label}
      icon={icon}
      aside={
        row
          ? { node: <ComposeFactsCard compose={row} />, label: `About ${row.name}` }
          : undefined
      }
    />
  );
}
