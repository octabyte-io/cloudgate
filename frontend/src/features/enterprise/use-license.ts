import { useMutation, useQuery } from "@tanstack/react-query";

import { licenseApi } from "@/lib/api/endpoints/license";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * Whether this Organization's enterprise features are unlocked, and the two
 * things that decide it.
 *
 * **`useLicenseStatus` is read by every enterprise section**, through
 * `LicenseGate`. It is deliberately one query key with many subscribers rather
 * than a read per section: TanStack dedupes them into a single request, and the
 * moment `invalidate.license()` runs, all five screens change together instead
 * of one of them disagreeing with the other four.
 *
 * `staleTime` is 30 seconds and not `Infinity`. A licence is not a constant of
 * the build the way `statements` is — it lapses on its own (`validUntil` is
 * compared to now at read time, so nothing writes to the row when it does) and
 * an owner in another tab can deactivate it. Thirty seconds is long enough that
 * moving between the five sections costs one request, and short enough that a
 * lapse does not sit on screen for a working day.
 */
export function useLicenseStatus({ enabled = true } = {}) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.license.status(organizationId),
    queryFn: licenseApi.status,
    // `enabled: false` is the renewal bar on the Hosted instance and for a
    // member, who never see it and so never ask.
    enabled: enabled && organizationId !== null,
    staleTime: 30_000,
  });
}

/**
 * `GET /license/settings` — **owner only**, unlike everything else here.
 *
 * An admin gets a 403 with "You are not authorized to get enterprise settings",
 * which the screen renders as what it is. It is not wrapped in anything that
 * would turn it into an empty form: the settings genuinely exist, this person
 * just cannot read them.
 */
export function useEnterpriseSettings({ enabled = true } = {}) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.license.settings(organizationId),
    queryFn: licenseApi.settings,
    // Off on the Hosted instance, which has no license key to read.
    enabled: enabled && organizationId !== null,
    /**
     * A 403 here is a fact about the caller's role, not a transient failure —
     * retrying it three times is three identical refusals and a slower screen.
     */
    retry: false,
  });
}

export function useSetEnterpriseFeatures() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (enabled: boolean) => licenseApi.setEnterpriseFeatures(enabled),
    onSuccess: () => invalidate.license(),
  });
}

export function useActivateLicense() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (licenseKey: string) => licenseApi.activate(licenseKey),
    onSuccess: () => invalidate.license(),
  });
}

/**
 * Re-ask the licence server about the stored key.
 *
 * **This can turn the licence off**, which is worth knowing at the call site:
 * `validate` honours a `false` and marks the row `invalid`, because nothing else
 * revalidates a key and a revoked one would otherwise stay enabled — correct, and
 * the reason the button confirms first.
 */
export function useValidateLicense() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => licenseApi.validate(),
    onSuccess: () => invalidate.license(),
  });
}

/**
 * "I've renewed, check now": re-activates the stored key. Safe to
 * press early — a refusal leaves the licence as it was.
 */
export function useCheckLicenseNow() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => licenseApi.checkNow(),
    onSuccess: () => invalidate.license(),
  });
}

export function useDeactivateLicense() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => licenseApi.deactivate(),
    onSuccess: () => invalidate.license(),
  });
}
