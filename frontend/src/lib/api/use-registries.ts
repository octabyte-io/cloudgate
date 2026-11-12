import { useQuery } from "@tanstack/react-query";

import { useActiveOrganizationId } from "@/lib/auth/client";

import { registriesApi } from "./endpoints/registries";
import { keys } from "./keys";

/**
 * Where a build pushes its image — the Organization's container registries.
 *
 * Built by F09 inside `features/application/use-application.ts` and **moved here
 * by F15**, which is the second feature to want it: F09's Build card picks one
 * and F15's Registries screen manages them. Same move `useDestinations`,
 * `useServers`, `useSshKeys` and `useServerMetrics` have each already made, for
 * the same reason — a list every feature picks from belongs to none of them.
 * Re-exported from the old path, so F09's call site did not change.
 */
export function useRegistries() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.registries.list(organizationId),
    queryFn: () => registriesApi.list(),
    enabled: organizationId !== null,
  });
}
