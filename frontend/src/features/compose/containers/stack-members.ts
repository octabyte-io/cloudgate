import { useQuery } from "@tanstack/react-query";

import {
  dockerApi,
  type ContainerAppType,
  type ContainerMatch,
} from "@/lib/api/endpoints/docker";
import type { Compose } from "@/lib/api/endpoints/compose";
import { keys, type OrganizationScope } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

type MemberOf = Pick<Compose, "appName" | "serverId" | "composeType">;

const appTypeOf = (stack: Pick<Compose, "composeType">): ContainerAppType =>
  stack.composeType === "stack" ? "stack" : "docker-compose";

/**
 * The key of a stack's container membership, `docker ps` narrowed to its
 * project. One key for its three readers: the Containers tab's table, the
 * action row's "is anything left to stop or remove", and Remove containers'
 * own answer, which writes `[]` here the moment the removal succeeds.
 */
export function stackMembersKey(
  organizationId: OrganizationScope,
  stack: MemberOf,
) {
  return keys.docker.byApp(
    organizationId,
    stack.serverId,
    stack.appName,
    appTypeOf(stack),
  );
}

/** Which containers Docker has under this stack's name, on its deploy target. */
export function useStackMembers(
  stack: MemberOf,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery<ContainerMatch[]>({
    queryKey: stackMembersKey(organizationId, stack),
    queryFn: () =>
      dockerApi.containersByApp({
        appName: stack.appName,
        appType: appTypeOf(stack),
        serverId: stack.serverId,
      }),
    enabled:
      (options.enabled ?? true) &&
      organizationId !== null &&
      stack.appName !== "",
    refetchInterval: options.refetchInterval ?? false,
  });
}
