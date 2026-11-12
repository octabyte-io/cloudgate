"use client";

import { HealthPanel } from "@/features/service-health/health-panel";
import type { PanelProps } from "@/lib/shell/tab-registry";

/**
 * An Application's Health tab: its HTTP Uptime checks on its own
 * Domains, the open-Incident banner and the Incident history. The whole tab is
 * `HealthPanel`, shared by all seven Service kinds.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  return (
    <HealthPanel serviceType="application" serviceId={id} label={label} icon={icon} />
  );
}
