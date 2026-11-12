"use client";

import { TracesPanel } from "@/features/traces/traces-panel";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposeFactsCard } from "../compose-facts-card";
import { useCompose } from "../use-compose";

/**
 * A Compose's Traces tab: the Application's tab, for the one
 * Trace store every inner service of the Compose sends to, beside the facts
 * card every other Compose tab carries.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const row = useCompose(id).data;
  return (
    <TracesPanel
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
