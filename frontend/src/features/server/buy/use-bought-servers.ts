import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/api-error";

import { boughtServersApi } from "@/lib/api/endpoints/bought-servers";
import type {
  BoughtServerView,
  BuyChoice,
  BuyInput,
} from "@/lib/api/endpoints/bought-servers";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * Whether *Buy a Server* is offered here (ADR-0071).
 *
 * Asked only once the mode is known to be hosted: on a Self-hosted instance
 * the route does not exist, so the answer is no without a request. `offered`
 * stays false while anything is pending or refused, so the action is shown
 * only on a yes; `pending` says the answer is not in yet.
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

/** Every Location and size with its price; asked only once buying is offered. */
export function useBoughtServerCatalogue(enabled: boolean) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.boughtServers.catalogue(organizationId),
    queryFn: () => boughtServersApi.catalogue(),
    enabled: enabled && organizationId !== null,
    // The backend keeps a read for five minutes; asking more often buys nothing.
    staleTime: 5 * 60_000,
  });
}

/**
 * The Today box for a size in a Location: asked once both are chosen, and
 * again after a minute, since the amount shrinks as the month runs and Buy
 * refuses an amount older than an hour.
 */
export function useBoughtServerToday(choice: BuyChoice | null) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.boughtServers.today(
      organizationId,
      choice?.serverType ?? "",
      choice?.location ?? "",
      choice?.backups ?? false,
      choice?.storageGb ?? null,
    ),
    queryFn: () => boughtServersApi.today(choice!),
    enabled: choice !== null && organizationId !== null,
    staleTime: 60_000,
    retry: false,
  });
}

/** Buy. */
export function useBuyServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: BuyInput) => boughtServersApi.buy(input),
    onSettled: () => invalidate.boughtServers(),
  });
}

/** How often the list asks again while a purchase waits or its machine is being made. */
const PURCHASES_POLL_MS = 5_000;

/**
 * The Organization's Bought Servers not made yet, asked again every few
 * seconds while there are any, so a payment finished elsewhere (3D Secure)
 * shows its Server without a reload.
 */
export function useServerPurchases(enabled: boolean) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.boughtServers.purchases(organizationId),
    queryFn: () => boughtServersApi.purchases(),
    enabled: enabled && organizationId !== null,
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) > 0 ? PURCHASES_POLL_MS : false,
  });
}

/** *Finish paying*: where the payment stands, and where to finish it. */
export function useFinishPaying() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => boughtServersApi.finishPaying(id),
    onSettled: () => invalidate.boughtServers(),
  });
}

/** *Cancel* a purchase still waiting for payment. */
export function useCancelPurchase() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => boughtServersApi.cancel(id),
    onSettled: () => invalidate.boughtServers(),
  });
}

/** How often a Server's page asks again while its change runs. */
const CHANGING_POLL_MS = 3_000;

/**
 * The Bought Server behind a Server, on the Hosted instance only: null for a
 * Server that was not bought (the route answers 404), and asked again every
 * few seconds while a change runs, so **Changing** gives way by itself.
 */
export function useBoughtServer(serverId: string) {
  const mode = useInstanceMode();
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.boughtServers.server(organizationId, serverId),
    queryFn: async (): Promise<BoughtServerView | null> => {
      try {
        return await boughtServersApi.server(serverId);
      } catch (error) {
        if (error instanceof ApiError && error.isMissing) return null;
        throw error;
      }
    },
    enabled: mode.data === "hosted" && organizationId !== null,
    refetchInterval: (query) =>
      query.state.data?.stage === "changing" ? CHANGING_POLL_MS : false,
  });
}

/** Extra storage grown on a Ready Bought Server; the answer is the Server as it now is. */
export function useGrowStorage(serverId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidate();
  const { organizationId } = useActiveOrganizationId();
  const key = keys.boughtServers.server(organizationId, serverId);
  return useMutation({
    mutationFn: (sizeGb: number) =>
      boughtServersApi.growStorage(serverId, sizeGb),
    onSuccess: (view) => client.setQueryData(key, view),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: key }),
        invalidate.billing(),
      ]),
  });
}

/** Backups on or off on a Ready Bought Server; the answer is the Server as it now is. */
export function useSetBackups(serverId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidate();
  const { organizationId } = useActiveOrganizationId();
  const key = keys.boughtServers.server(organizationId, serverId);
  return useMutation({
    mutationFn: (enabled: boolean) =>
      boughtServersApi.setBackups(serverId, enabled),
    onSuccess: (view) => client.setQueryData(key, view),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: key }),
        invalidate.billing(),
      ]),
  });
}

/** The sizes a Bought Server can move to in its Location. */
export function useBoughtServerSizes(serverId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.boughtServers.sizes(organizationId, serverId),
    queryFn: () => boughtServersApi.sizes(serverId),
    enabled: organizationId !== null,
  });
}

/** A new size on a Ready Bought Server; the answer is the Server as it now is. */
export function useSetSize(serverId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidate();
  const { organizationId } = useActiveOrganizationId();
  const key = keys.boughtServers.server(organizationId, serverId);
  return useMutation({
    mutationFn: (serverType: string) =>
      boughtServersApi.setSize(serverId, serverType),
    onSuccess: (view) => client.setQueryData(key, view),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: key }),
        invalidate.billing(),
      ]),
  });
}
