import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Pager } from "@/components/console/pager";
import { Skeleton } from "@/components/console/skeleton";
import {
  rangeLabel,
  type TimeRangeValue,
} from "@/components/console/time-range";
import { errorMessage } from "@/lib/api/error-message";

import type {
  RequestsCoverage,
  RequestsRead,
} from "@/lib/api/endpoints/monitoring";
import { clockTime } from "@/lib/format/time";
import { cn } from "@/lib/utils";

import { requestColumns } from "./request-columns";
import { useSwapFade } from "@/components/console/use-swap-fade";

/** 50 rows. The log is read and sorted server-side; the page is what travels. */
export const PAGE_SIZE = 50;

/**
 * The log itself, a page at a time.
 *
 * Two details that are about *not* making the card jump: the table scrolls inside
 * its own container, because eight dense columns cannot wrap and the page body must
 * never scroll sideways; and a refetch holds the previous rows at reduced opacity
 * rather than flashing a skeleton, so paging does not change the card's height (the
 * `dataviz` rule).
 *
 * The empty state distinguishes **filters matched nothing** from **nothing arrived**,
 * and says the filters apply to the whole window rather than to the page shown.
 */
export function RequestsLogCard({
  logs,
  filtered,
  serviceColumn = true,
  range,
  page,
  onPage,
}: {
  logs: {
    data?: RequestsRead;
    error: unknown;
    isPending: boolean;
    isFetching: boolean;
  };
  /** Any of the Service filter, search, status or method is set. */
  filtered: boolean;
  /**
   * Whether the table names each line's Service: not on a Service's own
   * Requests tab, where every line is that Service's.
   */
  serviceColumn?: boolean;
  range: TimeRangeValue;
  page: number;
  onPage: (page: number) => void;
}) {
  const rows = logs.data?.data ?? [];
  const swap = useSwapFade<HTMLDivElement>(logs.data);
  const total = logs.data?.totalCount ?? 0;

  return (
    <Card>
      <Card.Header
        title="Request log"
        sub="Newest first. Every column sorts."
        headingLevel={2}
      />
      {logs.error ? (
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(logs.error)}</p>
        </Card.Body>
      ) : logs.isPending ? (
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : (
        <>
          <MetaStrip>
            <strong>{rows.length}</strong> of <strong>{total}</strong>{" "}
            {total === 1 ? "request" : "requests"}
            {COVERS[logs.data?.covers ?? "server"]}
            {filtered ? " matching the filters" : ""} in the last{" "}
            {rangeLabel(range)}.
          </MetaStrip>
          <Card.Body flush>
            <div
              aria-busy={logs.isFetching || undefined}
              className={cn(
                "transition-opacity duration-150 ease-out-strong",
                logs.isFetching && "opacity-60",
              )}
            >
              {/* The rows fade in when a read answers with a new page — a
                  filter, the range or the pager — never per row, and never
                  while they are dimmed waiting for it. */}
              <div ref={swap}>
                <DataTable
                  label="Requests Traefik served"
                  columns={requestColumns({ service: serviceColumn })}
                  rows={rows}
                  getRowId={(row) =>
                    `${row.StartUTC}-${row.RequestHost ?? ""}-${row.RequestPath ?? ""}-${row.ClientAddr}`
                  }
                  // A request with no Host header has no `RequestHost`; the
                  // row is named by what it did carry rather than by "undefined".
                  rowName={(row) =>
                    `${row.RequestMethod} ${row.RequestHost ?? "(no host)"}${row.RequestPath ?? ""}`
                  }
                  defaultSort={{ id: "when", dir: "desc" }}
                  empty={
                    <EmptyState
                      icon="globe"
                      title={
                        filtered
                          ? "No request matches those filters"
                          : "No requests in this window"
                      }
                    >
                      {filtered
                        ? "Widen the window, or clear the Service, status, method and search filters. They apply to the whole window, not to the page shown."
                        : "Choose a longer range to reach back to when there was traffic."}
                    </EmptyState>
                  }
                />
              </div>
            </div>
          </Card.Body>
          <Card.Footer>
            {logs.data ? (
              <p className="text-meta text-tx-3">
                Read from {logs.data.target.name} at{" "}
                <time dateTime={logs.data.readAt} title={logs.data.readAt}>
                  {clockTime(logs.data.readAt)}
                </time>
              </p>
            ) : null}
            <Pager
              shown={rows.length}
              total={total}
              noun="requests"
              from={page * PAGE_SIZE + 1}
              onPrevious={page > 0 ? () => onPage(page - 1) : undefined}
              onNext={
                (page + 1) * PAGE_SIZE < total
                  ? () => onPage(page + 1)
                  : undefined
              }
            />
          </Card.Footer>
        </>
      )}
    </Card>
  );
}

/**
 * Whose requests the totals count, after "N of M requests": nothing for the
 * whole Server, and otherwise said, so a partial count never reads as the
 * Server's.
 */
const COVERS: Record<RequestsCoverage, string> = {
  server: "",
  "your-services": " to your Services",
  "chosen-services": " to the chosen Services",
  // A Service's own tab, whose subject already says whose.
  service: "",
};
