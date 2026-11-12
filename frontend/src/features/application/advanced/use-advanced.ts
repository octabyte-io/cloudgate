import { useMutation, useQuery } from "@tanstack/react-query";

import type { ServiceType } from "@/lib/api/endpoints/applications";
import {
  mountsApi,
  type CreateMountInput,
  type UpdateMountInput,
} from "@/lib/api/endpoints/mounts";
import {
  portsApi,
  redirectsApi,
  securityApi,
  type CreatePortInput,
  type CreateRedirectInput,
  type CreateSecurityInput,
  type UpdatePortInput,
  type UpdateRedirectInput,
  type UpdateSecurityInput,
} from "@/lib/api/endpoints/networking";
import {
  previewDeploymentsApi,
} from "@/lib/api/endpoints/preview-deployments";
import { rollbacksApi } from "@/lib/api/endpoints/rollbacks";
import {
  schedulesApi,
  type CreateScheduleInput,
  type UpdateScheduleInput,
} from "@/lib/api/endpoints/schedules";
import {
  findAppConfigPath,
  traefikApi,
} from "@/lib/api/endpoints/traefik";
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
 * Every read and write F10's six tabs make, other than patches (which have a
 * repository behind them and get their own module).
 *
 * All of it hangs off **one Application id**, because every one of these
 * controllers scopes its list by the owning service — there is no
 * organization-wide list of mounts, schedules, rollbacks or previews, and no
 * screen in this app wants one.
 *
 * **All seven are here now.** Ports, redirects and security were the three that
 * were not: they had no list route, so there was nothing to key a query on and the
 * typed writes in `endpoints/networking.ts` sat unused. Each controller gained
 * `GET /?applicationId=`, so they are three ordinary by-owner reads like the
 * four above them, and the Advanced tab's three stated absences are three
 * tables.
 */

/** Slow enough not to be a load, fast enough that a rollback is seen landing. */
const LIVE_POLL_MS = 4_000;

// ── Mounts ─────────────────────────────────────────────────────────────────

export function useMounts(applicationId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.mounts.byService(organizationId, applicationId),
    queryFn: () => mountsApi.listByService(applicationId, "application"),
    enabled: organizationId !== null && applicationId !== "",
  });
}

export function useMountMutations(applicationId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate.mounts(applicationId);

  return {
    create: useMutation({
      mutationFn: (input: CreateMountInput) => mountsApi.create(input),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (args: { mountId: string; input: UpdateMountInput }) =>
        mountsApi.update(args.mountId, args.input),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (mountId: string) => mountsApi.remove(mountId),
      onSuccess: done,
    }),
  };
}

// ── Ports, redirects and basic auth ────────────────────────────────────────
//
// The three that had no list route at first. One `useNetworking` rather than
// three hooks and three mutation bundles: the Advanced tab reads and writes all
// three in one screen, they invalidate together (`invalidate.networking`), and
// three near-identical exports is how the fourth one drifts.

export function useNetworking(applicationId: string) {
  const { organizationId } = useActiveOrganizationId();
  const enabled = organizationId !== null && applicationId !== "";

  return {
    ports: useQuery({
      queryKey: keys.ports.byApplication(organizationId, applicationId),
      queryFn: () => portsApi.list(applicationId),
      enabled,
    }),
    redirects: useQuery({
      queryKey: keys.redirects.byApplication(organizationId, applicationId),
      queryFn: () => redirectsApi.list(applicationId),
      enabled,
    }),
    security: useQuery({
      queryKey: keys.security.byApplication(organizationId, applicationId),
      queryFn: () => securityApi.list(applicationId),
      enabled,
    }),
  };
}

export function useNetworkingMutations(applicationId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate.networking(applicationId);
  // A redirect or a basic-auth user is emitted into the Application's Traefik
  // file, so saving one rewrites it; a published port is a Swarm setting and
  // does not.
  const rewritten = () =>
    Promise.all([done(), invalidate.traefikConfig(applicationId)]);

  return {
    ports: {
      create: useMutation({
        mutationFn: (input: CreatePortInput) => portsApi.create(input),
        onSuccess: done,
      }),
      update: useMutation({
        mutationFn: (args: { portId: string; input: UpdatePortInput }) =>
          portsApi.update(args.portId, args.input),
        onSuccess: done,
      }),
      remove: useMutation({
        mutationFn: (portId: string) => portsApi.remove(portId),
        onSuccess: done,
      }),
    },
    redirects: {
      create: useMutation({
        mutationFn: (input: CreateRedirectInput) => redirectsApi.create(input),
        onSuccess: rewritten,
      }),
      update: useMutation({
        mutationFn: (args: { redirectId: string; input: UpdateRedirectInput }) =>
          redirectsApi.update(args.redirectId, args.input),
        onSuccess: rewritten,
      }),
      remove: useMutation({
        mutationFn: (redirectId: string) => redirectsApi.remove(redirectId),
        onSuccess: rewritten,
      }),
    },
    security: {
      create: useMutation({
        mutationFn: (input: CreateSecurityInput) => securityApi.create(input),
        onSuccess: rewritten,
      }),
      update: useMutation({
        mutationFn: (args: { securityId: string; input: UpdateSecurityInput }) =>
          securityApi.update(args.securityId, args.input),
        onSuccess: rewritten,
      }),
      remove: useMutation({
        mutationFn: (securityId: string) => securityApi.remove(securityId),
        onSuccess: rewritten,
      }),
    },
  };
}

// ── Rollbacks ──────────────────────────────────────────────────────────────

export function useRollbacks(applicationId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.rollbacks.byApplication(organizationId, applicationId),
    queryFn: () => rollbacksApi.listByApplication(applicationId),
    enabled: organizationId !== null && applicationId !== "",
  });
}

export function useRollbackMutations(applicationId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate.rollbacks(applicationId);

  return {
    rollback: useMutation({
      mutationFn: (rollbackId: string) => rollbacksApi.rollback(rollbackId),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (rollbackId: string) => rollbacksApi.remove(rollbackId),
      onSuccess: done,
    }),
  };
}

// ── Preview deployments ────────────────────────────────────────────────────

/**
 * Polls while any preview is building, and stops when none is — the same
 * decision-from-each-answer shape `useApplicationDeployments` uses, and for the
 * same reason: `previewStatus` is a column the engine writes and nothing pushes
 * it. An expired Requested preview polls too: the sweep removes its row
 * once its copy is gone, and the list should say so when it does.
 */
export function usePreviewDeployments(applicationId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.previewDeployments.byApplication(
      organizationId,
      applicationId,
    ),
    queryFn: () => previewDeploymentsApi.listByApplication(applicationId),
    enabled: organizationId !== null && applicationId !== "",
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (row) => row.previewStatus === "running" || row.expiredAt !== null,
      )
        ? LIVE_POLL_MS
        : false,
  });
}

export function usePreviewMutations(applicationId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate.previewDeployments(applicationId);

  return {
    redeploy: useMutation({
      mutationFn: (id: string) => previewDeploymentsApi.redeploy(id),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => previewDeploymentsApi.remove(id),
      onSuccess: done,
    }),
    /** A Requested preview's new window, from now. */
    extend: useMutation({
      mutationFn: ({ id, ttlMinutes }: { id: string; ttlMinutes: number }) =>
        previewDeploymentsApi.extend(id, ttlMinutes),
      onSuccess: done,
    }),
  };
}

// ── Schedules ──────────────────────────────────────────────────────────────

export function useSchedules(applicationId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.schedules.byService(organizationId, applicationId),
    queryFn: () => schedulesApi.listByService(applicationId, "application"),
    enabled: organizationId !== null && applicationId !== "",
  });
}

/**
 * One schedule's runs, newest first.
 *
 * Keyed under the schedule rather than the Application, because that is what the
 * route takes — and `invalidate.schedules(applicationId)` drops the whole
 * `schedules` subtree, so pressing **Run now** refreshes the history under it.
 *
 * **Polls while a run is live**, and stops when none is: the same
 * decision-from-each-answer shape `usePreviewDeployments` above uses. A schedule
 * run's status is a column `BackupRunRecorderService` writes and nothing pushes.
 *
 * `scheduleId` is `null` when nothing is expanded, which is the whole point — a
 * list of eight schedules must not be eight run-history requests before anyone has
 * opened one.
 */
export function useScheduleRuns(scheduleId: string | null) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: [
      ...keys.schedules.all(organizationId),
      scheduleId ?? "",
      "runs",
    ] as const,
    queryFn: () => schedulesApi.runHistory(scheduleId as string),
    enabled: organizationId !== null && scheduleId !== null,
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (row) => row.status === "pending" || row.status === "running",
      )
        ? LIVE_POLL_MS
        : false,
  });
}

export function useScheduleMutations(applicationId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate.schedules(applicationId);

  return {
    create: useMutation({
      mutationFn: (input: CreateScheduleInput) => schedulesApi.create(input),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (args: { scheduleId: string; input: UpdateScheduleInput }) =>
        schedulesApi.update(args.scheduleId, args.input),
      onSuccess: done,
    }),
    run: useMutation({ mutationFn: (id: string) => schedulesApi.run(id) }),
    remove: useMutation({
      mutationFn: (id: string) => schedulesApi.remove(id),
      onSuccess: done,
    }),
  };
}

// ── Volume backups ─────────────────────────────────────────────────────────

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

/**
 * Where a backup is written. **Moved to `lib/api/use-destinations.ts` by F11**,
 * which is the second phase to pick from this list. Re-exported so this module
 * stays the one import point for everything F10's tabs read.
 */
export { useDestinations } from "@/lib/api/use-destinations";

/**
 * Which host a build runs on. **Moved to `lib/api/use-servers.ts` by F11**,
 * which is the second phase to pick from this list — creating a database asks
 * the same question. Re-exported so this stays the one import point.
 */
export { useServers } from "@/lib/api/use-servers";

// ── Traefik ────────────────────────────────────────────────────────────────

/**
 * This Application's generated Traefik config, in two steps.
 *
 * The directory walk comes first because **it is what knows the path** — the
 * Traefik directory is a backend constant and constructing it here would put a
 * server filesystem layout in the browser (`endpoints/traefik.ts` explains).
 * A file that is not in the tree has no path, and that is also the honest answer
 * to "does this Application have a Traefik config yet": it does not until it has
 * a domain, because `traefik/app-config.service.ts` removes the file when the
 * last one goes.
 *
 * Neither read is refetched in the background: both reach a **host**, over SSH
 * when the Application is on a remote Server.
 */
export function useApplicationTraefikConfig(
  appName: string | undefined,
  serverId: string | null,
) {
  const { organizationId } = useActiveOrganizationId();

  const tree = useQuery({
    queryKey: keys.traefik.directories(organizationId, serverId),
    queryFn: () => traefikApi.directories(serverId),
    enabled: organizationId !== null && Boolean(appName),
    refetchOnWindowFocus: false,
  });

  const path = tree.data && appName ? findAppConfigPath(tree.data, appName) : null;

  const file = useQuery({
    queryKey: keys.traefik.file(organizationId, serverId, path ?? ""),
    queryFn: () => traefikApi.readFile(path as string, serverId),
    enabled: organizationId !== null && path !== null,
    refetchOnWindowFocus: false,
  });

  return {
    path,
    /** `null` once the tree has landed and holds no file for this Application. */
    content: file.data ?? null,
    isPending: tree.isPending || (path !== null && file.isPending),
    error: tree.error ?? file.error,
    refetch: () => {
      void tree.refetch();
      void file.refetch();
    },
  };
}
