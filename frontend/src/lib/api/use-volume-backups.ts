import { useMutation, useQuery } from "@tanstack/react-query";

import type { ServiceType } from "@/lib/api/endpoints/applications";
import {
  volumeBackupsApi,
  type CreateVolumeBackupInput,
  type RestoreVolumeBackupInput,
  type UpdateVolumeBackupInput,
} from "@/lib/api/endpoints/volume-backups";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * A Service's volume backups: the list, one backup's runs, and the writes.
 * **Moved out of `features/application/advanced/use-advanced.ts`** once a
 * Server bucket and a Compose stack read them too — the promotion rule
 * (CODING_STANDARDS §1.4): what a second feature imports leaves `features/`.
 */

/** Slow enough not to be a load, fast enough that a run is seen landing —
 * `use-advanced.ts`'s own figure. */
const LIVE_POLL_MS = 4_000;

export function useVolumeBackups(
  serviceId: string,
  serviceType: ServiceType = "application",
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.volumeBackups.byService(organizationId, serviceId),
    queryFn: () => volumeBackupsApi.listByService(serviceId, serviceType),
    enabled: organizationId !== null && serviceId !== "",
  });
}

/**
 * One volume backup's runs, newest first. `useScheduleRuns`' twin, and the
 * reasoning is the same line for line.
 *
 * **This is the read that turns a silently failing backup into a visible one.** A
 * tar that has been failing for a fortnight looked exactly like one that had been
 * working, until a restore went looking for a tarball that was never written.
 */
export function useVolumeBackupRuns(volumeBackupId: string | null) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: [
      ...keys.volumeBackups.all(organizationId),
      volumeBackupId ?? "",
      "runs",
    ] as const,
    queryFn: () => volumeBackupsApi.runHistory(volumeBackupId as string),
    enabled: organizationId !== null && volumeBackupId !== null,
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (row) => row.status === "pending" || row.status === "running",
      )
        ? LIVE_POLL_MS
        : false,
  });
}

export function useVolumeBackupMutations(serviceId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate.volumeBackups(serviceId);

  return {
    create: useMutation({
      mutationFn: (input: CreateVolumeBackupInput) =>
        volumeBackupsApi.create(input),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (args: {
        volumeBackupId: string;
        input: UpdateVolumeBackupInput;
      }) => volumeBackupsApi.update(args.volumeBackupId, args.input),
      onSuccess: done,
    }),
    run: useMutation({ mutationFn: (id: string) => volumeBackupsApi.run(id) }),
    restore: useMutation({
      mutationFn: (input: RestoreVolumeBackupInput) =>
        volumeBackupsApi.restore(input),
    }),
    remove: useMutation({
      mutationFn: (id: string) => volumeBackupsApi.remove(id),
      onSuccess: done,
    }),
  };
}
