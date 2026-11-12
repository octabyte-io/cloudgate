import { useQuery } from "@tanstack/react-query";

import { aiApi } from "@/lib/api/endpoints/ai";
import {
  gitProvidersApi,
  type GitConnection,
  type GitProvider,
  type GitProviderKind,
} from "@/lib/api/endpoints/git-providers";
import { notificationsApi } from "@/lib/api/endpoints/notifications";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The lists this phase manages that nothing else reads, each one query.
 *
 * **Registries and destinations are not here.** Both already had a hook in
 * `lib/api/` — every service's configuration form picks from them — and a second
 * copy keyed the same way would be two things that can disagree about when to
 * refetch. `useRegistries` moved there in this phase; `useDestinations` moved
 * there in F11.
 *
 * All of these are org-scoped and `enabled` only once there *is* an active
 * Organization — `organizationId` is null while the session loads, and a query
 * keyed on null must not run (`keys.ts`). Without that guard every one of these
 * screens would spend its first paint claiming the Organization has nothing,
 * which is F07's confident-zero defect and F14 found it again.
 */

export { useRegistries } from "@/lib/api/use-registries";
export { useDestinations } from "@/lib/api/use-destinations";

export function useNotifications() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.notifications.list(organizationId),
    queryFn: () => notificationsApi.list(),
    enabled: organizationId !== null,
  });
}

/**
 * `GET /ai` is **owner/admin only** — `AiService.ensureOwnerOrAdmin` throws a
 * 403 for every other role. That refusal is rendered as a refusal rather than as
 * an empty list, which is F09's first defect and the easiest lie a screen in
 * this phase could tell.
 */
export function useAiProviders() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.ai.list(organizationId),
    queryFn: () => aiApi.list(),
    enabled: organizationId !== null,
  });
}

/**
 * One provider kind's connections.
 *
 * Four separate queries rather than one, because the backend has four
 * controllers and no combined read — `GET /git-providers` answers the *base*
 * rows only, which carry a name and a type and none of the credentials or the
 * host that say whether a connection can actually clone anything.
 */
/**
 * **Every** connection, base rows only.
 *
 * Comparing this with the four per-kind lists is the only way to name a base
 * row that no strategy listing returns. That used to be the routine outcome of
 * saving a connection without its provider's credentials; now
 * the listings are unfiltered, so a difference between the two answers now
 * means the base and strategy tables disagree. Rarer, and worth naming when it
 * happens — see `unlisted-connections.tsx`.
 */
export function useGitProviders() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery<GitProvider[]>({
    queryKey: keys.gitProviders.list(organizationId),
    queryFn: () => gitProvidersApi.list(),
    enabled: organizationId !== null,
  });
}

export function useGitConnections(kind: GitProviderKind) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery<GitConnection[]>({
    queryKey: keys.gitProviders.connections(organizationId, kind),
    queryFn: () => gitProvidersApi.connections(kind),
    enabled: organizationId !== null,
  });
}
