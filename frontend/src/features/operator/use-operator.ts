import { useMutation, useQuery } from "@tanstack/react-query";

import { operatorApi } from "@/lib/api/endpoints/operator";
import type {
  BoughtServerSettingsChange,
  OperatorEnterpriseChange,
  RepriceConfirm,
} from "@/lib/api/endpoints/operator";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useInstanceMode } from "@/lib/api/use-instance-mode";

/**
 * Whether the signed-in person is an **Operator** (ADR-0050): an owner or
 * admin of the Instance organization, on the Hosted instance.
 *
 * Asks `GET /operator/access` only once the mode is known to be hosted — on a
 * Self-hosted instance the route does not exist, so the answer is no without
 * a request. `operator` stays false while either read is pending or failed:
 * the page is offered only on a yes. `hosted` is the mode, false until known.
 */
export function useIsOperator(): {
  operator: boolean;
  hosted: boolean;
  pending: boolean;
} {
  const mode = useInstanceMode();
  const hosted = mode.data === "hosted";
  const access = useQuery({
    queryKey: keys.operatorAccess(),
    queryFn: operatorApi.access,
    enabled: hosted,
    staleTime: 60_000,
    retry: false,
  });
  return {
    operator: hosted && access.data?.operator === true,
    hosted,
    pending: mode.isPending || (hosted && access.isPending),
  };
}

/** Every Organization's account facts; asked only for an Operator. */
export function useOperatorOrganizations(enabled: boolean) {
  return useQuery({
    queryKey: keys.operatorOrganizations(),
    queryFn: operatorApi.organizations,
    enabled,
    retry: false,
  });
}

/** Suspend an Organization with the reason its members will see. */
export function useSuspendOrganization() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      organizationId,
      reason,
    }: {
      organizationId: string;
      reason: string;
    }) => operatorApi.suspend(organizationId, reason),
    onSettled: () => invalidate.operatorOrganizations(),
  });
}

/** Lift an Organization's suspension. */
export function useLiftSuspension() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (organizationId: string) => operatorApi.lift(organizationId),
    onSettled: () => invalidate.operatorOrganizations(),
  });
}

/** Switch an Organization's Enterprise marker and set its counts. */
export function useSetEnterprise() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      organizationId,
      change,
    }: {
      organizationId: string;
      change: OperatorEnterpriseChange;
    }) => operatorApi.setEnterprise(organizationId, change),
    onSettled: () => invalidate.operatorOrganizations(),
  });
}

/** Every Bought Server with its real margin; asked only for an Operator. */
export function useOperatorBoughtServers(enabled: boolean) {
  return useQuery({
    queryKey: keys.operatorBoughtServers(),
    queryFn: operatorApi.boughtServers,
    enabled,
    retry: false,
  });
}

/** The Server markup, the margin floor and the reverse-DNS domain. */
export function useBoughtServerSettings(enabled: boolean) {
  return useQuery({
    queryKey: keys.operatorBoughtServerSettings(),
    queryFn: operatorApi.boughtServerSettings,
    enabled,
    retry: false,
  });
}

/** Set the Server markup and/or the margin floor. */
export function useSetBoughtServerSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (change: BoughtServerSettingsChange) =>
      operatorApi.setBoughtServerSettings(change),
    onSettled: () => invalidate.operatorBoughtServers(),
  });
}

/** The machines nothing owns, as the hourly check last found them (#1402). */
export function useOrphanMachines(enabled: boolean) {
  return useQuery({
    queryKey: keys.operatorOrphanMachines(),
    queryFn: operatorApi.orphanMachines,
    enabled,
    retry: false,
  });
}

/**
 * The reprice preview of the chosen Bought Servers (#1400): a read, though
 * a POST, asked afresh each time the box opens, since it follows the
 * provider's latest list.
 */
export function useRepricePreview(ids: string[], enabled: boolean) {
  return useQuery({
    queryKey: keys.operatorRepricePreview(ids),
    queryFn: () => operatorApi.previewReprice(ids),
    enabled: enabled && ids.length > 0,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** Delete a machine nothing owns, with its Volume and Primary IPs. */
export function useDeleteOrphanMachine() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (providerServerId: number) =>
      operatorApi.deleteOrphanMachine(providerServerId),
    onSettled: () => invalidate.operatorBoughtServers(),
  });
}

/** Apply the previewed reprice. */
export function useApplyReprice() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (servers: RepriceConfirm[]) => operatorApi.reprice(servers),
    onSettled: () => invalidate.operatorBoughtServers(),
  });
}
