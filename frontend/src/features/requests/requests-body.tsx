import type { ComponentProps } from "react";

import { NARROW_RANGE } from "@/components/console/time-range";
import type { RequestsRead } from "@/lib/api/endpoints/monitoring";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { RequestsChart } from "./requests-chart";
import { RequestsLogCard } from "./requests-log-card";
import { RequestsToolbar } from "./requests-toolbar";
import { UnreadMessage } from "./requests-unread";
import type { ServiceFilter } from "./service-filter";
import type { RequestsAddress } from "./use-requests-address";

/**
 * Everything under the header of a Requests view — the filters, then the
 * chart and the table, or the message saying why a read has nothing to show
 * — shared by the Requests page and a Service's Requests tab
 *, so the two keep the same states, the same "showing back to" note
 * and the same filters.
 *
 * **One read answers the table, the chart and the totals**, so all three
 * count the same lines. While a read has nothing to show the filters are
 * greyed in a disabled fieldset — a filter cannot change why — and the
 * message replaces the chart and the table.
 */
export function RequestsBody({
  address,
  read,
  serviceFilter,
  serviceColumn,
  organizationName,
}: {
  address: RequestsAddress;
  read: {
    data?: RequestsRead;
    error: unknown;
    isPending: boolean;
    isFetching: boolean;
    refetch: () => unknown;
  };
  /** The Service filter, first in the toolbar; null where there is none. */
  serviceFilter: ComponentProps<typeof ServiceFilter> | null;
  /** Whether the table names each line's Service. */
  serviceColumn: boolean;
  /** The Server's Organization, for "ask an owner or admin of …". */
  organizationName: string;
}) {
  const { range, bounds, term, classes, methods, page, navigate } = address;
  const filtered =
    term.trim() !== "" ||
    classes.size > 0 ||
    methods.size > 0 ||
    (serviceFilter !== null &&
      (serviceFilter.selected.serviceIds.size > 0 ||
        serviceFilter.selected.noService));
  /** A read that found nothing to show says why, in place of the lines. */
  const unread = read.data && read.data.state !== "ok" ? read.data : null;

  return (
    <>
      <fieldset
        disabled={unread !== null}
        className={cn(
          "m-0 min-w-0 border-0 p-0",
          unread !== null && "opacity-50",
        )}
      >
        <legend className="sr-only">Filters</legend>
        <RequestsToolbar
          service={serviceFilter}
          range={range}
          onRange={(next) => navigate({ range: next })}
          classes={classes}
          onClasses={(next) => navigate({ status: [...next] })}
          methods={methods}
          onMethods={(next) => navigate({ method: [...next] })}
          term={term}
          onTerm={(next) => navigate({ q: next })}
        />
      </fieldset>

      {unread ? (
        <UnreadMessage
          read={unread}
          organizationName={organizationName}
          onRetry={() => void read.refetch()}
          onLastFifteenMinutes={() => navigate({ range: NARROW_RANGE.value })}
        />
      ) : (
        <>
          {read.data && read.data.withheldShared > 0 ? (
            <SharedHostNote
              subject={
                read.data.covers === "service"
                  ? "this Service"
                  : "your Services"
              }
            />
          ) : null}
          <RequestsChart range={range} bounds={bounds} read={read} />
          <RequestsLogCard
            logs={read}
            filtered={filtered}
            serviceColumn={serviceColumn}
            range={range}
            page={page}
            onPage={(next) => navigate({ page: String(next) })}
          />
        </>
      )}
    </>
  );
}

/**
 * On the platform host, a hostname more than one Organization holds there is
 * matched to no Service, so its lines are shown to neither (ADR-0061). Said
 * outright, so a quiet chart is not read as no traffic.
 */
function SharedHostNote({ subject }: { subject: string }) {
  return (
    <p
      role="note"
      className="flex items-start gap-2.5 rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-body text-tx"
    >
      <Icon name="alert" className="mt-0.5 flex-none text-warn" />
      <span>
        {`Some requests to ${subject} can't be shown because another Organization uses the same hostname on the platform host.`}
      </span>
    </p>
  );
}
