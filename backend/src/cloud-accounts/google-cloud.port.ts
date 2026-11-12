import type {
  DnsAnswer,
  GoogleCredential,
  GoogleStateResource,
  TofuApplyOutcome,
  TofuApplyRequest,
  TofuPlanOutcome,
  TofuRunRequest,
  TofuStateOutcome,
  TofuStateReadRequest,
} from './cloud.port';

/**
 * The Google client port: the one seam through which Cloudgate reaches
 * Google Cloud (the Google Cloud spec, "Google client port"; S12). A second port beside
 * the AWS one rather than more methods on it, so each adapter holds one
 * cloud's clients: {@link GoogleCloudPort}'s only implementation is
 * `GoogleCloudAdapter` (`gcp/google-cloud.adapter.ts`), the one file that
 * calls Google's APIs, and every e2e spec gets an in-memory fake in its
 * place (`test/utils/fake-google-cloud-port.ts`, as `ctx.google`).
 *
 * **Primitive calls, not the checks built from them.** The connect check's
 * sequence lives in `gcp/connect-check.ts`, so the fake only scripts what
 * Google would answer.
 *
 * **Answers, not exceptions**, as on AWS. A call Google refuses resolves to
 * `{ ok: false, code, message }` with Google's own status (`NOT_FOUND`,
 * `PERMISSION_DENIED`, …, or STS's OAuth error) and words; an exception means
 * the call never got an answer, and the caller fails rather than concludes.
 *
 * Later tickets grow it — Cloud Run readiness and scaling, image clean-up,
 * logs, certificates, DNS (the Google Cloud spec) — by adding methods here and to the
 * fake; the leftover search after a Delete is {@link GoogleCloudPort.findByName},
 * which slice 7 extends with its own kinds, and after an
 * Environment's Delete also {@link GoogleCloudPort.findByLabel}.
 */
export const GOOGLE_CLOUD_PORT = Symbol('GOOGLE_CLOUD_PORT');

/** Google's status for a thing that is not there. */
export const NOT_FOUND = 'NOT_FOUND';
/** Google's status for a caller that may not. */
export const PERMISSION_DENIED = 'PERMISSION_DENIED';
/** Google's status for a call over the project's quota, e.g. Cloud Logging's 60 reads a minute. */
export const RESOURCE_EXHAUSTED = 'RESOURCE_EXHAUSTED';

/** What Google answered: the value, or its refusal in its own words. */
export type GoogleAnswer<T> =
  { ok: true; value: T } | { ok: false; code: string; message: string };

/** A short-lived OAuth access token: STS's federated one, or a service account's. */
export interface GoogleAccessToken {
  accessToken: string;
}

export interface TokenExchangeRequest {
  /** The audience STS is asked for: the provider's full resource name, `//iam.googleapis.com/projects/…`. */
  audience: string;
  /** Cloudgate's signed ID token. */
  subjectToken: string;
}

export interface ImpersonateRequest {
  /** The deploy service account's email. */
  serviceAccount: string;
  lifetimeSeconds: number;
}

export interface GoogleProject {
  projectId: string;
  projectNumber: string;
}

/**
 * What a Cloud run's credential configuration is made from (the Google Cloud spec,
 * S16): the provider to trade at, the service account to step into, and the
 * run's own freshly signed token.
 */
export interface CredentialConfigurationRequest {
  audience: string;
  serviceAccount: string;
  subjectToken: string;
}

/**
 * A Google API whose locations the region check lists (the Google Cloud spec, "Region
 * check"): Cloud Run, which runs a `web`, and Artifact Registry, which holds
 * its image in the same region.
 */
export type GoogleLocationsApi =
  'run.googleapis.com' | 'artifactregistry.googleapis.com';

/**
 * One thing Google's own list call for a kind found by Cloudgate's fixed
 * name prefix (S4), as the port answers it.
 */
export interface FoundByName {
  /** The OpenTofu type of the kind listed, e.g. `google_cloud_run_v2_service`. */
  readonly resourceType: string;
  /** Its fixed name (S4): what is matched against the plan's creates. */
  readonly name: string;
  /** Google's full resource name, the id an Apply would import. */
  readonly id: string;
  /** Its `description`, which carries Cloudgate's mark: the unencoded ids (S4). */
  readonly description?: string;
  /** Its labels, for the kinds with no `description` (a secret). */
  readonly labels?: Readonly<Record<string, string>>;
}

/** What one search by name asks: one kind, in one project and region, by name prefix. */
export interface FindByNameRequest {
  readonly projectId: string;
  /** The region of a regional kind; a global kind ignores it. */
  readonly region: string;
  /** The OpenTofu type of the kind, e.g. `google_compute_network`. */
  readonly resourceType: string;
  /** Every name Cloudgate gives one state's things starts with it (S4). */
  readonly namePrefix: string;
  /**
   * The fixed name of the thing a nested kind is listed under: a
   * certificate map entry's certificate map. A nested kind asked without
   * it finds nothing.
   */
  readonly parent?: string;
}

/**
 * What the label search after an Environment's Delete asks (the Google Cloud databases spec,
 * "Deleting the Environment"): everything in one project carrying
 * one of Cloudgate's labels, in any region.
 */
export interface FindByLabelRequest {
  readonly projectId: string;
  /** The label's key, `cloudgate-environment`, and its value, the id's key (S5). */
  readonly label: { readonly key: string; readonly value: string };
}

/** One thing the label search found, as the port answers it. */
export interface FoundByLabel {
  /** Google's own name for its kind, `compute.googleapis.com/Address` and so on. */
  readonly type: string;
  /** Google's id for it: its full resource name. */
  readonly id: string;
  /** Its region; `global` for a global one. */
  readonly region: string;
  /** Its labels, Cloudgate's among them. */
  readonly labels: Readonly<Record<string, string>>;
}

/** One Cloud Run service, by its fixed name, in a project and region. */
export interface CloudRunServiceRef {
  readonly projectId: string;
  readonly region: string;
  /** Its fixed name (S4), the `service_name` output. */
  readonly name: string;
}

/**
 * A Cloud Run service's own account of its rollout, as its `services.get`
 * answers it: which revision it made last,
 * which one is ready, where its traffic goes, and its `Ready` condition.
 * Revision names are their last part (`cloudgate-abc-00002-xyz`).
 */
export interface CloudRunServiceStatus {
  /** Whether Google is still working towards what the service asks. */
  readonly reconciling: boolean;
  readonly latestCreatedRevision: string | null;
  readonly latestReadyRevision: string | null;
  /** The service's `Ready` condition. */
  readonly terminalCondition: {
    /** `CONDITION_SUCCEEDED`, `CONDITION_FAILED`, `CONDITION_PENDING`, `CONDITION_RECONCILING`, … */
    readonly state: string;
    readonly reason: string | null;
    readonly message: string | null;
  } | null;
  /** Where the traffic goes now: a revision's name, or `null` for "the latest ready one". */
  readonly traffic: readonly {
    readonly revision: string | null;
    readonly percent: number;
  }[];
}

/**
 * A Cloud Run service's copy range (the Google Cloud spec, S10): the
 * fewest and most copies its revisions run, Cloudgate's per Service.
 */
export interface CopyRange {
  readonly min: number;
  readonly max: number;
}

/**
 * What Stop and Start set on a Cloud Run service's own scaling: manual scaling
 * with no copies, which refuses traffic, or automatic
 * scaling again within its copy range.
 */
export type CloudRunScaling =
  | { readonly mode: 'stopped' }
  | { readonly mode: 'automatic'; readonly copies: CopyRange };

/**
 * One Cloud Run worker pool, a Worker's, by its fixed name (S4), the
 * `worker_pool_name` output, in a project and region.
 */
export type CloudRunWorkerPoolRef = CloudRunServiceRef;

/**
 * A Cloud Run worker pool's own account of its rollout, as its
 * `workerPools.get` answers it: as a service's, with its instance
 * splits in place of traffic, and the manual instance count it runs.
 */
export interface CloudRunWorkerPoolStatus extends Omit<
  CloudRunServiceStatus,
  'traffic'
> {
  /** `scaling.manualInstanceCount`; `null` when Google gives none. */
  readonly instanceCount: number | null;
  /** `instanceSplitStatuses`: which revisions its instances run. */
  readonly instanceSplits: readonly {
    readonly revision: string | null;
    readonly percent: number;
  }[];
}

/**
 * One Cloud Run job, a Cron service's, by its fixed name (S4), the
 * `job_name` output, in a project and region.
 */
export type CloudRunJobRef = CloudRunServiceRef;

/**
 * One execution of a Cron service's Cloud Run job: one run, by its
 * job and its own short name (`cloudgate-abc-x7k2p`), which `jobs.run`
 * answers and the Run record keeps.
 */
export interface CloudRunExecutionRef {
  readonly projectId: string;
  readonly region: string;
  /** Its job's fixed name. */
  readonly job: string;
  /** The execution's last name part, as `jobs.run` names it. */
  readonly execution: string;
}

/**
 * An execution as `executions.get` and its one task answer it:
 * whether it has ended and how. A Cron service's job has one task, never
 * retried, so the task's last attempt is the run.
 */
export interface CloudRunExecutionStatus {
  /**
   * `running` until Google sets its completion time; then `succeeded`,
   * `failed` or `cancelled` by its `Completed` condition and counts.
   */
  readonly state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  /**
   * Its task's container exit code, when Google reports one: none for a
   * task whose container never ran (an image it could not pull).
   */
  readonly exitCode: number | null;
  /** Google's words for how it ended, when it failed or was cancelled. */
  readonly message: string | null;
}

/**
 * Where the copy of an execution's log has reached: the timestamp
 * of the last entry copied, and every entry at exactly that timestamp
 * already copied, by insert id, so a read from there neither skips an entry
 * stamped the same instant nor copies one twice.
 */
export interface ExecutionLogPlace {
  readonly timestamp: string;
  readonly insertIds: readonly string[];
}

/** One read of an execution's own log entries. */
export interface ExecutionLogRequest extends CloudRunExecutionRef {
  /** From this place on, its entries at that instant among them; `null` from the start. */
  readonly from: ExecutionLogPlace | null;
  /** At most this many, oldest first. */
  readonly limit: number;
}

/** One label on a Cloud Run service's revisions: Reload's (S9). */
export interface RevisionLabel {
  readonly key: string;
  readonly value: string;
}

/** One read of the project's own log store (Cloud Logging `entries.list`). */
export interface LogEntriesRequest {
  readonly projectId: string;
  /** Cloud Logging's filter, written by the caller. */
  readonly filter: string;
  /** At most this many, newest first unless {@link oldestFirst}. */
  readonly limit: number;
  /** Oldest first, so a full page is read on from its last line (the Runtime log). */
  readonly oldestFirst?: boolean;
}

/** One line of the project's log store. */
export interface LogEntry {
  /** Google's id for the entry: the same entry read twice has the same one. */
  readonly insertId: string;
  /** The log it is in, `projects/<id>/logs/run.googleapis.com%2Fstdout` and so on. */
  readonly logName: string;
  readonly timestamp: string;
  /** The Cloud Run revision it is about (`resource.labels.revision_name`), if any. */
  readonly revision: string | null;
  /** The Cloud Run instance (copy) that wrote it (`labels.instanceId`), if any. */
  readonly instance: string | null;
  /** Its text: `textPayload`, else `jsonPayload.message`, else the payload as JSON. */
  readonly text: string;
}

/** The image versions of one Service's repository but one. */
export interface ImageVersionsRequest {
  readonly projectId: string;
  readonly region: string;
  /** The repository's id, its fixed name. */
  readonly repository: string;
  /** The image (Artifact Registry's package) in it. */
  readonly image: string;
  /** The tag of the version kept: the live one. */
  readonly keepTag: string;
}

/** One Certificate Manager certificate, by its full name (`projects/…/certificates/…`). */
export interface GoogleCertificateRef {
  readonly projectId: string;
  /** Its full resource name, the id its state holds. */
  readonly name: string;
}

/**
 * A Google-managed certificate as Certificate Manager reports it: its
 * `managed.state`, and why it is stuck or failed.
 */
export interface GoogleCertificate {
  /** `PROVISIONING`, `ACTIVE` or `FAILED`. */
  readonly state: string;
  /**
   * Google's reason, when it gives one: the provisioning issue's, or the
   * failed authorization attempt's (`CONFIG`, `CAA`, `RATE_LIMITED`, …).
   */
  readonly reason: string | null;
}

/** One Cloud SQL instance, by its fixed name (S4), in a project. */
export interface CloudSqlInstanceRef {
  readonly projectId: string;
  /** Its fixed name, `cloudgate-<service key>`. */
  readonly name: string;
}

/** A Stack VM's Compute Engine instance, by its name, in its project and zone (ADR-0070). */
export interface ComputeInstanceRef {
  readonly projectId: string;
  readonly zone: string;
  readonly name: string;
}

/**
 * Compute Engine's `status` of an instance: `TERMINATED` is how it names a
 * stopped one, whose disks stay.
 */
export type ComputeInstanceStatus =
  | 'PROVISIONING'
  | 'STAGING'
  | 'RUNNING'
  | 'STOPPING'
  | 'STOPPED'
  | 'SUSPENDING'
  | 'SUSPENDED'
  | 'REPAIRING'
  | 'TERMINATED';

/** One Memorystore for Valkey instance, by its fixed name (S4), in a project and region. */
export interface MemorystoreInstanceRef {
  readonly projectId: string;
  readonly region: string;
  readonly name: string;
}

/**
 * One Cloud SQL instance an operator named by its connection name
 * (`project:region:instance`), for an Existing database (ADR-0033 as amended):
 * the project it is in and its own name there.
 */
export interface ExistingCloudSqlRef {
  readonly projectId: string;
  readonly instance: string;
}

/** One of the names a Cloud SQL instance reports in `dnsNames`. */
export interface CloudSqlDnsName {
  /** As Google reports it: a `….sql.goog.` name keeps its trailing dot. */
  readonly name: string;
  /** `PRIVATE_SERVICE_CONNECT`, `PUBLIC`, …, or `null` when Google gives none. */
  readonly connectionType: string | null;
  /** `CUSTOMER` (the operator's to record) or `CLOUD_SQL_AUTOMATION`, or `null`. */
  readonly recordManager: string | null;
}

/**
 * What a Cloud SQL instance's `instances.get` says of it, the fields an
 * Existing database's lookup judges: where it is, what it runs,
 * how it takes connections, who may reach it through Private Service
 * Connect, its names and its server CA.
 */
export interface CloudSqlInstanceRead {
  readonly region: string;
  /** `POSTGRES_17`, `MYSQL_8_4`, …. */
  readonly databaseVersion: string;
  /** `settings.userLabels`. */
  readonly labels: Readonly<Record<string, string>>;
  /** `settings.ipConfiguration.sslMode`, or `null` when Google gives none. */
  readonly sslMode: string | null;
  /** `settings.ipConfiguration.pscConfig.pscEnabled`. */
  readonly pscEnabled: boolean;
  /** `settings.ipConfiguration.ipv4Enabled`: a public IP. */
  readonly publicIp: boolean;
  /** `settings.ipConfiguration.privateNetwork`: private services access, or `null`. */
  readonly privateNetwork: string | null;
  /** `settings.ipConfiguration.pscConfig.allowedConsumerProjects`, as Google lists them. */
  readonly allowedConsumerProjects: readonly string[];
  /** `pscServiceAttachmentLink`, or `null` while PSC is off. */
  readonly serviceAttachment: string | null;
  readonly dnsNames: readonly CloudSqlDnsName[];
  /** `serverCaCert.cert`, PEM, or `null`. */
  readonly serverCa: string | null;
}

/**
 * One Memorystore instance an operator named as `project/region/instance`,
 * for an Existing database that is a `redis` (ADR-0033 as amended): the project
 * and region it is in and its own id there.
 */
export interface ExistingValkeyRef {
  readonly projectId: string;
  readonly region: string;
  readonly instance: string;
}

/**
 * Which Memorystore product answered for the name: Memorystore for
 * Valkey, the one Cloudgate reaches, or Memorystore for Redis or Redis
 * Cluster, which a plan refuses with "use Valkey" (ADR-0042).
 */
export type MemorystoreProduct = 'valkey' | 'redis' | 'redis-cluster';

/** One of a Valkey instance's service attachments, `pscAttachmentDetails[]`. */
export interface ValkeyServiceAttachment {
  readonly serviceAttachment: string;
  /** `CONNECTION_TYPE_PRIMARY`, `CONNECTION_TYPE_READER`, …, or `null`. */
  readonly connectionType: string | null;
}

/**
 * What Memorystore says of an instance, the fields an Existing database's
 * lookup judges (the Google Cloud buckets spec "Existing Cloud SQL and Valkey"): which
 * product it is, its mode, how it takes connections, its maintenance
 * version, what it links to and which forwarding rules it registered, and
 * its CA. Every field but `product` is empty for Memorystore for Redis and
 * Redis Cluster, which are only named to be refused.
 */
export interface MemorystoreInstanceRead {
  readonly product: MemorystoreProduct;
  /** `VALKEY_8_0`, …. */
  readonly engineVersion: string;
  /** `CLUSTER` or `CLUSTER_DISABLED`, or `null` when Google gives none. */
  readonly mode: string | null;
  /** `AUTH_DISABLED` or `IAM_AUTH`, …, or `null`. */
  readonly authorizationMode: string | null;
  /** `SERVER_AUTHENTICATION` or `TRANSIT_ENCRYPTION_DISABLED`, or `null`. */
  readonly transitEncryptionMode: string | null;
  /** The maintenance version it runs, `MEMORYSTORE_20251210_02_00`, or `null`. */
  readonly maintenanceVersion: string | null;
  readonly labels: Readonly<Record<string, string>>;
  /** Where a manual endpoint points, one per connection type. */
  readonly serviceAttachments: readonly ValkeyServiceAttachment[];
  /**
   * The forwarding rules registered on it as user connections
   * (`endpoints[].connections[].pscConnection.forwardingRule`), as Google
   * lists them: relative names or full URLs.
   */
  readonly registeredForwardingRules: readonly string[];
  /** Its server CA's certificates, PEM, joined; `null` with TLS off or none read. */
  readonly ca: string | null;
}

/**
 * One manual Private Service Connect endpoint's forwarding rule, by
 * its fixed name, in a project and region.
 */
export interface PscEndpointRef {
  readonly projectId: string;
  readonly region: string;
  readonly name: string;
}

/**
 * A Cloud SQL instance's `settings.activationPolicy` as Stop and Start set
 * it (the Google Cloud buckets spec "Stop and Start"): `NEVER` stops it until it is
 * started again, which Google never does by itself; `ALWAYS` runs it.
 */
export type CloudSqlActivationPolicy = 'NEVER' | 'ALWAYS';

/**
 * An on-demand backup Google has finished taking: where it is kept
 * and how much it holds, as Google bills it. A Cloud SQL one is kept in the
 * multi-region nearest the instance (`us`), a Valkey one in its region.
 */
export interface TakenBackup {
  readonly location: string;
  /** Its size in bytes, or `null` when Google did not say. */
  readonly sizeBytes: number | null;
}

/** A Stack VM's data disk, by its name, in its project and zone (#1367). */
export interface DiskRef {
  readonly projectId: string;
  readonly zone: string;
  readonly disk: string;
}

/** A Stack VM's final snapshot to take of its data disk (#1367). */
export interface DiskSnapshotRequest extends DiskRef {
  /** The snapshot's name: `<project>-<environment>-<stack>-final-<date>`. */
  readonly name: string;
  /** Where it is kept: the disk's region. */
  readonly region: string;
  readonly description: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** A disk snapshot as Google keeps it. */
export interface TakenDiskSnapshot {
  readonly name: string;
  /** The size of the disk it was taken from, in GB. */
  readonly sizeGb: number;
}

/**
 * A Cloud SQL or Memorystore instance Cloudgate made, by its fixed name
 * (S4), in a project and region.
 */
export interface GoogleDatabaseRef {
  readonly projectId: string;
  readonly region: string;
  /** `serviceName(serviceId)`: `cloudgate-…`. */
  readonly name: string;
}

/** One backup of a Cloud SQL or Memorystore instance, as Google lists it. */
export interface GoogleDatabaseBackup {
  /** Cloud SQL's backup run id; Memorystore's backup id, the last part of its name. */
  readonly id: string;
  /** Google's own daily one, or one taken on demand (a Delete's final backup among them). */
  readonly type: 'automated' | 'manual';
  /** When it was taken (ISO 8601), or `null` while Google has not said. */
  readonly createdAt: string | null;
  /** Google's own status word, lower case: `successful`, `running`, `active`, … */
  readonly status: string;
  /** Its size (`1.4 MB`), or `null` when Google gives none. */
  readonly size: string | null;
}

/**
 * What Cloud SQL holds of an instance's backups, read live for its
 * Backups tab and never by a plan: its retention, the window point-in-time
 * recovery reaches, and its backups.
 */
export interface CloudSqlBackups {
  /** `backupRetentionSettings.retainedBackups`; 0 with automated backups off. */
  readonly retentionDays: number;
  /** `getLatestRecoveryTime`'s `earliestRecoveryTime`; `null` with none yet. */
  readonly earliestRestorableTime: string | null;
  /** `getLatestRecoveryTime`'s `latestRecoveryTime`; `null` with none yet. */
  readonly latestRestorableTime: string | null;
  /** `backupRuns.list`, newest first. */
  readonly backups: GoogleDatabaseBackup[];
}

/** What Memorystore holds of an instance's backups. */
export interface MemorystoreBackups {
  /** `automatedBackupConfig.retention`, in days; 0 with automated backups off. */
  readonly retentionDays: number;
  /** Its backup collection's backups, newest first. */
  readonly backups: GoogleDatabaseBackup[];
}

/** One object in a Cloud Storage bucket. */
export interface ObjectRef {
  readonly bucket: string;
  /** Its full name in the bucket: `live/about/index.html`, or `live/about/`. */
  readonly name: string;
}

/** One object as a listing or an upload answers it. */
export interface StoredObject {
  readonly name: string;
  /** Its MD5, base64, as Cloud Storage reports it; `null` for a composite object. */
  readonly md5Hash: string | null;
  readonly size: number;
}

/**
 * A list of one bucket's objects: every object under a prefix, every page
 * or at most `maxResults` of them, old versions included, which a
 * bucket's Delete asks for one of to tell whether it holds files.
 */
export interface ObjectListRequest {
  /** The bucket's real name: Cloud Storage's names are global. */
  readonly bucket: string;
  /** Ends in `/`: `deployments/`, `live/`. Omitted, the whole bucket. */
  readonly prefix?: string;
  /** At most this many, from one page; omitted, every page. */
  readonly maxResults?: number;
  /** Noncurrent (old) versions too (`versions=true`): a Delete's check. */
  readonly versions?: boolean;
}

/**
 * A Private Service Connect endpoint's `pscConnectionStatus`, as
 * Compute's forwarding rule reports it: Google's whole list. A value
 * Google adds later reads as `STATUS_UNSPECIFIED`.
 */
export const PSC_CONNECTION_STATUSES = [
  'STATUS_UNSPECIFIED',
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'CLOSED',
  'NEEDS_ATTENTION',
] as const;

export type PscConnectionStatus = (typeof PSC_CONNECTION_STATUSES)[number];

/**
 * What Cloud Storage's `buckets.get` says of an **existing bucket** (ADR-0033
 * as amended): the fields each plan's lookup judges.
 */
export interface StorageBucketRead {
  /** `EUROPE-WEST1`, `EUR4`, `EU`, …, as Google writes it. */
  readonly location: string;
  /** `region`, `dual-region` or `multi-region`. */
  readonly locationType: string;
  /** A configurable dual-region's two regions (`customPlacementConfig.dataLocations`); empty for any other. */
  readonly dataLocations: readonly string[];
  /** `billing.requesterPays`. */
  readonly requesterPays: boolean;
  readonly labels: Readonly<Record<string, string>>;
  /** The number of the project the bucket is in. */
  readonly projectNumber: string;
}

/** One file on the platform host, uploaded as one object. */
export interface ObjectUploadRequest extends ObjectRef {
  /** Its path on the platform host. */
  readonly file: string;
  /** What it is served as: `text/html; charset=utf-8`, … */
  readonly contentType: string;
}

/** A copy within one bucket, from one object's name to another's. */
export interface ObjectCopyRequest {
  readonly bucket: string;
  readonly from: string;
  readonly to: string;
}

/** One host's cache on the Environment network's URL map. */
export interface CacheClearRequest {
  readonly projectId: string;
  /** The network's URL map, by its name. */
  readonly urlMap: string;
  /** The Domain's host, as its host rule names it: only its cache is cleared. */
  readonly host: string;
}

/**
 * **The build config of a hosted cloud build in Cloud Build** (ADR-0047): the
 * fields of Cloud Build's `Build` resource Cloudgate sets,
 * written by `cloud-builds/google-build-program.ts` and sent as they are.
 */
export interface CloudBuildConfig {
  /** The source zip the platform host uploaded (`storageSource`). */
  readonly source: {
    readonly storageSource: {
      readonly bucket: string;
      readonly object: string;
    };
  };
  /** The steps, each an image with its entrypoint and arguments. */
  readonly steps: readonly {
    readonly name: string;
    readonly entrypoint: string;
    readonly args: readonly string[];
    /**
     * The {@link availableSecrets} this step has as environment variables
     * by their `env` names.
     */
    readonly secretEnv?: readonly string[];
  }[];
  /**
   * Secret Manager versions Cloud Build reads as the build's service
   * account and hands a step as environment variables: a private
   * registry's password for the build that copies a ready-made image. Only
   * a version's name is ever sent, so no step `env` carries a value
   * `builds.get` and the Cloud Build console show in plain text.
   */
  readonly availableSecrets?: {
    readonly secretManager: readonly {
      readonly versionName: string;
      readonly env: string;
    }[];
  };
  /** `projects/<project>/serviceAccounts/<build identity>`: who the build runs as. */
  readonly serviceAccount: string;
  /**
   * Where its log goes. A build run as a user-specified service account
   * must name one; Cloudgate's is always `CLOUD_LOGGING_ONLY`, the one
   * whose lines can be read while the build runs (`google-build-program.ts`
   * says why, with its source).
   */
  readonly options: { readonly logging: 'CLOUD_LOGGING_ONLY' };
  /** Labels Cloud Build lists it by. */
  readonly tags: readonly string[];
}

/**
 * A secret one hosted cloud build reads: made by the deploy service
 * account (`secretmanager.secrets.create`, `versions.add`), with
 * `roles/secretmanager.secretAccessor` on this secret alone granted to the
 * build identity (`secretmanager.secrets.setIamPolicy`), all role version 1.
 */
export interface BuildSecretPut {
  readonly projectId: string;
  readonly secretId: string;
  readonly value: string;
  /** The build identity's email, the secret's one reader. */
  readonly readerEmail: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** One secret of a project, by its id. */
export interface SecretRef {
  readonly projectId: string;
  readonly secretId: string;
}

/** `projects.locations.builds.create` of one build, in the Service's region. */
export interface CloudBuildStartRequest {
  readonly projectId: string;
  readonly region: string;
  readonly build: CloudBuildConfig;
}

/** One build in a region of a project, by Cloud Build's id. */
export interface CloudBuildRef {
  readonly projectId: string;
  readonly region: string;
  readonly buildId: string;
}

/** Cloud Build's `Build.status`. */
export type CloudBuildStatusName =
  | 'STATUS_UNKNOWN'
  | 'PENDING'
  | 'QUEUED'
  | 'WORKING'
  | 'SUCCESS'
  | 'FAILURE'
  | 'INTERNAL_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'EXPIRED';

/**
 * Where a Cloud Build build is, as `builds.get` answers it. `queued` is
 * `PENDING` and `QUEUED`, the wait for a worker, which never counts against
 * the Cloud run time limit; `running` is `WORKING` (and an unknown status);
 * `ended` is every other.
 */
export interface CloudBuildState {
  readonly phase: 'queued' | 'running' | 'ended';
  readonly status: CloudBuildStatusName;
  /** `failureInfo.detail`, else `statusDetail`, when Google gives one. */
  readonly reason: string | null;
  /**
   * `results.buildStepOutputs`, decoded as UTF-8, by step: what each step
   * wrote to `$BUILDER_OUTPUT/output`.
   */
  readonly stepOutputs: readonly string[];
}

/** One read of a build's own log lines in Cloud Logging, from a place on. */
export interface CloudBuildLogRequest {
  readonly projectId: string;
  readonly buildId: string;
  /** From this place on, its entries at that instant among them; `null` from the start. */
  readonly from: ExecutionLogPlace | null;
  /** At most this many, oldest first. */
  readonly limit: number;
}

export interface GoogleCloudPort {
  /** STS: trade a signed ID token for a federated access token. */
  exchangeToken(
    request: TokenExchangeRequest,
  ): Promise<GoogleAnswer<GoogleAccessToken>>;
  /** IAM Credentials `generateAccessToken`: step into a service account with the federated token. */
  impersonate(
    federated: GoogleAccessToken,
    request: ImpersonateRequest,
  ): Promise<GoogleAnswer<GoogleAccessToken>>;
  /** Resource Manager `projects.get`: the project's id and number. */
  getProject(
    token: GoogleAccessToken,
    projectId: string,
  ): Promise<GoogleAnswer<GoogleProject>>;
  /** Resource Manager `projects.testIamPermissions`: which of `permissions` the caller holds. */
  testIamPermissions(
    token: GoogleAccessToken,
    projectId: string,
    permissions: readonly string[],
  ): Promise<GoogleAnswer<string[]>>;
  /** Service Usage: the names of every API on in the project, `run.googleapis.com` and so on. */
  enabledApis(
    token: GoogleAccessToken,
    projectNumber: string,
  ): Promise<GoogleAnswer<string[]>>;
  /**
   * The region ids (`europe-west1`, …) where `api` is offered to the project:
   * its `projects.locations.list`.
   */
  listLocations(
    token: GoogleAccessToken,
    projectId: string,
    api: GoogleLocationsApi,
  ): Promise<GoogleAnswer<string[]>>;
  /** Compute `networks.list`: how many VPC networks the project has. */
  countNetworks(
    token: GoogleAccessToken,
    projectId: string,
  ): Promise<GoogleAnswer<number>>;
  /**
   * Google's list call for one kind, filtered by Cloudgate's name prefix
   * (the Google Cloud spec, "Google client port"): what a plan read adopts
   * by name or notes as "found in Google Cloud, in no state", and what a
   * Delete's search afterwards finds left (`gcp/delete-check.ts`). A
   * kind the adapter has no list call for answers nothing found.
   */
  findByName(
    token: GoogleAccessToken,
    request: FindByNameRequest,
  ): Promise<GoogleAnswer<FoundByName[]>>;
  /**
   * The label search after an Environment's Delete (the Google Cloud databases spec, "Deleting
   * the Environment"): Google's own list call, filtered on Google's
   * side by the label, in every region, for each labelled kind the
   * Environment's databases and private link can leave billing — an
   * address or a forwarding rule (a Private Service Connect address Google
   * still lists as `CLOSED`), a Cloud SQL instance and a Memorystore
   * instance. Cloud Asset Inventory is not used.
   */
  findByLabel(
    token: GoogleAccessToken,
    request: FindByLabelRequest,
  ): Promise<GoogleAnswer<FoundByLabel[]>>;
  /**
   * `tofu` init and plan against a Google state, through the shared runner
   * (the Google Cloud spec, ADR-0030), which writes the run's credential configuration
   * into the run's own folder and removes it with the folder; changes
   * nothing.
   */
  plan(request: TofuRunRequest<GoogleCredential>): Promise<TofuPlanOutcome>;
  /**
   * `tofu` init, plan and apply against a Google state through the shared
   * runner, as {@link plan} runs it; `beforeApply` sees the fresh plan
   * before anything changes (the Environment network's Apply), and
   * the answer carries `tofu output -json`.
   */
  apply(request: TofuApplyRequest<GoogleCredential>): Promise<TofuApplyOutcome>;
  /**
   * Cloud Run `services.get`: the service's rollout as Google reports it,
   * which a deploy waits on until its new revision is ready and serving all
   * traffic.
   */
  cloudRunService(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
  ): Promise<GoogleAnswer<CloudRunServiceStatus>>;
  /**
   * Cloud Run `services.patch` of the service's own scaling:
   * Stop and Start, by a direct call rather than a Cloud run, which the
   * service's definition ignores (S9). Answers once Google has taken it.
   */
  setCloudRunScaling(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    scaling: CloudRunScaling,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Run `services.patch` of the revision template's copy range alone
   * (S10), leaving the service's scaling mode as it is.
   */
  setCloudRunCopies(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    copies: CopyRange,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Run `services.patch` of one revision template label, the others
   * kept: a new revision of the same image (Reload).
   */
  setRevisionLabel(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    label: RevisionLabel,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Run `workerPools.get`: a Worker's rollout as Google
   * reports it, which its deploy waits on until the latest revision is ready
   * and runs its instance count.
   */
  cloudRunWorkerPool(
    token: GoogleAccessToken,
    pool: CloudRunWorkerPoolRef,
  ): Promise<GoogleAnswer<CloudRunWorkerPoolStatus>>;
  /**
   * Cloud Run `workerPools.patch` of `scaling.manualInstanceCount` alone
   * a Worker's Stop (0), Start and Deploy (its `replicas`), by a
   * direct call the worker pool's definition ignores. Answers once Google
   * has taken it.
   */
  setWorkerPoolInstances(
    token: GoogleAccessToken,
    pool: CloudRunWorkerPoolRef,
    instances: number,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Run `workerPools.patch` of one revision template label, the others
   * kept: a Worker's Reload, a new revision of the same image (as a service's).
   */
  setWorkerPoolRevisionLabel(
    token: GoogleAccessToken,
    pool: CloudRunWorkerPoolRef,
    label: RevisionLabel,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Run `jobs.run` of a Cron service's job, with no
   * overrides: one execution of the job as its last deploy left it.
   * Answers the execution's short name, read off the long-running
   * operation's metadata, once Google has taken it; the execution itself
   * runs on.
   */
  runCloudRunJob(
    token: GoogleAccessToken,
    job: CloudRunJobRef,
  ): Promise<GoogleAnswer<{ execution: string }>>;
  /**
   * Cloud Run `executions.get`, and when it has ended its one task's
   * last attempt: how a run is going or ended. `NOT_FOUND` once
   * Google no longer has it.
   */
  cloudRunExecution(
    token: GoogleAccessToken,
    execution: CloudRunExecutionRef,
  ): Promise<GoogleAnswer<CloudRunExecutionStatus>>;
  /**
   * Cloud Run `executions.cancel`: a run's timeout, Cancel, Stop
   * or Delete. Answers once Google has taken it.
   */
  cancelCloudRunExecution(
    token: GoogleAccessToken,
    execution: CloudRunExecutionRef,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Logging `entries.list` of one execution's own output:
   * its job's `cloud_run_job` entries labelled with its execution's name,
   * stdout and stderr, oldest first, from a place on. An entry at exactly
   * the place's instant whose insert id it holds is left out.
   */
  executionLogEntries(
    token: GoogleAccessToken,
    request: ExecutionLogRequest,
  ): Promise<GoogleAnswer<LogEntry[]>>;
  /**
   * Cloud SQL Admin `instances.patch` of `settings.activationPolicy` alone
   * Stop (`NEVER`) and Start (`ALWAYS`) of a `postgres` on Cloud
   * SQL, by a direct call rather than a Cloud run, which the instance's
   * definition ignores. Answers once Google has taken it; the operation it
   * starts is Google's.
   */
  setCloudSqlActivationPolicy(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
    policy: CloudSqlActivationPolicy,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Logging `entries.list` on the project's own log store, newest
   * first: a failed revision's last lines, and the Runtime
   * log's reads.
   */
  listLogEntries(
    token: GoogleAccessToken,
    request: LogEntriesRequest,
  ): Promise<GoogleAnswer<LogEntry[]>>;
  /**
   * Artifact Registry: every version of the image but the one tagged
   * `keepTag` deleted, with its tags; answers how many went.
   */
  deleteImageVersionsExcept(
    token: GoogleAccessToken,
    request: ImageVersionsRequest,
  ): Promise<GoogleAnswer<{ deleted: number }>>;
  /**
   * `tofu` init, `plan -destroy` and apply against a Google state through
   * the shared runner: everything the state holds is destroyed, from
   * a definition with no resource (`destroy-definition.ts`).
   */
  destroy(
    request: TofuApplyRequest<GoogleCredential>,
  ): Promise<TofuApplyOutcome>;
  /**
   * What a Google state holds, each resource's type, Google name, region
   * and labels only (as on AWS), through the shared runner: no
   * lock, nothing written. A state with no workspace yet holds nothing.
   */
  stateResources(
    request: TofuStateReadRequest<GoogleCredential>,
  ): Promise<TofuStateOutcome<GoogleStateResource>>;
  /**
   * Certificate Manager `certificates.get`: a Domain's certificate, which
   * the certificate poller asks about (S5).
   */
  certificate(
    token: GoogleAccessToken,
    certificate: GoogleCertificateRef,
  ): Promise<GoogleAnswer<GoogleCertificate>>;
  /**
   * Cloud SQL Admin `instances.patch` of Google's own deletion protection,
   * off (`settings.deletionProtectionEnabled`), waited on until done: a
   * Delete's first step. The provider's own flag is in the state,
   * which only an apply changes.
   */
  liftCloudSqlDeletionProtection(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud SQL Admin `instances.patch` of `settings.retainBackupsOnDelete`,
   * off, waited on until done: what a Delete that asked for the data to go
   * does instead of a backup, so every backup goes with the instance.
   */
  stopRetainingCloudSqlBackups(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud SQL Admin `backupRuns.insert`: one on-demand backup with this
   * description, waited on until Google has taken it. With
   * retained backups on delete it outlives the instance, kept until deleted.
   */
  takeCloudSqlBackup(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
    description: string,
  ): Promise<GoogleAnswer<TakenBackup>>;
  /**
   * Memorystore `instances.backup`: one on-demand backup with this id and no
   * TTL (Google keeps it 100 years), waited on until Google has taken it.
   * A backup outlives its instance.
   */
  takeMemorystoreBackup(
    token: GoogleAccessToken,
    instance: MemorystoreInstanceRef,
    backupId: string,
  ): Promise<GoogleAnswer<TakenBackup>>;
  /**
   * Compute Engine `disks.createSnapshot` of a Stack VM's data disk, kept
   * in its region, waited on until Google has taken it (#1367). A disk
   * Google does not have is its refusal, `NOT_FOUND`; a name already
   * taken, `ALREADY_EXISTS`.
   */
  takeDiskSnapshot(
    token: GoogleAccessToken,
    request: DiskSnapshotRequest,
  ): Promise<GoogleAnswer<TakenDiskSnapshot>>;
  /**
   * The names of the snapshots a snapshot schedule took of a disk
   * (`snapshots.list` by its source disk, `autoCreated` only): what a
   * Stack VM's Delete removes beside its state.
   */
  scheduledDiskSnapshots(
    token: GoogleAccessToken,
    disk: DiskRef,
  ): Promise<GoogleAnswer<string[]>>;
  /** Compute Engine `snapshots.delete`, waited on; one already gone answers `true` too. */
  deleteDiskSnapshot(
    token: GoogleAccessToken,
    snapshot: { readonly projectId: string; readonly name: string },
  ): Promise<GoogleAnswer<true>>;
  /**
   * The backups Cloud SQL holds of an instance: SQL Admin
   * `instances.get` for its retention, every page of `backupRuns.list`,
   * and `instances.getLatestRecoveryTime` for the window point-in-time
   * recovery reaches. A read for the Backups tab only. An instance it does
   * not have is its refusal, `NOT_FOUND`.
   */
  cloudSqlBackups(
    token: GoogleAccessToken,
    instance: GoogleDatabaseRef,
  ): Promise<GoogleAnswer<CloudSqlBackups>>;
  /**
   * The backups Memorystore holds of an instance: `instances.get`
   * for its retention and backup collection, and every page of that
   * collection's `backups.list`. A read for the Backups tab only. An
   * instance it does not have is its refusal, `NOT_FOUND`.
   */
  memorystoreBackups(
    token: GoogleAccessToken,
    instance: GoogleDatabaseRef,
  ): Promise<GoogleAnswer<MemorystoreBackups>>;
  /**
   * Cloud SQL Admin `instances.get`: an Existing database's lookup
   * on every plan. A missing instance answers `NOT_FOUND`; one Cloudgate's
   * service account may not read (an instance in another project with no
   * `roles/cloudsql.viewer` grant) answers `PERMISSION_DENIED`.
   */
  cloudSqlInstance(
    token: GoogleAccessToken,
    instance: ExistingCloudSqlRef,
  ): Promise<GoogleAnswer<CloudSqlInstanceRead>>;
  /**
   * Memorystore `instances.get` and its `getCertificateAuthority`:
   * an Existing database's lookup on every plan, and its registration
   * read. A name Memorystore for Valkey does not know is asked of
   * Memorystore for Redis (an instance, then a cluster) so the plan can say
   * "use Valkey"; one none of them knows answers `NOT_FOUND`, one
   * Cloudgate's service account may not read (an instance in another
   * project with no `roles/memorystore.viewer` grant) `PERMISSION_DENIED`.
   */
  memorystoreInstance(
    token: GoogleAccessToken,
    instance: ExistingValkeyRef,
  ): Promise<GoogleAnswer<MemorystoreInstanceRead>>;
  /**
   * Compute `forwardingRules.get` of a manual Private Service Connect
   * endpoint: its `pscConnectionStatus`
   * ({@link PscConnectionStatus}), which the Existing database's page
   * shows. One that is gone answers `NOT_FOUND`.
   */
  pscEndpointStatus(
    token: GoogleAccessToken,
    endpoint: PscEndpointRef,
  ): Promise<GoogleAnswer<PscConnectionStatus>>;
  /**
   * A DNS lookup from the platform host, as on AWS: only ever
   * informs a tick on a Domain's records, never blocks anything. A name
   * that answers nothing answers empty lists.
   */
  dnsLookup(name: string): Promise<DnsAnswer>;
  /**
   * Cloud Storage `objects.list`: under a prefix, every
   * page — a static site's Deployment folders, and what its `live/` folder
   * holds, each object with its MD5, so a copy skips what has not changed —
   * or at most `maxResults`, from one page, which a bucket's Delete asks
   * for one of, old versions included, to tell whether it holds files. A
   * bucket Google does not have is its refusal, `NOT_FOUND`.
   */
  listObjects(
    token: GoogleAccessToken,
    request: ObjectListRequest,
  ): Promise<GoogleAnswer<StoredObject[]>>;
  /**
   * Cloud Storage `buckets.get`: an existing bucket's lookup on
   * every plan, made with Cloudgate's own token. One Google does not have
   * answers `NOT_FOUND`; one Cloudgate's service account may not read (a
   * bucket in another project with no `roles/storage.legacyBucketReader`
   * grant) answers `PERMISSION_DENIED`.
   */
  storageBucket(
    token: GoogleAccessToken,
    bucket: string,
  ): Promise<GoogleAnswer<StorageBucketRead>>;
  /**
   * Cloud Storage `objects.insert` of one file on the platform host, with
   * the content type it is served with: a static site's upload.
   */
  uploadObject(
    token: GoogleAccessToken,
    request: ObjectUploadRequest,
  ): Promise<GoogleAnswer<StoredObject>>;
  /**
   * Cloud Storage `objects.rewrite` within one bucket, until done:
   * the server-side copy into a static site's `live/` folder, its content
   * type and MD5 kept. Nothing passes through the platform host.
   */
  copyObject(
    token: GoogleAccessToken,
    request: ObjectCopyRequest,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Storage `objects.delete`. One already gone answers
   * {@link NOT_FOUND}, which a caller deleting it reads as done.
   */
  deleteObject(
    token: GoogleAccessToken,
    object: ObjectRef,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Storage emptying a bucket: every page of `objects.list`,
   * then `objects.delete` of each object, one at a time. Cloudgate's
   * buckets keep no old versions and no soft-deleted copies, so the live
   * objects are all there is. An object already gone, or a bucket Google
   * does not have, counts as emptied, so running it again is safe. Answers
   * how many objects it deleted, or Google's refusal of the call that
   * stopped it, those it deleted until then being gone: an emptying that
   * stopped partway.
   */
  emptyBucket(
    token: GoogleAccessToken,
    bucket: string,
  ): Promise<GoogleAnswer<{ deleted: number }>>;
  /**
   * Cloud CDN `urlMaps.invalidateCache` for every path of one host, waited
   * on until done (about 2 s): a static site's Domain sees its new
   * version at once, and every other host on the map keeps its cache.
   */
  invalidateCache(
    token: GoogleAccessToken,
    request: CacheClearRequest,
  ): Promise<GoogleAnswer<true>>;

  // ── A hosted cloud build in Cloud Build (ADR-0047): direct calls,
  // never `tofu` (ADR-0030); OpenTofu makes only the source bucket.

  /**
   * Cloud Build `projects.locations.builds.create`: answers the build's id,
   * read off the long-running operation's metadata, once Google has taken it.
   */
  startCloudBuild(
    token: GoogleAccessToken,
    request: CloudBuildStartRequest,
  ): Promise<GoogleAnswer<{ buildId: string }>>;
  /** Cloud Build `projects.locations.builds.get`: where the build is. */
  cloudBuild(
    token: GoogleAccessToken,
    build: CloudBuildRef,
  ): Promise<GoogleAnswer<CloudBuildState>>;
  /**
   * Cloud Build `projects.locations.builds.cancel`; one already ended
   * answers `true` all the same.
   */
  cancelCloudBuild(
    token: GoogleAccessToken,
    build: CloudBuildRef,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Secret Manager: the secret made, its value added as its one version,
   * and the build identity made its one reader. Answers the
   * version's name, as a build's `availableSecrets` names it.
   */
  putBuildSecret(
    token: GoogleAccessToken,
    request: BuildSecretPut,
  ): Promise<GoogleAnswer<{ versionName: string }>>;
  /** Secret Manager `secrets.delete`, its versions with it; one already gone answers `true`. */
  deleteSecret(
    token: GoogleAccessToken,
    secret: SecretRef,
  ): Promise<GoogleAnswer<true>>;
  /**
   * Cloud Logging `entries.list` of one build's own lines (the `cloudbuild`
   * log of its `build` resource), oldest first, from a place on. An entry at
   * exactly the place's instant whose insert id it holds is left out.
   */
  cloudBuildLogEntries(
    token: GoogleAccessToken,
    request: CloudBuildLogRequest,
  ): Promise<GoogleAnswer<LogEntry[]>>;
  /**
   * The external-account credential configuration a Cloud run hands the
   * Google provider (the Google Cloud spec, S16): it trades the run's token at STS and
   * steps into the deploy service account, renewing its hourly access by
   * itself. Calls nothing; Google's endpoints are named here, beside the
   * calls that use them.
   */
  credentialConfiguration(
    request: CredentialConfigurationRequest,
  ): GoogleCredential;
  /**
   * Compute Engine `instances.stop` of a Stack VM: its disks stay, and only
   * they are billed while it is stopped. Answers once Google has taken it;
   * the operation it starts is Google's.
   */
  stopComputeInstance(
    token: GoogleAccessToken,
    instance: ComputeInstanceRef,
  ): Promise<GoogleAnswer<true>>;
  /** Compute Engine `instances.start` of a stopped Stack VM, answered as {@link stopComputeInstance} is. */
  startComputeInstance(
    token: GoogleAccessToken,
    instance: ComputeInstanceRef,
  ): Promise<GoogleAnswer<true>>;
  /** Compute Engine `instances.get` of a Stack VM: its `status` now. */
  computeInstanceStatus(
    token: GoogleAccessToken,
    instance: ComputeInstanceRef,
  ): Promise<GoogleAnswer<ComputeInstanceStatus>>;
}
