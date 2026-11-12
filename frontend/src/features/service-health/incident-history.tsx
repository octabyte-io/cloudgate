import type { UseQueryResult } from "@tanstack/react-query";

import { Card } from "@/components/console/card";
import { Dash } from "@/components/console/dash";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Pager } from "@/components/console/pager";
import { RowTime } from "@/components/console/rows/cells";
import { Skeleton } from "@/components/console/skeleton";
import { StatusPill } from "@/components/console/status-pill";
import type {
  Incident,
  ServiceHealth,
} from "@/lib/api/endpoints/service-health";
import { errorMessage } from "@/lib/api/error-message";
import { timeTaken } from "@/lib/format/time";

import {
  CLOSE_REASON_LABELS,
  incidentOpening,
  incidentTarget,
} from "./health-words";

/**
 * **The Incident history** — the Health tab's last section: every
 * Incident this Service's checks and its Error-rate threshold have opened,
 * newest first, open ones included, a page at a time.
 *
 * An Incident is kept for the life of its owner: a check's for the
 * life of that check, so this reaches back past the strip's 24 hours and the
 * Probes' 7 days, and deleting a check deletes its rows here too; a
 * threshold's for the life of the threshold — an edit keeps them, and
 * Remove deletes them with it. Each row says what an operator reviewing an
 * Incident asks: which target, when it started and ended, how long, the error
 * that opened it and why it closed. A threshold's Incidents read "Error rate"
 * as their target and the opening window's rate (and the worst while open) as
 * their opening error.
 */
export function IncidentHistory({
  health,
  page,
  onPage,
}: {
  health: UseQueryResult<ServiceHealth>;
  page: number;
  onPage: (page: number) => void;
}) {
  const data = health.data;
  const items = data?.incidents.items ?? [];
  const meta = data?.incidents.meta;
  const checks = data?.uptimeChecks ?? [];

  return (
    <Card>
      <Card.Header
        title="Incident history"
        sub="Every Incident this Service's checks and Error-rate threshold have opened, newest first."
        headingLevel={2}
      />
      {health.error && !data ? (
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(health.error)}</p>
        </Card.Body>
      ) : health.isPending ? (
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : (
        <>
          <Card.Body flush>
            <DataTable<Incident>
              label="Incident history of this Service"
              rows={items}
              getRowId={(row) => row.incidentId}
              empty={
                <EmptyState icon="clock" title="No Incidents">
                  None has opened here. One opens when a check is down enough
                  times in a row or the Error rate breaches its threshold.
                </EmptyState>
              }
              columns={[
                {
                  id: "target",
                  head: "Target",
                  tone: "wrap",
                  cell: (row) => (
                    <span className="font-mono text-meta wrap-anywhere">
                      {incidentTarget(row, checks)}
                    </span>
                  ),
                },
                {
                  id: "opened",
                  head: "Started",
                  cell: (row) => <RowTime iso={row.openedAt} />,
                },
                {
                  id: "closed",
                  head: "Ended",
                  cell: (row) =>
                    row.closedAt ? (
                      <RowTime iso={row.closedAt} />
                    ) : (
                      <StatusPill mark={{ glyph: "✕", tone: "bad", label: "open" }} />
                    ),
                },
                {
                  id: "duration",
                  head: "Duration",
                  tone: "num",
                  cell: (row) =>
                    timeTaken(row.openedAt, row.closedAt) ?? <Dash word="Unknown" />,
                },
                {
                  id: "error",
                  head: "Opening error",
                  tone: "wrap",
                  cell: (row) =>
                    incidentOpening(row) ?? <Dash word="None recorded" />,
                },
                {
                  id: "reason",
                  head: "Close reason",
                  cell: (row) =>
                    row.closeReason ? (
                      CLOSE_REASON_LABELS[row.closeReason]
                    ) : (
                      <Dash word="Still open" />
                    ),
                },
              ]}
            />
          </Card.Body>
          {meta && meta.totalItems > meta.limit ? (
            <Pager
              shown={items.length}
              total={meta.totalItems}
              noun="Incidents"
              from={(page - 1) * meta.limit + 1}
              onPrevious={meta.hasPreviousPage ? () => onPage(page - 1) : undefined}
              onNext={meta.hasNextPage ? () => onPage(page + 1) : undefined}
            />
          ) : null}
        </>
      )}
    </Card>
  );
}
