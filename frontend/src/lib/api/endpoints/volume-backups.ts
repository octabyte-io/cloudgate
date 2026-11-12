import { api } from "../client";

import type { ServiceType } from "./applications";
import type { Deployment } from "./deployments";
import type { TeardownReport } from "./teardown";

/**
 * `volume-backups.controller.ts` — tars a named Docker volume to an S3
 * destination on a cron, independent of the database dump backups.
 *
 * Two things about the shape are worth knowing before reading the panel:
 *
 * 1. **`turnOff` is the honest-backup switch.** A volume tarred while its
 *    service is writing to it produces a tarball that may not restore. Stopping
 *    the service first costs downtime and is the only way to be sure.
 * 2. **Restore is not the inverse of a backup row.** `POST /restore` takes the
 *    service, the volume and a **full S3 object key** — any tarball in the
 *    destination *the caller is entitled to* can go into any volume, so it is
 *    not "restore this schedule". The key is authorized against the
 *    Service whose prefix it sits under, so a 403 here is about whose tarball it
 *    is rather than about the target.
 *    The keys come from `GET /destinations/:id/objects`
 * so the first
 *    step of the flow picks one that is really in the bucket.
 *
 * As with schedules, a run is recorded on a `deployment` row keyed by
 * `volumeBackupId` — and as with schedules it now reads back:
 * `GET /volume-backups/:volumeBackupId/deployments`
 * is `runHistory`
 * below, and a run's log is `deploymentsApi.readLogs(row.deploymentId)`
 * `endpoints/
 * schedules.ts` has the full story of why the log route needed its own fix; the
 * short version is that it resolved a Deployment's owner as
 * `applicationId ?? composeId` and refused every volume-backup run.
 *
 * **This is the read that turns a silently failing backup schedule into a visible
 * one**, which matters more here than on a schedule: a tar that has been failing
 * for a month looks exactly like one that has been working until somebody goes
 * looking in the bucket.
 */

export interface VolumeBackup {
  volumeBackupId: string;
  name: string;
  /** The Docker volume that gets tarred. */
  volumeName: string;
  /** S3 path fragment between the service's appName and the tarball. */
  prefix: string;
  serviceType: ServiceType;
  /** Names the local staging directory. Server-side. */
  appName: string;
  /** Compose only: which service in the stack mounts the volume. */
  serviceName: string | null;
  /** Stop the service while the tar runs. */
  turnOff: boolean;
  /** The cron expression. */
  schedule: string;
  /** Keep the newest N tarballs after each run. Null keeps every one. */
  keepLatestCount: number | null;
  enabled: boolean | null;
  destinationId: string;
  applicationId: string | null;
  composeId: string | null;
  /** Set when the backup is of a Server bucket's volume. */
  bucketId?: string | null;
}

export interface CreateVolumeBackupInput {
  name: string;
  volumeName: string;
  prefix: string;
  schedule: string;
  serviceType?: ServiceType;
  serviceId: string;
  serviceName?: string;
  turnOff?: boolean;
  keepLatestCount?: number | null;
  enabled?: boolean;
  destinationId: string;
}

/** The backup cannot be re-pointed at another service. */
export type UpdateVolumeBackupInput = Partial<{
  name: string;
  volumeName: string;
  prefix: string;
  schedule: string;
  serviceName: string | null;
  turnOff: boolean;
  keepLatestCount: number | null;
  enabled: boolean;
  destinationId: string;
}>;

export interface RestoreVolumeBackupInput {
  serviceId: string;
  /** The restore targets `restoreVolumeBackupSchema` takes; a bucket's
   * restore stops its Garage itself. */
  serviceType: "application" | "compose" | "bucket";
  /** The volume the tarball is unpacked into. Its contents are replaced. */
  volumeName: string;
  /** Full S3 object key of the tarball. */
  backupFileName: string;
  destinationId: string;
}

export const volumeBackupsApi = {
  listByService: (serviceId: string, serviceType: ServiceType = "application") =>
    api.get<VolumeBackup[]>("/volume-backups", {
      query: { serviceId, serviceType },
    }),

  findOne: (volumeBackupId: string) =>
    api.get<VolumeBackup>(`/volume-backups/${volumeBackupId}`),

  create: (input: CreateVolumeBackupInput) =>
    api.post<VolumeBackup>("/volume-backups", input),

  update: (volumeBackupId: string, input: UpdateVolumeBackupInput) =>
    api.patch<VolumeBackup>(`/volume-backups/${volumeBackupId}`, input),

  /** Runs the tar now, outside its cron. */
  run: (volumeBackupId: string) =>
    api.post<unknown>(`/volume-backups/${volumeBackupId}/run`),

  /**
   * This volume backup's runs, newest first.
   *
   * On the deployments controller — `GET /volume-backups/:id/deployments` — and
   * declared here for the same reason `schedulesApi.runHistory` is. Access is
   * resolved through `VolumeBackupsService.findOne`, so it inherits the backed-up
   * service's own scope. Each row's log is
   * `deploymentsApi.readLogs(row.deploymentId)`.
   */
  runHistory: (volumeBackupId: string) =>
    api.get<Deployment[]>(`/volume-backups/${volumeBackupId}/deployments`),

  /** **Destructive.** Unpacks a tarball over a volume's current contents. */
  restore: (input: RestoreVolumeBackupInput) =>
    api.post<unknown>("/volume-backups/restore", input),

  remove: (volumeBackupId: string) =>
    api.delete<VolumeBackup & Pick<TeardownReport, "unreclaimedArtifacts">>(
      `/volume-backups/${volumeBackupId}`,
    ),
};
