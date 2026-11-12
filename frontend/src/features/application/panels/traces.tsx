"use client";

import { TracesPanel } from "@/features/traces/traces-panel";
import type { PanelProps } from "@/lib/shell/tab-registry";

/**
 * An Application's Traces tab: its traces setting, its Trace store and
 * the store's search. The whole tab is `TracesPanel`, which a Compose's tab
 * shares.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  return (
    <TracesPanel serviceType="application" serviceId={id} label={label} icon={icon} />
  );
}
