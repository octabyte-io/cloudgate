import { isApiError } from "@/lib/api/api-error";

/**
 * What a delete admits it left behind, mirroring `backend/src/common/
 * teardown-steps.ts` and `common/workload-presence.ts`.
 *
 * **The response is the last place these exist.** The row is gone from the
 * database by the time an operator reads them, so nothing can be looked up
 * again afterwards: `UnreclaimedArtifact` names a triple (kind, machine, path)
 * that only this body carries, and there is no route that will ever answer for
 * it. That is the whole reason the console has to render them
 * — before it
 * did, a delete against an unreachable Server answered 200 with a populated
 * `unreclaimedArtifacts` and the UI dropped it on the floor.
 *
 * **Every field is optional and absent rather than empty**, which is deliberate
 * on the backend's side (`cascadeDelete`'s rule for `orphaned`): a bare `[]` on
 * every healthy delete would make the field mean *"this route can leak
 * things"* rather than *"these were left behind"*. So the common case is an
 * object with none of these keys, and {@link teardownReportIsEmpty} is how a
 * caller asks — never `report.unreclaimedArtifacts.length`, which is a
 * `TypeError` on the healthy path.
 */

/** `null` is the platform host — the machine Cloudgate itself runs on. */
export type MachineId = string | null;

export type UnreclaimedArtifactKind =
  | "source-tree"
  | "compose-directory"
  | "traefik-config"
  | "patch-repo"
  | "file-mounts"
  | "deployment-logs"
  | "network"
  | "volume"
  | "trace-store";

/**
 * A path on a machine that a delete could not confirm it removed — or, for
 * `network`, the name of a Docker network, and for `volume` the name of
 * a Docker volume an Application Delete was asked to remove and kept.
 */
export interface UnreclaimedArtifact {
  kind: UnreclaimedArtifactKind;
  appName: string;
  /**
   * The build host for a source tree or a patch-repo clone, the run Server for
   * a Traefik config or a file-mounts tree, and whichever machine wrote them
   * for deployment logs. One `appName` can name two
   * machines in one report, which is the shape rather than a duplicate.
   */
  serverId: MachineId;
  path: string;
  /**
   * Why it was left, when the kind alone does not say — set on every `volume`
   * entry: another Service uses it (named when you can see it), its Volume
   * lock was held, or Docker refused the removal.
   */
  reason?: string;
}

/** Images a delete could not remove, grouped by the machine that holds them. */
export interface UnreclaimedImages {
  serverId: MachineId;
  images: string[];
}

/** A workload the delete could not confirm was gone. */
export interface OrphanedWorkload {
  appName: string;
  serverId: MachineId;
  reason: "present" | "unknown";
}

/**
 * The codes a Server Delete's 409 carries when it kept the row because it
 * could not confirm the workload gone, mirroring `backend/src/common/
 * workload-kept-refusal.ts`: Docker still reports it, or the Server
 * did not answer. Either may be forced, which the console offers as "Remove
 * from Cloudgate anyway". A cloud Delete never answers with these: its row
 * stays by rule, with Retry and Forget instead (ADR-0038).
 */
const WORKLOAD_KEPT_CODES = {
  WORKLOAD_STILL_PRESENT: "present",
  WORKLOAD_PRESENCE_UNKNOWN: "unknown",
} as const satisfies Record<string, OrphanedWorkload["reason"]>;

/** Why a Delete was refused and the row kept, or `null` for any other failure. */
export function workloadKeptBy(
  error: unknown,
): OrphanedWorkload["reason"] | null {
  if (!isApiError(error) || error.status !== 409) return null;
  return (
    (WORKLOAD_KEPT_CODES as Record<string, OrphanedWorkload["reason"]>)[
      error.code
    ] ?? null
  );
}

/** Why a Delete kept a bucket: it holds files, Cloudgate could not tell, or emptying it stopped partway. */
export type BucketKeptBecause = "holds-files" | "unknown" | "partly-emptied";

/**
 * A bucket a Delete kept on purpose and names once: on a Server,
 * its volume, which still holds its files; on AWS, the S3 bucket itself, in
 * its account and region. Cloudgate forgets it afterwards.
 */
export type BucketLeftBehind = ServerBucketLeftBehind | CloudBucketKept;

export interface ServerBucketLeftBehind {
  /** The bucket's real name. */
  bucketName: string;
  volumeName: string;
  serverId: MachineId;
  because: BucketKeptBecause;
}

/**
 * An S3 bucket a cloud Delete kept (ADR-0038's *Kept*): it holds
 * files or could not be read. It keeps Cloudgate's tag in AWS. On Google
 * Cloud it is a Cloud Storage bucket in a project, its key gone.
 */
export interface CloudBucketKept {
  bucketName: string;
  because: "holds-files" | "unknown";
  cloud: {
    cloudAccountId: string;
    cloudAccountName: string;
    region: string;
  } & ({ awsAccountId: string } | { projectId: string });
}

/** Whether a kept cloud bucket is a Cloud Storage bucket on Google Cloud. */
function onGoogle(bucket: CloudBucketKept): boolean {
  return "projectId" in bucket.cloud;
}

/** A kept cloud bucket's account or project, as the report's machine column reads it. */
export function cloudBucketMachine(bucket: CloudBucketKept): string {
  return "projectId" in bucket.cloud
    ? `Google Cloud ${bucket.cloud.projectId}, ${bucket.cloud.region}`
    : `AWS ${bucket.cloud.awsAccountId}, ${bucket.cloud.region}`;
}

/** A kept cloud bucket's place as the copied report's one line names it. */
export function cloudBucketCopyPlace(bucket: CloudBucketKept): string {
  return "projectId" in bucket.cloud
    ? `gcp ${bucket.cloud.projectId} ${bucket.cloud.region}`
    : `aws ${bucket.cloud.awsAccountId} ${bucket.cloud.region}`;
}

/** Whether a kept bucket is an S3 bucket on AWS. */
export function isCloudBucketKept(
  bucket: BucketLeftBehind,
): bucket is CloudBucketKept {
  return "cloud" in bucket;
}

/** Where a kept cloud bucket stays, in words: its account or project, and region. */
export function cloudBucketPlace(bucket: CloudBucketKept): string {
  return "projectId" in bucket.cloud
    ? `Google Cloud project ${bucket.cloud.projectId} (${bucket.cloud.cloudAccountName}), ${bucket.cloud.region}`
    : `AWS account ${bucket.cloud.awsAccountId} (${bucket.cloud.cloudAccountName}), ${bucket.cloud.region}`;
}

/** Why a kept bucket was kept, as a sentence. */
export function bucketKeptNote(bucket: BucketLeftBehind): string {
  if (isCloudBucketKept(bucket) && onGoogle(bucket)) {
    return bucket.because === "unknown"
      ? `Cloudgate could not tell whether Cloud Storage bucket ${bucket.bucketName} holds files, so it was kept in ${cloudBucketPlace(bucket)}, as if it does; its key and service account were destroyed. Delete it in Google Cloud once nothing needs it.`
      : `Cloud Storage bucket ${bucket.bucketName} holds files, so it was kept in ${cloudBucketPlace(bucket)} with Cloudgate's labels; its key and service account were destroyed. Delete it in Google Cloud once nothing needs them.`;
  }
  if (isCloudBucketKept(bucket)) {
    return bucket.because === "unknown"
      ? `Cloudgate could not tell whether S3 bucket ${bucket.bucketName} holds files, so it was kept in ${cloudBucketPlace(bucket)}, as if it does. Delete it in AWS once nothing needs it.`
      : `S3 bucket ${bucket.bucketName} holds files, so it was kept in ${cloudBucketPlace(bucket)} with Cloudgate's tag. Delete it in AWS once nothing needs them.`;
  }
  switch (bucket.because) {
    case "holds-files":
      return `Bucket ${bucket.bucketName} holds files, so its volume was kept with them. Remove it with docker volume rm once nothing needs them.`;
    case "unknown":
      return `Cloudgate could not tell whether bucket ${bucket.bucketName} holds files, so its volume was kept as if it does.`;
    case "partly-emptied":
      return `Bucket ${bucket.bucketName} was partly emptied: deleting its files stopped partway, so its volume was kept with what is left.`;
  }
}

/**
 * The buckets an Environment's or Project's Delete kept, as one toast line
 * each by its real name and volume, or on AWS its account and region
 * `undefined` when it kept none.
 */
export function keptBucketsLine(
  report: Pick<TeardownReport, "bucketsLeftBehind">,
): string | undefined {
  const kept = report.bucketsLeftBehind ?? [];
  if (kept.length === 0) return undefined;
  const named = kept
    .map((bucket) =>
      isCloudBucketKept(bucket)
        ? `${bucket.bucketName} (${cloudBucketPlace(bucket)})`
        : `${bucket.bucketName} (volume ${bucket.volumeName})`,
    )
    .join(", ");
  const where = kept.every(isCloudBucketKept)
    ? "in AWS"
    : kept.some(isCloudBucketKept)
      ? "on the Server or in AWS"
      : `with ${kept.length === 1 ? "its volume" : "their volumes"} on the Server`;
  return `Kept ${kept.length === 1 ? "a bucket" : `${kept.length} buckets`} that ${kept.length === 1 ? "holds" : "hold"} files, or that Cloudgate could not read, ${where}: ${named}.`;
}

/**
 * The three shapes a delete can answer with, spread onto the deleted row.
 *
 * Applied to `applicationsApi.remove`, `composeApi.remove`,
 * `databasesApi.remove` and `previewDeploymentsApi.remove` — the four that
 * carry them — and, for `unreclaimedArtifacts` alone, to `schedulesApi`,
 * `backupsApi` and `volumeBackupsApi`'s `remove`, whose only leftover is their
 * run logs.
 */
export interface TeardownReport {
  unreclaimedArtifacts?: UnreclaimedArtifact[];
  unreclaimedImages?: UnreclaimedImages[];
  orphaned?: OrphanedWorkload[];
  /**
   * Previews whose Swarm service could not be confirmed gone. A separate field
   * on the backend because `orphaned` is what a 409 is decided on and a preview
   * is not a child; rendered in the same list as `orphaned`, because to an
   * operator both sentences are *"this may still be running"*.
   */
  orphanedPreviews?: OrphanedWorkload[];
  /**
   * Buckets an Environment's or Project's Delete kept because they hold files.
   * Kept on purpose, not a failure, but named here once and nowhere
   * else.
   */
  bucketsLeftBehind?: BucketLeftBehind[];
}

/**
 * Whether a delete left nothing behind — the common case, and the one where
 * the console must show nothing at all.
 *
 * Written as a total check over the five fields rather than a truthiness test
 * on one, so a fifth field added to {@link TeardownReport} without updating
 * this reads as "empty" only until its `keyof` lands here. A present-but-empty
 * array counts as empty: the backend does not send those, but a consumer that
 * normalizes would, and "nothing to act on" is the honest reading either way.
 */
export function teardownReportIsEmpty(report: TeardownReport | undefined) {
  if (!report) return true;
  return (
    !report.unreclaimedArtifacts?.length &&
    !report.unreclaimedImages?.length &&
    !report.orphaned?.length &&
    !report.orphanedPreviews?.length &&
    !report.bucketsLeftBehind?.length
  );
}

/**
 * How many separate things an operator has to deal with, for the heading.
 *
 * An `unreclaimedImages` entry counts once per image rather than once per
 * machine, because the machine is how they are grouped on the wire and not
 * what the operator acts on.
 */
export function teardownReportCount(report: TeardownReport) {
  return (
    (report.unreclaimedArtifacts?.length ?? 0) +
    (report.unreclaimedImages?.reduce((n, e) => n + e.images.length, 0) ?? 0) +
    (report.orphaned?.length ?? 0) +
    (report.orphanedPreviews?.length ?? 0) +
    (report.bucketsLeftBehind?.length ?? 0)
  );
}

/**
 * What each artifact kind is, and whether it is urgent.
 *
 * `traefik-config` is the one entry an operator has to act on *now*: a stale
 * dynamic-config fragment keeps advertising a public hostname that answers 404
 * at the edge. `file-mounts` is the one to read before removing — since
 * that directory holds the last copy in existence of the operator's own file
 * bodies, in plaintext. `compose-directory` is read-first for the same reason a
 * Compose's file mounts and traces sit inside its project directory, beside the
 * clone.
 */
export const UNRECLAIMED_ARTIFACT_KIND: Record<
  UnreclaimedArtifactKind,
  { label: string; note: string; urgent: boolean }
> = {
  "traefik-config": {
    label: "Traefik config",
    note: "Still advertising this service's hostnames at the edge, which now answer 404. Remove it first.",
    urgent: true,
  },
  "file-mounts": {
    label: "File mounts",
    note: "Holds the only remaining copy of this service's mounted file contents, in plaintext. Read it before you remove it.",
    urgent: false,
  },
  "source-tree": {
    label: "Source tree",
    note: "The build's checkout. Safe to remove.",
    urgent: false,
  },
  "compose-directory": {
    label: "Compose directory",
    note: "Holds this Compose's file mounts, the only remaining copy of their contents in plaintext, beside its traces and its checkout. Read it before you remove it.",
    urgent: false,
  },
  "patch-repo": {
    label: "Patch repo",
    note: "The clone patches were applied in. Safe to remove.",
    urgent: false,
  },
  "deployment-logs": {
    label: "Deployment logs",
    note: "Build and run output no screen can open any more. Safe to remove; Cloudgate deletes logs older than 90 days on its own.",
    urgent: false,
  },
  volume: {
    label: "Docker volume",
    note: "Kept on the Server with its data. Remove it with docker volume rm once nothing needs it.",
    urgent: false,
  },
  "trace-store": {
    label: "Trace store",
    note: "The traces this service sent: its store's container, or its directory. Safe to remove with docker rm --force or rm -rf.",
    urgent: false,
  },
  network: {
    label: "Docker network",
    note: "The network Network isolation gave this stack. Safe to remove with docker network rm once nothing is attached to it.",
    urgent: false,
  },
};
