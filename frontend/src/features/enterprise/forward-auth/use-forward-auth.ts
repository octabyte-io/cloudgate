import { useMutation, useQuery } from "@tanstack/react-query";

import {
  forwardAuthApi,
  type SetAuthDomainInput,
} from "@/lib/api/endpoints/forward-auth";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The forward-auth proxy, per Traefik instance — and the per-domain gate, which
 * is a different feature under the same controller.
 *
 * **Two gates, two sets of hooks, and they must not be mixed.** The server-level
 * reads run `ensureEnterprise` and belong inside `LicenseGate`. The per-domain
 * ones ride the `domain` permission instead, are reached from an Application's
 * own screen, and are used by a component F09's domains panel imports — so they
 * must work on an unlicensed instance, where they answer a `412` naming what to
 * do rather than a 403 about a licence.
 */

export function useForwardAuthTargets() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.forwardAuth.targets(organizationId),
    queryFn: forwardAuthApi.targets,
    enabled: organizationId !== null,
  });
}

export function useForwardAuthProviders() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.forwardAuth.providers(organizationId),
    queryFn: forwardAuthApi.providers,
    enabled: organizationId !== null,
  });
}

export function useSetAuthDomain() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: SetAuthDomainInput) => forwardAuthApi.setSettings(input),
    onSuccess: () => invalidate.forwardAuth(),
  });
}

export function useRemoveAuthDomain() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (serverId: string | null) =>
      forwardAuthApi.removeSettings(serverId),
    onSuccess: () => invalidate.forwardAuth(),
  });
}

export function useDeployProxy() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { serverId: string | null; providerId: string }) =>
      forwardAuthApi.deployProxy(input.serverId, input.providerId),
    onSuccess: () => invalidate.forwardAuth(),
  });
}

export function useRemoveProxy() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (serverId: string | null) =>
      forwardAuthApi.removeProxy(serverId),
    onSuccess: () => invalidate.forwardAuth(),
  });
}

/**
 * Whether one domain is gated. **Not licensed** — see above.
 *
 * `enabled` is the caller's, because this is imported into a panel that renders
 * for Compose domains too, and `findApplicationDomain` refuses those with a 400
 * ("SSO forward-auth is currently only supported on application domains").
 * Asking anyway would put a refusal in the cache for a control that should not
 * be on screen at all.
 */
export function useDomainGate(domainId: string, enabled: boolean) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.forwardAuth.domain(organizationId, domainId),
    queryFn: () => forwardAuthApi.domainStatus(domainId),
    enabled: enabled && organizationId !== null,
    /**
     * A 403 here is about the `domain` permission and a 404 about the id;
     * neither improves on a retry, and this hook renders once per row on a
     * domains table.
     */
    retry: false,
  });
}

export function useSetDomainGate(domainId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      enabled
        ? forwardAuthApi.enableOnDomain(domainId)
        : forwardAuthApi.disableOnDomain(domainId),
    onSuccess: () => invalidate.forwardAuthDomain(domainId),
  });
}
