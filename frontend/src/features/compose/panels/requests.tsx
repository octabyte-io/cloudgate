"use client";

import { ServiceRequestsPanel } from "@/features/requests/service-requests-panel";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposeFactsCard } from "../compose-facts-card";
import { useCompose } from "../use-compose";

/**
 * A Compose's Requests tab: the Application's tab, for the lines of every
 * Domain of the stack, beside the facts card every other Compose tab carries.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const row = useCompose(id).data;
  return (
    <ServiceRequestsPanel
      serviceId={id}
      label={label}
      icon={icon}
      aside={
        row
          ? {
              node: <ComposeFactsCard compose={row} />,
              label: `About ${row.name}`,
            }
          : undefined
      }
    />
  );
}
