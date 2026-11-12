import { useMutation, useQuery } from "@tanstack/react-query";

import {
  dockerApi,
  type SwarmNode,
  type SwarmService,
} from "@/lib/api/endpoints/docker";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * What Docker says about one host: its containers, its Swarm, its cluster.
 *
 * Every read here is `?serverId=`-scoped, and **`undefined` is not `[]`**. That
 * distinction is the load-bearing part of this module and it comes from the backend's
 * own shape: `getContainers`, `getSwarmNodes` and `getNodeApplications` each return
 * *nothing* when docker wrote to stderr and an empty array when docker answered and
 * there was nothing to list. Reading the first as the second is how a screen ends up
 * telling somebody their host is empty because they asked a worker to enumerate a
 * Swarm.
 *
 * TanStack refuses `undefined` as query data, so every one of these maps it to
 * `null` — F12's third defect, which would otherwise be reported in the console as
 * our bug rather than as docker's silence. `null` means *docker would not say*; `[]`
 * means *there are none*.
 *
 * **And there is a third answer, which is the one that was missing** (X11-4). A
 * Server the SSH connection never reached was folded into `[]` by the backend, so
 * every card here rendered its empty state for a machine nothing had been read from
 * — the Containers card said *"Docker answered"*, the Swarm nodes card said the
 * cluster was fine and this was a worker. It is a 503 carrying `HOST_UNREACHABLE`
 * — the Server arm; the platform host has its own
 * `PLATFORM_HOST_UNREACHABLE`, which these three queries cannot see, since each
 * takes a non-null `serverId` off a Server row —
 * now, so it arrives on `error` rather than on `data`, and each card branches on
 * `isUnreachableHost` ahead of everything else.
 *
 * **The three cards no longer carry `retry: false` for that, and the deletion is
 * the point.**
 * They had it so an unreachable Server cost one SSH attempt rather than the
 * three a 5xx is retried for — correct, and written out by hand three times,
 * which is why the next three docker queries to be written
 * (`useStackContainers`) inherited the retries instead. The stop is now in
 * `retryUnlessTheAnswerWillNotChange`, where every docker query reaches it
 * without knowing to. `useContainerConfig` keeps its override, because it was
 * never the unreachable Server it was standing in front of: `getConfig`
 * swallows docker's every complaint into `undefined`, so the only thing left to
 * fail is the refusal `ContainerAccessService.resolveTarget` answers, and a
 * viewer somebody has open is not the place to spend two more attempts on it.
 */

/**
 * Every container on the host, with its image and its ports.
 *
 * **The whole listing, not a filtered one.** This is a Server's tab, so the question
 * is "what is running on this machine" rather than "what belongs to this service" —
 * and it is the only route that carries an image and a port map at all. The
 * platform's own `cloudgate*` containers are filtered out by the backend, so Traefik
 * does not appear here even though setup started it.
 */
export function useServerContainers(serverId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.docker.containers(organizationId, serverId),
    queryFn: () => dockerApi.containers(serverId),
    enabled: organizationId !== null && serverId !== "",
    // Reaching a host over SSH to run `docker ps` is not something to do on a
    // window focus. It is a button on the card.
    refetchOnWindowFocus: false,
  });
}

/**
 * `docker node ls`.
 *
 * **`null` here is usually a worker, not a failure.** `docker node ls` is
 * manager-only, so a Server that joined a Swarm as a worker answers on stderr and the
 * route returns nothing. That is a fact worth rendering as itself.
 */
export function useSwarmNodes(serverId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.docker.swarmNodes(organizationId, serverId),
    queryFn: async (): Promise<SwarmNode[] | null> =>
      (await dockerApi.swarmNodes(serverId)) ?? null,
    enabled: organizationId !== null && serverId !== "",
    refetchOnWindowFocus: false,
  });
}

/**
 * `docker service ls` — what Docker is running here.
 *
 * **This is not the list of what an Environment holds** — that one exists, on
 * `GET /environments/:id`,
 * and this is a different question — so no screen should present it as one: it cannot
 * say which Project or Environment a service belongs to, and anything deployed as a
 * plain container rather than a Swarm service is absent.
 * What it can do is name what is running on a machine somebody is about to delete,
 * which is the one question that has to be answered honestly.
 */
export function useSwarmServices(serverId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.docker.swarmServices(organizationId, serverId),
    queryFn: async (): Promise<SwarmService[] | null> =>
      (await dockerApi.swarmServices(serverId)) ?? null,
    enabled: organizationId !== null && serverId !== "",
    refetchOnWindowFocus: false,
  });
}

/**
 * One container's `docker inspect` document.
 *
 * Fetched only while its viewer is open, because it is a forty-key document nobody
 * reads unless they have gone looking for it. `getConfig` swallows **every** failure
 * into `undefined`, so an unknown container and an unhappy docker are the same answer
 * — which is why the viewer says the inspection came back empty rather than guessing
 * which.
 */
export function useContainerConfig(
  serverId: string,
  containerId: string | null,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.docker.config(organizationId, serverId, containerId ?? ""),
    queryFn: async () =>
      (await dockerApi.config(containerId as string, serverId)) ?? null,
    enabled: organizationId !== null && containerId !== null,
    retry: false,
  });
}

/**
 * The five verbs.
 *
 * `containers()` is what they invalidate — the whole `docker` subtree — because every
 * one of them changes what `docker ps` would answer, and a stopped container that
 * still reads `running` in the table is worse than a slow refetch.
 */
export function useContainerActions(serverId: string) {
  const invalidate = useInvalidate();
  const settle = { onSettled: () => invalidate.containers() };

  return {
    start: useMutation({
      mutationFn: (containerId: string) =>
        dockerApi.start(containerId, serverId),
      ...settle,
    }),
    stop: useMutation({
      mutationFn: (containerId: string) =>
        dockerApi.stop(containerId, serverId),
      ...settle,
    }),
    restart: useMutation({
      mutationFn: (containerId: string) =>
        dockerApi.restart(containerId, serverId),
      ...settle,
    }),
    kill: useMutation({
      mutationFn: (containerId: string) =>
        dockerApi.kill(containerId, serverId),
      ...settle,
    }),
    remove: useMutation({
      mutationFn: (containerId: string) =>
        dockerApi.remove(containerId, serverId),
      ...settle,
    }),
  };
}

/**
 * The join command for a new worker or manager.
 *
 * **A mutation, and not because it changes anything** — it is a `GET` and it performs
 * no join. It is a mutation because it mints a live Swarm join token, and a query
 * would cache a credential under a key a background refetch could reach and put it on
 * screen for whoever is standing there. Somebody asks; it answers once.
 */
export function useJoinCommand(serverId: string) {
  return useMutation({
    mutationFn: (role: "worker" | "manager") =>
      dockerApi.joinCommand(role, serverId),
  });
}

/** Drain, then force-remove. Both the Swarm's nodes and the host's containers move. */
export function useRemoveNode(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (nodeId: string) => dockerApi.removeNode(nodeId, serverId),
    onSettled: () => invalidate.containers(),
  });
}
