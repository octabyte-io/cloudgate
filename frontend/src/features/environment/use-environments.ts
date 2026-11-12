import { useMutation, useQuery } from "@tanstack/react-query";

import { useForgetVisited } from "@/components/shell/recents";
import {
  environmentsApi,
  type CreateEnvironmentInput,
  type UpdateEnvironmentInput,
} from "@/lib/api/endpoints/environments";
import { tokenSpendApi } from "@/lib/api/endpoints/token-spend";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { roleRefusal } from "@/lib/auth/use-permission";

/**
 * What an Environment control says when the caller's role cannot use it
 * one per statement its routes check: `POST /environments` is
 * `environment: ['create']`, `PATCH /environments/:id` runs
 * `findOwnedForUpdate` for `environment: ['update']`, and `DELETE
 * /environments/:id` is `environment: ['delete']`. The built-in member holds
 * only the update.
 */
export const ENVIRONMENT_CREATE_REFUSAL = roleRefusal("create an Environment");
export const ENVIRONMENT_UPDATE_REFUSAL = roleRefusal("rename an Environment");
export const ENVIRONMENT_DELETE_REFUSAL = roleRefusal("delete an Environment");

/**
 * Everything the Environment screens read and write.
 *
 * Shorter than the Project side for one reason: an Environment's list route
 * takes its parent as a query parameter, so a Project's Environments are **one**
 * request rather than one per row. Its children come for free on top of that:
 * `GET /environments/:id` carries the services deployed in it
 * so the Services tab
 * needs no hook of its own — `useEnvironment` is the whole read.
 *
 * The Deployments and Domains tabs each get **one** query, not one per service
 * That is the whole
 * point of the routes behind them: a fan-out would have needed a partial state
 * on both screens, and a single request has no partial state to be in. Both keys
 * nest under the Environment's own, so `invalidate.environment` reaches them.
 *
 * Every mutation goes through `useInvalidate`, and the Environment one takes
 * `projectId` whenever the caller has it: without it, *every* Environment list
 * in the cache refetches to reflect a rename in one of them.
 */

export function useEnvironments(projectId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.byProject(organizationId, projectId),
    queryFn: () => environmentsApi.listByProject(projectId),
    enabled: organizationId !== null && projectId !== "",
  });
}

export function useEnvironment(environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.detail(organizationId, environmentId),
    queryFn: () => environmentsApi.findOne(environmentId),
    enabled: organizationId !== null && environmentId !== "",
    // A cloud Delete runs in the background: followed until it ends.
    refetchInterval: (query) =>
      query.state.data?.cloudDelete?.status === "deleting"
        ? LIVE_POLL_MS
        : false,
  });
}

/**
 * The Environment's Token spend over the last 30 days: the total and
 * each AI model's, summing only the AI models the caller can read. **One
 * request for the facts card and the Services table**, never one per row. Not
 * retried: a refusal is an answer, and the figures simply stay away.
 */
export function useEnvironmentTokenSpend(environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.tokenSpend(organizationId, environmentId),
    queryFn: () => tokenSpendApi.forEnvironment(environmentId),
    enabled: organizationId !== null && environmentId !== "",
    retry: false,
  });
}

/**
 * Every Deployment of every service in this Environment.
 *
 * **Polls while anything here is building** and stops when nothing is, the same
 * self-cancelling `refetchInterval` an Application's own Deployments tab uses: a
 * `pending` or `running` row moves without this screen touching it, and an
 * Environment feed is the one place someone watches several services release at
 * once. The decision is re-made from each answer, so the poll turns itself off
 * rather than the panel having to remember to.
 */
export function useEnvironmentDeployments(environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.deployments(organizationId, environmentId),
    queryFn: () => environmentsApi.listDeployments(environmentId),
    enabled: organizationId !== null && environmentId !== "",
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (row) => row.status === "pending" || row.status === "running",
      )
        ? LIVE_POLL_MS
        : false,
  });
}

/** Slow enough not to be a load, fast enough that a 20-second build is seen —
 * the interval an Application's own Deployments tab polls on. */
const LIVE_POLL_MS = 4_000;

/**
 * The Environment's networks in Cloud accounts. Polls while one is
 * being made or its run is still going, like the Deployments feed.
 */
export function useEnvironmentNetworks(environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.networks(organizationId, environmentId),
    queryFn: () => environmentsApi.listNetworks(environmentId),
    enabled: organizationId !== null && environmentId !== "",
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (network) =>
          network.status === "creating" ||
          network.status === "deleting" ||
          network.lastRun?.status === "pending" ||
          network.lastRun?.status === "running",
      )
        ? LIVE_POLL_MS
        : false,
  });
}

/** Every host answered by a service in this Environment. */
export function useEnvironmentDomains(environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.domains(organizationId, environmentId),
    queryFn: () => environmentsApi.listDomains(environmentId),
    enabled: organizationId !== null && environmentId !== "",
  });
}

export function useCreateEnvironment(projectId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: Omit<CreateEnvironmentInput, "projectId">) =>
      environmentsApi.create({ ...input, projectId }),
    onSuccess: () => invalidate.environment({ projectId }),
  });
}

export function useUpdateEnvironment(
  environmentId: string,
  projectId?: string,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateEnvironmentInput) =>
      environmentsApi.update(environmentId, input),
    onSuccess: () => invalidate.environment({ environmentId, projectId }),
  });
}

/**
 * Retry and Forget of an Environment's incomplete cloud Delete. The
 * Environment's reads and its networks' follow either.
 */
export function useEnvironmentCloudDeleteActions(
  environmentId: string,
  projectId: string,
) {
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  return {
    retry: useMutation({
      mutationFn: () => environmentsApi.retryCloudDelete(environmentId),
      onSettled: () =>
        Promise.all([
          invalidate.environment({ environmentId, projectId }),
          invalidate.environmentNetworks(environmentId),
        ]),
    }),
    forget: useMutation({
      mutationFn: () => environmentsApi.forgetCloudDelete(environmentId),
      onSuccess: () => {
        forgetVisited([environmentId]);
        return invalidate.environment({ environmentId, projectId });
      },
    }),
  };
}

export function useDeleteEnvironment(projectId?: string) {
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  return useMutation({
    mutationFn: (environmentId: string) =>
      environmentsApi.remove(environmentId),
    // Its services go from Recents with it.
    onSuccess: (_row, environmentId) => {
      forgetVisited([environmentId]);
      return invalidate.environment({ environmentId, projectId });
    },
  });
}
