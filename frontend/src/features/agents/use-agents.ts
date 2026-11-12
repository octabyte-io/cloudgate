import { useMutation, useQuery } from "@tanstack/react-query";

import {
  agentsApi,
  type AgentKeyExpiryDays,
  type CreateAgentInput,
} from "@/lib/api/endpoints/agents";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The Agents of the active Organization.
 *
 * Every write calls `invalidate.membership()`, not a narrower key: an Agent is
 * a member row, so creating or deleting one changes the member list too — the
 * Members card's pointer line counts Agents off it.
 */

export function useAgents() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.organization.agents(organizationId),
    queryFn: agentsApi.list,
    enabled: organizationId !== null,
  });
}

/**
 * The answer carries the Agent's first key, the one time it exists in
 * plaintext. `gcTime: 0` drops the finished mutation — and the key in its
 * `data` — the moment the dialog showing it unmounts, rather than keeping it
 * in the mutation cache for the default five minutes.
 */
export function useCreateAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: CreateAgentInput) => agentsApi.create(input),
    onSettled: () => invalidate.membership(),
  });
}

export function useDeleteAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSettled: () => invalidate.membership(),
  });
}

/** Suspend (`suspended: true`) or Resume (`false`). */
export function useSuspendAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      agentId,
      suspended,
    }: {
      agentId: string;
      suspended: boolean;
    }) => (suspended ? agentsApi.suspend(agentId) : agentsApi.resume(agentId)),
    onSettled: () => invalidate.membership(),
  });
}

/**
 * Another key for an Agent, answered once — `gcTime: 0` for
 * {@link useCreateAgent}'s reason.
 */
export function useAddAgentKey() {
  const invalidate = useInvalidate();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      agentId,
      expiresInDays,
    }: {
      agentId: string;
      expiresInDays: AgentKeyExpiryDays;
    }) => agentsApi.addKey(agentId, expiresInDays),
    onSettled: () => invalidate.membership(),
  });
}

/** Revoke a live key or Remove an expired one — the same DELETE. */
export function useRemoveAgentKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ agentId, keyId }: { agentId: string; keyId: string }) =>
      agentsApi.removeKey(agentId, keyId),
    onSettled: () => invalidate.membership(),
  });
}
