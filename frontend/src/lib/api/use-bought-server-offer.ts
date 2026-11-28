import { useQuery } from "@tanstack/react-query";

import { useActiveOrganizationId } from "@/lib/auth/client";

import { boughtServersApi } from "./endpoints/bought-servers";
import { keys } from "./keys";
import { useInstanceMode } from "./use-instance-mode";

/**
 * Whether *Buy a Server* is offered here (ADR-0071).
 *
 * Asked only once the mode is known to be hosted: on a Self-hosted instance
 * the route does not exist, so the answer is no without a request. `offered`
 * stays false while anything is pending or refused, so the action is shown
 * only on a yes; `pending` says the answer is not in yet.
 *
 * Here rather than beside the Buy screen's hooks in `features/server/buy/`
 * because the shell (the scope rail and the palette) and Get started ask it
 * too (§1.4's promotion rule).
 */
export function useBoughtServerOffer(): { offered: boolean; pending: boolean } {
  const mode = useInstanceMode();
  const { organizationId } = useActiveOrganizationId();
  const hosted = mode.data === "hosted";
  const offer = useQuery({
    queryKey: keys.boughtServers.offer(organizationId),
    queryFn: () => boughtServersApi.offer(),
    enabled: hosted && organizationId !== null,
    staleTime: Infinity,
    retry: false,
  });
  return {
    offered: hosted && offer.data?.offered === true,
    pending:
      mode.isPending ||
      (hosted && (organizationId === null || offer.isPending)),
  };
}
