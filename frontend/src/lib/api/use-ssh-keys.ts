import { useQuery } from "@tanstack/react-query";

import { useActiveOrganizationId } from "@/lib/auth/client";

import { sshKeysApi } from "./endpoints/ssh-keys";
import { keys } from "./keys";

/**
 * The Organization's SSH keys.
 *
 * Written by F09 for one control — which key clones a custom git source — and
 * **moved here by F13**, which is the second and third feature to need it: the
 * add-a-Server dialog picks one, and every Server's Access tab names the one it
 * uses. `use-servers.ts` and `use-destinations.ts` are here for exactly the same
 * reason and F11 put them here for exactly the same argument: a list every feature
 * picks from belongs to none of them.
 *
 * F13 owns the screens that *manage* keys (`features/ssh-keys/`); this is the read,
 * and `use-application.ts` re-exports it so F09's call site did not change.
 */
export function useSshKeys(enabled = true) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.sshKeys.list(organizationId),
    queryFn: () => sshKeysApi.list(),
    enabled: enabled && organizationId !== null,
  });
}
