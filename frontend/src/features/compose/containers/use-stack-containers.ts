import { useMutation, useQuery } from "@tanstack/react-query";

import { ApiError, isUnreachableHost } from "@/lib/api/api-error";
import { dockerApi, type ContainerAppType } from "@/lib/api/endpoints/docker";
import { errorMessage } from "@/lib/api/error-message";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

import { useComposeServices } from "../use-compose";
import { joinContainers, type StackContainer } from "./join-containers";

/**
 * The containers a stack actually produced, joined to the services its file
 * declares.
 *
 * **This is the phase brief's endpoint question, answered.** The brief suggested
 * `GET /compose/:id/services` plus `GET /docker/containers/stack`; the audit says
 * neither is what it looks like:
 *
 * - `compose/:id/services` is **file-derived** — the service *names* in the YAML,
 *   with nothing about what is running.
 * - `docker/containers/stack` is `docker stack ps`, so it is **Swarm tasks only**
 *   and empty for a `docker-compose` stack — and its `{{.ID}}` is a *task* id,
 *   which none of the container lifecycle routes and neither log gateway accepts.
 *
 * So this joins **three** reads, and each one contributes what only it has:
 *
 * 1. `containers/search` — membership and live state, narrowed to this stack (by
 *    the compose project label, or by the stack namespace label for a Swarm
 *    stack). Its
 *    `containerId` is the real one, so this is what the actions and the logs use.
 * 2. `containers` — the full `docker ps -a`, which is the **only** route carrying
 *    an image and a port map. Joined on container id.
 * 3. `containers/stack` — Swarm tasks, for a stack only, because a task carries
 *    the node it landed on and *why it did not start*, which no container has.
 *
 * A declared service with no container gets a row anyway. That is the whole reason
 * to join rather than list: after a partial deploy, "the file says there should be
 * a worker and there is no worker" is the most useful thing this screen can say,
 * and a list of running containers cannot say it.
 */

export type { StackContainer };

export function useStackContainers(compose: ComposeDetail) {
  const { organizationId } = useActiveOrganizationId();
  const appType: ContainerAppType =
    compose.composeType === "stack" ? "stack" : "docker-compose";
  const serverId = compose.serverId;
  const enabled = organizationId !== null && compose.appName !== "";
  // A converge is in flight, so what is running is changing under the table.
  const live = compose.composeStatus === "running";

  const members = useQuery({
    queryKey: keys.docker.byApp(
      organizationId,
      serverId,
      compose.appName,
      appType,
    ),
    queryFn: () =>
      dockerApi.containersByApp({ appName: compose.appName, appType, serverId }),
    enabled,
    refetchInterval: live ? 4_000 : false,
  });

  /**
   * The whole host's listing, for the image and the ports.
   *
   * Kept as its own query rather than folded in, because it is the one read here
   * that is **not about this stack** — it is shared with every other stack on the
   * host and with F13's Docker tab, and it needs `docker:read` where the narrowed
   * one needs `service:read`. A role with one and not the other loses the Image
   * column and keeps the table.
   */
  const listing = useQuery({
    queryKey: keys.docker.containers(organizationId, serverId),
    // `null` when docker would not say: `dockerApi.containers` maps the empty
    // body itself, since TanStack refuses `undefined` as query data.
    queryFn: () => dockerApi.containers(serverId),
    enabled,
    refetchInterval: live ? 4_000 : false,
  });

  const tasks = useQuery({
    queryKey: keys.docker.stackTasks(organizationId, serverId, compose.appName),
    queryFn: () =>
      dockerApi.stackTasks({ appName: compose.appName, serverId }),
    enabled: enabled && appType === "stack",
    refetchInterval: live ? 4_000 : false,
  });

  const declared = useComposeServices(compose.composeId);

  return {
    rows: joinContainers({
      appName: compose.appName,
      swarm: appType === "stack",
      declared: declared.data,
      members: members.data,
      listing: listing.data ?? undefined,
      tasks: tasks.data,
    }),
    /** The membership read is the one the table cannot do without. */
    isPending: members.isPending,
    error: members.error,
    isFetching: members.isFetching || listing.isFetching || tasks.isFetching,
    /** True when the image column has no source — a refusal, not an absence. */
    imagesUnavailable: listing.error !== null || listing.data === null,
    /**
     * Why it has none, in the operator's words. It used to be one
     * sentence blaming a permission, said to an owner who holds every one, when
     * Docker simply could not be reached.
     */
    imagesMissingBecause: listingProblem(listing.error, listing.data),
    refetch: () => {
      void members.refetch();
      void listing.refetch();
      void declared.refetch();
      if (appType === "stack") void tasks.refetch();
    },
  };
}

/**
 * Start, stop, restart or kill one container.
 *
 * All four invalidate the whole `docker` subtree, because all four change what
 * `docker ps` would answer and nothing else knows that. They do **not** touch the
 * stack row: `composeStatus` is written by a deploy, and a container someone
 * stopped by hand does not make the last Deployment less successful.
 */
export function useContainerActions() {
  const invalidate = useInvalidate();
  const done = () => invalidate.containers();

  return {
    start: useMutation({
      mutationFn: (input: { containerId: string; serverId: string | null }) =>
        dockerApi.start(input.containerId, input.serverId),
      onSettled: done,
    }),
    stop: useMutation({
      mutationFn: (input: { containerId: string; serverId: string | null }) =>
        dockerApi.stop(input.containerId, input.serverId),
      onSettled: done,
    }),
    restart: useMutation({
      mutationFn: (input: { containerId: string; serverId: string | null }) =>
        dockerApi.restart(input.containerId, input.serverId),
      onSettled: done,
    }),
    kill: useMutation({
      mutationFn: (input: { containerId: string; serverId: string | null }) =>
        dockerApi.kill(input.containerId, input.serverId),
      onSettled: done,
    }),
  };
}

/**
 * Why the whole-host listing gave the Image and Ports columns nothing, or `null`
 * when it did. Each answer names a different fix, so they are not one sentence.
 */
export function listingProblem(
  error: unknown,
  data: unknown[] | null | undefined,
): string | null {
  if (isUnreachableHost(error)) {
    return "Docker on this stack's Server could not be reached, so its container listing did not answer.";
  }
  if (error instanceof ApiError && error.isForbidden) {
    return "They come from the host's whole container listing, which needs docker read access — a permission this role does not hold.";
  }
  if (error) return `The host's container listing failed: ${errorMessage(error)}`;
  if (data === null) {
    return "Docker on this host would not list its containers, so they come back empty.";
  }
  return null;
}
