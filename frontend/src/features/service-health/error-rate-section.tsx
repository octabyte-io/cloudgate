import { Card } from "@/components/console/card";
import { Chart } from "@/components/console/chart";
import { DataTable } from "@/components/console/data-table";
import { Dash } from "@/components/console/dash";
import { EmptyState } from "@/components/console/empty-state";
import { Skeleton } from "@/components/console/skeleton";
import { StatGrid, StatTile } from "@/components/console/stat-tile";
import { errorMessage } from "@/lib/api/error-message";
import type { ServiceType } from "@/lib/api/endpoints/applications";
import type {
  ErrorRate,
  ErrorRateTotals,
  ErrorRateUnavailableReason,
  ServiceHealth,
} from "@/lib/api/endpoints/service-health";
import { timeAgo, timeExact } from "@/lib/format/time";
import { useServiceHealth } from "@/lib/api/use-service-health";

import { shareLabel } from "./uptime-strip";

/**
 * What an operator can do about each unavailable reason. The reason itself is
 * the backend's sentence, shown as it is; this is only the line under it.
 */
const REASON_HINTS: Record<ErrorRateUnavailableReason, string> = {
  database:
    "An Error rate counts the requests Traefik routes to a Domain, and a database is not reached through one.",
  "no-domain":
    "An Error rate counts the requests Traefik routes to this Service's Domains. Add a Domain and it starts.",
  "metrics-not-enabled":
    "This Service's Server does not keep request counts yet. Enable request metrics with the Server's Traefik controls.",
  "no-samples":
    "Request metrics are on, and the first counts have not been collected yet. They are read once a minute.",
};

/** The summary's Error rate. Module-level, so `select` memoises. */
const errorRateOf = (health: ServiceHealth): ErrorRate => health.errorRate;

/**
 * A quarter-hour with no requests, as a plot value. `Plot` takes numbers and
 * clamps below its domain to the floor, so this draws at the floor like a
 * quiet 0 would — but {@link percentWords} reads it back as "No requests", so
 * neither the readout nor the table ever says 0 % for it.
 */
const NO_REQUESTS = -1;

function percentWords(value: number): string {
  return value < 0 ? "No requests" : `${shareLabel(value / 100)} answered 5xx`;
}

/** `0.0123` → `"1.2%"`; no requests reads as such, never as 0 %. */
function shareOrNone(share: number | null): string {
  return share === null ? "No requests" : shareLabel(round(share));
}

/** A share to a tenth of a percent, so `shareLabel` never prints 33.33333%. */
function round(share: number): number {
  return Math.round(share * 1000) / 1000;
}

/**
 * **The Health tab's Error rate** (ADR-0027) — the third section, under
 * the Uptime checks: the share of this Service's requests its Server's Traefik
 * answered with a 5xx over the last 24 hours, as a chart, the slow-request
 * share beside it, and a table per Domain.
 *
 * **When there is no Error rate it says why** — the backend's reason, verbatim,
 * with a line on what to do about it — and never draws 0 %. A quarter-hour with
 * no requests is "No requests" in the chart's readout and table for the same
 * reason.
 *
 * It reads the summary's `errorRate` through the panel's cache entry (`page`),
 * never a request of its own.
 */
export function ErrorRateSection({
  serviceType,
  serviceId,
  page,
}: {
  serviceType: ServiceType;
  serviceId: string;
  page: number;
}) {
  const rate = useServiceHealth(serviceType, serviceId, page, errorRateOf);

  return (
    <Card>
      <Card.Header
        title="Error rate"
        sub="The share of this Service's requests its Server's Traefik answered with a 5xx, over the last 24 hours."
        headingLevel={2}
      />
      {rate.error && !rate.data ? (
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(rate.error)}</p>
        </Card.Body>
      ) : !rate.data ? (
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-plot w-full" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : rate.data.available ? (
        <ErrorRateFigures rate={rate.data} />
      ) : (
        <Card.Body>
          <EmptyState icon="gauge" title={rate.data.message}>
            {REASON_HINTS[rate.data.reason]}
          </EmptyState>
        </Card.Body>
      )}
    </Card>
  );
}

function ErrorRateFigures({
  rate,
}: {
  rate: Extract<ErrorRate, { available: true }>;
}) {
  const { totals, series, domains } = rate;
  const values = series.map((bucket) =>
    bucket.errorRate === null ? NO_REQUESTS : bucket.errorRate * 100,
  );
  const peak = Math.max(0, ...values);

  return (
    <>
      <Card.Body className="grid gap-3.5">
        <Chart
          label="Error rate"
          value={shareOrNone(totals.errorRate)}
          detail={
            totals.requests === 0
              ? "No requests in the last 24 hours"
              : `${totals.errors.toLocaleString()} of ${totals.requests.toLocaleString()} requests answered 5xx`
          }
          values={values}
          // A rate that fails 2 % of the time drawn against 0–100 is a flat
          // line; drawn against its own peak (at least 5 %) the shape shows.
          domain={[0, Math.max(5, peak)]}
          format={percentWords}
          labelAt={(index) => timeExact(series[index]?.start) ?? `Quarter-hour ${index + 1}`}
          tickCount={4}
        />
        <StatGrid>
          <StatTile
            label="Slow requests"
            value={shareOrNone(totals.slowShare)}
            detail={
              totals.requests === 0
                ? "No requests in the last 24 hours"
                : `${totals.slow.toLocaleString()} took longer than 1.2 s`
            }
          />
          <StatTile
            label="Requests"
            value={totals.requests.toLocaleString()}
            detail="in the last 24 hours"
          />
        </StatGrid>
      </Card.Body>
      <Card.Body flush>
        <DataTable<(typeof domains)[number]>
          label="Error rate per Domain"
          rows={domains}
          getRowId={(row) => row.domainId}
          empty={<EmptyState icon="globe" title="No Domains" />}
          columns={[
            {
              id: "host",
              head: "Domain",
              tone: "wrap",
              cell: (row) => (
                <span className="font-mono text-meta wrap-anywhere">{row.host}</span>
              ),
            },
            {
              id: "requests",
              head: "Requests",
              tone: "num",
              cell: (row) => row.requests.toLocaleString(),
            },
            {
              id: "errors",
              head: "5xx",
              tone: "num",
              cell: (row) => row.errors.toLocaleString(),
            },
            {
              id: "rate",
              head: "Error rate",
              tone: "num",
              cell: (row) => shareCell(row, "errorRate"),
            },
            {
              id: "slow",
              head: "Slow",
              tone: "num",
              cell: (row) => shareCell(row, "slowShare"),
            },
          ]}
        />
      </Card.Body>
      <Card.Footer>
        Counted by Traefik on this Service&rsquo;s Server; a 5xx Traefik answers
        itself, with the containers down, counts too. Last collected{" "}
        <time dateTime={rate.lastCollectedAt} title={timeExact(rate.lastCollectedAt)}>
          {timeAgo(rate.lastCollectedAt) ?? rate.lastCollectedAt}
        </time>
        .
      </Card.Footer>
    </>
  );
}

function shareCell(row: ErrorRateTotals, key: "errorRate" | "slowShare") {
  const share = row[key];
  return share === null ? <Dash word="No requests" /> : shareLabel(round(share));
}
