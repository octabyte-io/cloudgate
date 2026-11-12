import { useMutation, useQuery } from "@tanstack/react-query";

import { scimApi } from "@/lib/api/endpoints/scim";
import {
  enforceSso,
  ssoApi,
  type SsoProviderInput,
} from "@/lib/api/endpoints/sso";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The identity providers this Organization signs in through, and the directory
 * that provisions its members.
 *
 * Every read here except `useEnforceSso` is licensed, so all of them sit under a
 * `LicenseGate` and none is ever fired on an unlicensed instance — a 403 saying
 * "Valid enterprise license required" would otherwise reach F02's status rules
 * and be rendered as a sentence about the reader's role.
 */

export function useSsoProviders() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.sso.providers(organizationId),
    queryFn: ssoApi.list,
    enabled: organizationId !== null,
  });
}

/**
 * The redirect URI template, with `{providerId}` still in it — the Add dialog
 * needs it before a provider exists, so it is fetched per Organization rather
 * than carried on a provider row. It changes only when `BETTER_AUTH_URL` does.
 */
export function useSsoRedirectUri() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.sso.redirectUri(organizationId),
    queryFn: ssoApi.redirectUri,
    enabled: organizationId !== null,
    staleTime: Infinity,
  });
}

export function useTrustedOrigins() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.sso.trustedOrigins(organizationId),
    queryFn: ssoApi.trustedOrigins,
    enabled: organizationId !== null,
  });
}

/**
 * Whether SSO is the only way in.
 *
 * **Instance-wide and public**, not the Organization's: `enforceSso` reads one
 * `web_server_settings` row and the route is `@Public()`. So it is keyed under
 * `instance`, and turning it on affects every Organization on this deployment —
 * which is the single most important thing the toggle has to say.
 */
export function useEnforceSso() {
  return useQuery({
    queryKey: keys.ssoEnforce(),
    queryFn: () => enforceSso(),
  });
}

export function useSetEnforceSso() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (enforced: boolean) => ssoApi.setEnforce(enforced),
    onSuccess: () => invalidate.ssoEnforce(),
  });
}

export function useSaveSsoProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { existing: boolean; values: SsoProviderInput }) =>
      input.existing
        ? ssoApi.update(input.values.providerId, input.values)
        : ssoApi.register(input.values),
    onSuccess: () => invalidate.sso(),
  });
}

export function useRemoveSsoProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (providerId: string) => ssoApi.remove(providerId),
    onSuccess: () => invalidate.sso(),
  });
}

export function useAddTrustedOrigin() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (origin: string) => ssoApi.addTrustedOrigin(origin),
    onSuccess: () => invalidate.sso(),
  });
}

export function useRemoveTrustedOrigin() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (origin: string) => ssoApi.removeTrustedOrigin(origin),
    onSuccess: () => invalidate.sso(),
  });
}

/**
 * This Organization's Proven domains. Hosted only: the caller passes
 * `enabled` from the instance mode, since a Self-hosted backend has no route.
 */
export function useProvenDomains({ enabled }: { enabled: boolean }) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.sso.provenDomains(organizationId),
    queryFn: ssoApi.provenDomains,
    enabled: enabled && organizationId !== null,
  });
}

export function useAddProvenDomain() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (domain: string) => ssoApi.addProvenDomain(domain),
    onSuccess: () => invalidate.sso(),
  });
}

export function useCheckProvenDomain() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (domain: string) => ssoApi.checkProvenDomain(domain),
    onSuccess: () => invalidate.sso(),
  });
}

export function useRemoveProvenDomain() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (domain: string) => ssoApi.removeProvenDomain(domain),
    onSuccess: () => invalidate.sso(),
  });
}

export function useScimProviders() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.scim.providers(organizationId),
    queryFn: scimApi.list,
    enabled: organizationId !== null,
  });
}

export function useCreateScimProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (providerId: string) => scimApi.create(providerId),
    onSuccess: () => invalidate.scim(),
  });
}

export function useRemoveScimProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (providerId: string) => scimApi.remove(providerId),
    onSuccess: () => invalidate.scim(),
  });
}
