import { useState } from "react";

import { Cols } from "@/components/console/cols";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import type { ServiceType } from "@/lib/api/endpoints/applications";
import type { IconName } from "@/lib/design/icons";
import { useServiceHealth } from "@/lib/api/use-service-health";

import { ErrorRateSection } from "./error-rate-section";
import { IncidentHistory } from "./incident-history";
import { OpenIncidentBanner } from "./open-incident-banner";
import { ThresholdSection } from "./threshold-section";
import { UptimeChecksSection } from "./uptime-checks-section";

/**
 * **The Health tab, for every Service kind**. The three
 * `panels/health.tsx` files — Application, Compose, database — are this with
 * their `serviceType`, so the seven kinds cannot drift apart.
 *
 * **The order is the spec's and each section is its own component**,
 * all on the one summary read: handed it, or reading the same cache entry
 * through `useServiceHealth(…, page, select)` — never a request of its own:
 *
 * 1. `OpenIncidentBanner` — nothing when nothing is open.
 * 2. `UptimeChecksSection` — the checks, each with its target, last verdict,
 *    the platform-host vantage line and the 24-hour strip; add, edit, turn off
 *    and on, and delete in a modal.
 * 3. `ErrorRateSection` — the Error rate over 24 hours (chart, slow share,
 *    per-Domain table), or the reason it has none.
 * 4. `ThresholdSection` — the one Error-rate threshold, or Add a threshold;
 *    add, edit, turn off and on, and remove in a modal.
 * 5. `IncidentHistory` — paged; the page is the only state this file holds.
 */
export function HealthPanel({
  serviceType,
  serviceId,
  label,
  icon,
  aside,
}: {
  serviceType: ServiceType;
  serviceId: string;
  label: string;
  icon: IconName;
  /**
   * The kind's facts card, for a kind whose other tabs carry one (Compose, a
   * database) — so the side card does not vanish on this tab alone.
   */
  aside?: { node: React.ReactNode; label: string };
}) {
  const [page, setPage] = useState(1);
  const health = useServiceHealth(serviceType, serviceId, page);

  const sections = (
    <>
      <OpenIncidentBanner health={health.data} />
      <UptimeChecksSection
        serviceType={serviceType}
        serviceId={serviceId}
        page={page}
      />
      <ErrorRateSection serviceType={serviceType} serviceId={serviceId} page={page} />
      <ThresholdSection serviceType={serviceType} serviceId={serviceId} page={page} />
      <IncidentHistory health={health} page={page} onPage={setPage} />
    </>
  );

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="Whether this Service answers, as the platform host sees it, how many of its requests fail, and every Incident its checks have opened."
      />
      {aside ? (
        <Cols aside={aside.node} asideLabel={aside.label}>
          {sections}
        </Cols>
      ) : (
        sections
      )}
    </Page>
  );
}
