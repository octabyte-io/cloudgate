import { useFormContext, useWatch } from "react-hook-form";

import type { VolumeBackupValues } from "./volume-backups-spec";

/** What Keep the newest prunes for a backup of one volume. */
export const KEEP_TARBALLS_HINT =
  "Older tarballs under this prefix are deleted after each successful run. Empty keeps every one — safe, and the reason buckets grow without anyone noticing.";

const KEEP_MOMENTS_HINT =
  "Older backups under this prefix are deleted after each successful run, a whole stack's moment at a time. Empty keeps every one — safe, and the reason buckets grow without anyone noticing.";

/**
 * Keep the newest's hint on a Compose stack, by the **Back up** choice
 * rather than by the page (#171): a Stack backup prunes whole moments, and a
 * one-volume backup prunes single tarballs as an Application's does. A
 * `FieldSpec.hint` is a node rendered inside the form's `FormProvider`, so
 * it reads the one value it depends on (as `schedule-hints.tsx` does).
 */
export function KeepNewestHint() {
  const { control } = useFormContext<VolumeBackupValues>();
  const scope = useWatch({ control, name: "scope" });
  return <>{scope === "stack" ? KEEP_MOMENTS_HINT : KEEP_TARBALLS_HINT}</>;
}
