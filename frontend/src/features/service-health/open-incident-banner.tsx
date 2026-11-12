import { Banner, BannerRow } from "@/components/console/banner";
import type { ServiceHealth } from "@/lib/api/endpoints/service-health";
import { timeAgo, timeExact, timeTaken } from "@/lib/format/time";
import { counted } from "@/lib/format/plural";

import { incidentOpening, incidentTitle } from "./health-words";

/**
 * **The open-Incident banner** — the Health tab's first section, because
 * a live problem is the first thing anyone opening this tab needs to see.
 *
 * One row per open Incident (at most one per check), naming the check's target,
 * the error that opened it, when, and for how long. It renders **nothing** when
 * nothing is open, and nothing while the summary is still arriving or was
 * refused: the sections under it say that, and a banner that reads "no open
 * Incidents" off a failed request would be the confident lie a refusal must
 * never become. An Error-rate threshold's Incident is a row here too,
 * worded by its rate rather than a target.
 */
export function OpenIncidentBanner({ health }: { health: ServiceHealth | undefined }) {
  const open = health?.openIncidents ?? [];
  if (open.length === 0) return null;

  return (
    <Banner
      icon="alert"
      title={`${counted(open.length, "open Incident", "open Incidents")} on this Service`}
      count={open.length}
    >
      {open.map((incident) => {
        const error = incidentOpening(incident);
        return (
          <BannerRow
            key={incident.incidentId}
            tone="bad"
            title={incidentTitle(incident, health?.uptimeChecks ?? [])}
            description={
              <>
                {error ? `${error}. ` : null}
                Opened{" "}
                <time dateTime={incident.openedAt} title={timeExact(incident.openedAt)}>
                  {timeAgo(incident.openedAt)}
                </time>
                , open for {timeTaken(incident.openedAt, null) ?? "a moment"}.
                Channels with Service incidents on were told when it opened,
                and are told once more when it closes.
              </>
            }
          />
        );
      })}
    </Banner>
  );
}
