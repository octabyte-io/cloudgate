import type { ComponentProps } from "react";

import { SearchInput } from "@/components/console/search-input";
import {
  TimeRange,
  type TimeRangeValue,
} from "@/components/console/time-range";
import { Toolbar, ToolbarGap } from "@/components/console/toolbar";
import type { RequestStatusClass } from "@/lib/api/endpoints/monitoring";

import { MethodFilter } from "./method-filter";
import { ServiceFilter } from "./service-filter";
import { StatusFilter } from "./status-filter";

/**
 * The controls that decide what is asked for: the Service filter on a
 * Server's log, then range, status, method and search.
 *
 * **Every one of them returns to the first page**, which the caller's
 * `navigate` (`useRequestsAddress`) does by dropping `page` from the address
 * on any change that does not set it — a filter change that left you on page
 * four would page through a result set that no longer exists.
 *
 * The sentence at the end is there because search is not one field: it matches the
 * host, and falls back to path and service only when no host matches. A box that
 * silently changed which column it searched would be the sort of thing people work
 * out by accident.
 */
export function RequestsToolbar({
  service,
  range,
  onRange,
  classes,
  onClasses,
  methods,
  onMethods,
  term,
  onTerm,
}: {
  /** The Service filter, first in the row; null where the log is not split by Service. */
  service: ComponentProps<typeof ServiceFilter> | null;
  range: TimeRangeValue;
  onRange: (range: TimeRangeValue) => void;
  classes: ReadonlySet<RequestStatusClass>;
  onClasses: (classes: ReadonlySet<RequestStatusClass>) => void;
  methods: ReadonlySet<string>;
  onMethods: (methods: ReadonlySet<string>) => void;
  term: string;
  onTerm: (term: string) => void;
}) {
  return (
    <Toolbar>
      {service ? <ServiceFilter {...service} /> : null}
      <TimeRange value={range} onChange={onRange} />
      <StatusFilter selected={classes} onChange={onClasses} />
      <MethodFilter selected={methods} onChange={onMethods} />
      <SearchInput
        label="Search by host, path or service"
        hideLabel
        placeholder="Search host, path or service"
        value={term}
        onChange={(event) => onTerm(event.currentTarget.value)}
      />
      <ToolbarGap />
      <p className="text-meta text-tx-3">
        Search matches the host, and falls back to path and service when no host
        matches.
      </p>
    </Toolbar>
  );
}
