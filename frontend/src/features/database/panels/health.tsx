"use client";

import { TabPending } from "@/components/console/tab-pending";
import { HealthPanel } from "@/features/service-health/health-panel";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { DatabaseFactsCard } from "../database-facts-card";
import { useDatabase } from "../use-database";

/**
 * A database's Health tab, on all six engines. The engine is the
 * Service's `serviceType`, which is what `kind` names. Its checks section is
 * empty until a TCP check can dial the database's published port; the
 * banner and the Incident history read the same summary as every other kind.
 * The facts card sits beside it as on every other database tab.
 */
export default function Panel({ id, kind, label, icon }: PanelProps) {
  const row = useDatabase(kind, id).data;
  if (!kind) return <TabPending />;
  return (
    <HealthPanel
      serviceType={kind}
      serviceId={id}
      label={label}
      icon={icon}
      aside={
        row
          ? {
              node: <DatabaseFactsCard database={row} kind={kind} />,
              label: `About ${row.name}`,
            }
          : undefined
      }
    />
  );
}
