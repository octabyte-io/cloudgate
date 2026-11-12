"use client";

import { ServiceRequestsPanel } from "@/features/requests/service-requests-panel";
import type { PanelProps } from "@/lib/shell/tab-registry";

/**
 * An Application's Requests tab: its Server's Access log, fixed to this
 * Application. The whole tab is `ServiceRequestsPanel`, which a Compose's tab
 * shares.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  return <ServiceRequestsPanel serviceId={id} label={label} icon={icon} />;
}
