import { useQuery } from "@tanstack/react-query";

import { useActiveOrganizationId } from "@/lib/auth/client";

import { serversApi } from "./endpoints/servers";
import { keys } from "./keys";

/**
 * The Organization's Servers.
 *
 * Built by F10 for the Advanced tab's build-server picker and moved here by
 * F11, which is the second phase to need it: creating a database asks which host
 * it lands on. **F13 owns the fleet screens**; this is the read, alongside
 * `use-destinations.ts` and for the same reason — a list every feature picks
 * from belongs to none of them.
 */
export function useServers() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.servers.list(organizationId),
    queryFn: () => serversApi.list(),
    enabled: organizationId !== null,
  });
}
