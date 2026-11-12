import Link from "next/link";

import { Dash } from "@/components/console/dash";
import { KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import { StatusPill } from "@/components/console/status-pill";
import { serviceHref } from "@/components/shell/service-href";
import type { ServiceType } from "@/lib/api/endpoints/applications";
import type {
  ServiceHealth,
  ServiceHealthRow,
  ServiceHealthState,
} from "@/lib/api/endpoints/service-health";
import { useServiceHealth } from "@/lib/api/use-service-health";
import type { Mark } from "@/lib/design/status";
import { timeAgo, timeExact } from "@/lib/format/time";

/**
 * A Service's worst current health as the console says it: the
 * Environment's Health column and the Overview's fact line. The state itself
 * is the backend's (`worstState`); this is only its words and its mark.
 * Promoted out of `features/service-health/` under §1.4: the Application,
 * Compose and database Overviews and the Environment's Services tab import it.
 */

/** Worst first, for sorting a column by it. */
export const HEALTH_STATE_RANK: Record<ServiceHealthState, number> = {
  incident: 0,
  down: 1,
  pending: 2,
  up: 3,
  unchecked: 4,
};

export function healthStateMark(state: ServiceHealthState): Mark {
  switch (state) {
    case "incident":
      return { glyph: "✕", tone: "bad", label: "Incident open" };
    case "down":
      return { glyph: "✕", tone: "warn", label: "down" };
    case "pending":
      return { glyph: "○", tone: "mute", label: "not probed yet" };
    case "up":
      return { glyph: "●", tone: "ok", label: "up" };
    case "unchecked":
      return { glyph: "⊘", tone: "mute", label: "not checked" };
  }
}

/** One Health column cell; a row the batch does not name reads as a dash. */
export function HealthCell({
  row,
  pending,
}: {
  row: ServiceHealthRow | undefined;
  pending: boolean;
}) {
  if (pending) return <Skeleton className="h-4 w-16" />;
  if (!row) return <Dash word="Unknown" />;
  return (
    <span title={row.openSince ? `Open since ${timeExact(row.openSince)}` : undefined}>
      <StatusPill mark={healthStateMark(row.state)} />
    </span>
  );
}

/**
 * The Overview's one health fact line: the state, what it rests on, and the
 * way to the Health tab. It reads the Service's own summary — page 1, the
 * Health tab's own cache entry — because that is the read the Service's
 * entitlement answers, where the Environment batch also needs the Environment.
 */
export function HealthFactRow({
  serviceType,
  serviceId,
}: {
  serviceType: ServiceType;
  serviceId: string;
}) {
  const health = useServiceHealth(serviceType, serviceId, 1);
  const href = `${serviceHref({ serviceType, serviceId })}/health`;
  const data = health.data;

  let value: React.ReactNode;
  if (health.error) {
    value = <span className="text-tx-2">Could not be read</span>;
  } else if (!data) {
    value = <Skeleton className="ml-auto h-4 w-24" />;
  } else {
    const words = factWords(data);
    // A block-level flex row, not `inline-flex`: the row's `truncate` cannot put
    // an ellipsis on an inline-flex box, so a narrow side card cut "no Uptime
    // check" to "no Uptime ch" with nothing to say so. The words carry
    // the ellipsis themselves, and their whole text as a title.
    value = (
      <span className="flex min-w-0 items-center justify-end gap-2">
        <span className="flex-none">
          <StatusPill mark={healthStateMark(data.state)} />
        </span>
        <span className="min-w-0 truncate text-tx-2" title={words || undefined}>
          {words}
        </span>
      </span>
    );
  }

  return (
    <KVRow
      label="Health"
      value={value}
      action={
        <Link
          href={href}
          className="text-meta font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
        >
          Health tab
        </Link>
      }
    />
  );
}

/** What the state rests on, in a few words beside the mark. */
function factWords(data: ServiceHealth): string {
  const enabled = data.uptimeChecks.filter((check) => check.enabled).length;
  switch (data.state) {
    case "incident": {
      const oldest = data.openIncidents.at(-1);
      const ago = oldest ? timeAgo(oldest.openedAt) : null;
      return ago ? `opened ${ago}` : "";
    }
    case "down":
      return "no Incident yet";
    case "pending":
    case "up":
      return enabled === 1 ? "1 Uptime check" : `${enabled} Uptime checks`;
    case "unchecked":
      return enabled > 0 ? "not probed while Stopped" : "no Uptime check";
  }
}
