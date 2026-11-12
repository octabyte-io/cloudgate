import { useQuery } from "@tanstack/react-query";

import { billingApi } from "@/lib/api/endpoints/billing";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * Whether the active Organization is frozen and why, and whether a payment has
 * failed — what the banner every member sees reads (ADR-0052). Any
 * member may ask. Asked only on the Hosted instance (`enabled`), where the
 * answer can be anything but empty.
 */
export function useStanding({ enabled }: { enabled: boolean }) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.standing(organizationId),
    queryFn: billingApi.standing,
    enabled: enabled && organizationId !== null,
    retry: false,
  });
}
