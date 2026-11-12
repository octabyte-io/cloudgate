import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  auditLogsApi,
  type AuditLogFilters,
} from "@/lib/api/endpoints/audit-logs";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * One page of the trail, for one set of filters.
 *
 * **Every filter is part of the key**, because every one of them is an input to
 * the response: a narrowed table is a different question and not the same one
 * refetched. `filterKey` serialises them in a fixed order so two identical
 * filter states produce the same string — object key order is stable in
 * practice but relying on it is how a cache quietly stops hitting.
 *
 * `keepPreviousData` is what makes the pager usable. Without it every page turn
 * unmounts the table and puts a skeleton where the rows were, so the row you
 * were reading is replaced by a flash of nothing and the page height jumps.
 * With it the previous page stays on screen, marked busy, until the next one
 * lands.
 */
export function useAuditLogs(filters: AuditLogFilters) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.auditLogs.page(organizationId, filterKey(filters)),
    queryFn: () => auditLogsApi.list(filters),
    enabled: organizationId !== null,
    placeholderData: keepPreviousData,
  });
}

/** The filters as one stable string. Absent values are omitted, not `undefined`. */
function filterKey(filters: AuditLogFilters): string {
  const parts: string[] = [];
  const push = (name: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") parts.push(`${name}=${value}`);
  };
  push("scope", filters.scope);
  push("userId", filters.userId);
  push("userEmail", filters.userEmail);
  push("resourceName", filters.resourceName);
  push("action", filters.action);
  push("resourceType", filters.resourceType);
  push("outcome", filters.outcome);
  push("from", filters.from);
  push("to", filters.to);
  push("limit", filters.limit);
  push("offset", filters.offset);
  return parts.join("&");
}
