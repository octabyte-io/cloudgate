import { useInstanceMode } from "@/lib/api/use-instance-mode";

import { LICENSED_FEATURES, type LicensedFeatureId } from "./licensed-features";
import { useLicenseStatus } from "./use-license";

/**
 * **Whether one or more registry features are unlocked here**, and whether
 * this is the Hosted instance (ADR-0048) — what every gate asks instead
 * of reading `licensed` itself.
 *
 * Self-hosted, it is `GET /license/status`'s `licensed`, as before. On the
 * Hosted instance the install-wide features (branding, the two limits) are
 * Octabyte's and always on; the paid features are still `licensed`, which the
 * backend answers from the Enterprise marker there.
 *
 * The mode only ever *unlocks*: while it is unknown the answer is the status
 * read's, so a gate never waits on it. `licensed` is `undefined` while the
 * status read is in flight or has failed — not a fact about the Organization.
 */
export function useFeatureLicensed(
  feature: LicensedFeatureId | readonly LicensedFeatureId[],
) {
  const mode = useInstanceMode();
  const status = useLicenseStatus();
  const hosted = mode.data === "hosted";
  const ids: readonly LicensedFeatureId[] =
    typeof feature === "string" ? [feature] : feature;
  if (hosted && ids.every((id) => LICENSED_FEATURES[id].instanceWide)) {
    return { hosted, isPending: false, error: null, licensed: true } as const;
  }
  return {
    hosted,
    isPending: status.isPending,
    error: status.error,
    licensed: status.data?.licensed,
  };
}
