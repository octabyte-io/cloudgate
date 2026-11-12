import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { tokenSpendApi } from "@/lib/api/endpoints/token-spend";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

import { type SpendRange, spendWindow } from "./token-spend-view";

/**
 * One AI model's Token spend over a range: `GET
 * /applications/:id/token-spend` with the range's UTC days. Keyed by the
 * window rather than the range, so "7 days" rolls over at midnight UTC.
 *
 * **The previous window stays on screen while the next one loads**, so
 * switching ranges does not collapse the card to a skeleton and back.
 */
export function useTokenSpend(applicationId: string, range: SpendRange) {
  const { organizationId } = useActiveOrganizationId();
  const window = spendWindow(range, new Date());
  return useQuery({
    queryKey: keys.applications.tokenSpend(
      organizationId,
      applicationId,
      window,
    ),
    queryFn: () => tokenSpendApi.forAiModel(applicationId, window),
    enabled: organizationId !== null && applicationId !== "",
    placeholderData: keepPreviousData,
    retry: false,
  });
}
