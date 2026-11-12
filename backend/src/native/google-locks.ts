import type { CloudSqlEngineName } from '../cloud-accounts/gcp/definitions/cloud-sql-engines';
import { CLOUD_SQL_SWITCHES } from '../cloud-accounts/gcp/definitions/cloud-sql-switches';
import type { PinnedProvider } from '../cloud-accounts/tofu/tofu-environment';
import type { ConfigKind } from '../project-config/planner/plan.types';

/**
 * **The Google Cloud Locked setting list** (ADR-0044 rules 2, 4, 7–9):
 * what a `native.gcp` block may name, which of each address's
 * provider arguments it may not set, and why, in one place. The twin of
 * `aws-locks.ts`.
 *
 * It is exactly the per-address list decided for Google Cloud, taken from the
 * definitions the Google builders write
 * (`backend/src/cloud-accounts/gcp/definitions/`). **A cloud is a
 * deny-list** (rule 8): every provider argument not named here is open.
 * Size-bearing arguments (Cloud SQL's `settings.tier`, Memorystore's
 * `node_type`, the Cloud Run container's `resources`) are open: native wins
 * over `size`.
 *
 * **One list, three readers.** The plan refuses a locked value
 * (`gcp-native.ts`, on every plan, whatever the Deploy target); the
 * console's save and the deploy read the same table once the per-kind
 * tickets lay native over a definition, so a value locked
 * here is locked on every path at once. Refused by path with its reason,
 * never stripped or written over (rule 9).
 *
 * **Reach may be narrowed, never widened**: a `web`'s
 * `ingress` is Cloudgate's `INGRESS_TRAFFIC_ALL` or
 * `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, which closes its `run.app`
 * address while its Domains still answer; a Private web service's stays
 * `INGRESS_TRAFFIC_INTERNAL_ONLY`. A value lock ({@link GcpValueLock}), not
 * a key lock: the argument is open within those values.
 *
 * Beyond that list, these entries carry its own rules onto arguments the
 * list did not spell out:
 *
 * - `region` beside `location` on every address (Cloud SQL and the NEG name
 *   theirs `region`), `id` (OpenTofu's, as on AWS), and `deletion_policy`
 *   on every address, the provider's own "what a destroy does", which is
 *   deletion protection by another name.
 * - Cloud SQL's `settings.activation_policy`, which the list has open but
 *   Cloudgate's own `ignore_changes` now holds for Stop and Start:
 *   point 5 ("everything in Cloudgate's own `ignore_changes` is locked")
 *   wins, so a native value is never accepted and then silently not
 *   applied. And `settings.retain_backups_on_delete`, how Delete's backup
 *   outlives the instance.
 * - The twins of a locked setting, which reach it as surely: Cloud SQL's
 *   `root_password_wo` and its `_version` beside `root_password`, and
 *   `point_in_time_restore_context` beside `clone` and
 *   `restore_backup_context`; Memorystore's `desired_psc_auto_connections`
 *   (the deprecated twin of `desired_auto_created_endpoints`), `server_ca_pool`
 *   beside `server_ca_mode`, `acl_policy` beside `authorization_mode`, and
 *   `gcs_source` and `managed_backup_source`, what it is made from; Cloud
 *   Run's `multi_region_settings`, where it runs, and
 *   `template.workload_identity_config`, who it runs as.
 * - A `web-private`'s three addresses (its repository, its account and its
 *   Cloud Run service, with no NEG or backend service), its
 *   `ingress` fixed at internal-only, held ahead of slice 8, which
 *   lays a Private web service's block; until then it is refused whole as
 *   not laid yet.
 *
 * **The census** (`test/coding-standards/native-lock-census.spec.ts`)
 * holds this table equal to what the Google definitions write, and classes
 * every argument of every address it may name, at every depth, locked here
 * or open in `google-open-settings.ts`. The addresses the list had no entry
 * for, and the arguments it did not spell out, are classed by ADR-0044's
 * five categories:
 *
 * - **A `worker`'s worker pool** takes the Cloud Run service's entries
 *   wherever the same setting exists, as the list says of slice 9's
 *   resources, with all of `scaling` locked (Cloudgate's own
 *   `ignore_changes` holds it whole for Stop and Start, which point 5
 *   makes locked) and `instance_splits` as `traffic`. Its container is
 *   written as one object, as the service's is
 *   ({@link GCP_CONTAINER_ADDRESSES}).
 * - **A `bucket`'s and a `static` site's Cloud Storage bucket** lock what
 *   AWS's twins lock: the name, `force_destroy`, uniform access and
 *   public access prevention (ACLs and Block Public Access on AWS), the
 *   bucket page's CORS, and what would outlive Delete (soft delete,
 *   versioning, retention and holds); their service
 *   account, key slots and grants are locked whole, and the backend
 *   bucket's name, bucket and scheme are the routing's.
 * - **An Existing database's endpoint** is how every linked
 *   Service reaches the database, in the Environment network: locked
 *   whole, and named only while the database is an Existing one
 *   ({@link GcpAddressEntry.existing}).
 * - **`tags` on every address**: Resource Manager tags, which IAM
 *   conditions and organization policies read, so a tag can widen who
 *   reaches a resource; ADR-0044 rule 7 locks `tags` everywhere. This
 *   settles the open question of Cloud Run's `tags`, and the backend services'
 *   `params.resource_manager_tags` with it.
 * - **Cloud SQL's `settings.data_api_access`**, which lets Google's
 *   `executeSql` API reach the database from outside the Environment
 *   network (category e), settling that open question; with it
 *   `settings.connector_enforcement`, which would refuse every linked
 *   Service's direct connection, the replication and replica settings
 *   (`instance_type`, `replica_names`, `replication_cluster`) and
 *   `backupdr_backup` as what it is made from,
 *   `enforce_new_sql_network_architecture` as the network's, and the final
 *   backup Delete takes (`final_backup_description`,
 *   `settings.final_backup_config`).
 * - A Cloud Run service's `template.sandboxes`, which run images beside the
 *   one Cloudgate built, as its container's `depends_on` would.
 * - The load balancer migration settings of a backend service
 *   (`external_managed_migration_*`), the routing's as its scheme is.
 *
 * A `mysql` is made by `postgres`'s Cloud SQL definition, so its
 * addresses are `postgres`'s entries, each naming both kinds. Each
 * engine's point-in-time recovery switch is open on its own kind and
 * refused by name on the other's ({@link GcpAddressEntry.refusedOn}).
 */

/** The location, the project and the mark: locked on every address. */
const LABELS = 'labels are how Cloudgate finds, marks and deletes what it made';
const LOCATION =
  "the region is the Environment's, the same for every resource it makes";

/** Locked on every address (ADR-0044 rule 7). */
export const GCP_LOCKED_EVERYWHERE: Readonly<Record<string, string>> = {
  location: LOCATION,
  region: LOCATION,
  project:
    "the project is the Cloud account's, where Cloudgate finds what it made",
  labels: LABELS,
  description:
    "the description carries Cloudgate's mark, which it finds what it made by",
  id: "the id is OpenTofu's for what Cloudgate made, never written",
  deletion_policy:
    "what a destroy does is Delete's, which asks before it deletes",
  tags: 'Resource Manager tags are read by IAM conditions and organization policies, so a tag can widen who reaches what Cloudgate made',
};

/**
 * The addresses made once per variable or once per Domain
 * (in the Environment network's state): refused whole, since they belong to
 * the Service's variables and Domains, not to the config.
 */
export const GCP_PER_INSTANCE: Readonly<Record<string, string>> = {
  'google_secret_manager_secret.variable':
    "made once per variable; a variable's value is set through the Service's variables",
  'google_secret_manager_secret_version.variable':
    "made once per variable; a variable's value is set through the Service's variables",
  'google_secret_manager_secret_iam_member.variable':
    "made once per variable; who reads a variable is the Service's own account, Cloudgate's",
  'google_certificate_manager_dns_authorization.domain':
    "made once per Domain; a Domain's certificate is set through the Service's Domains",
  'google_certificate_manager_certificate.domain':
    "made once per Domain; a Domain's certificate is set through the Service's Domains",
  'google_certificate_manager_certificate_map_entry.domain':
    "made once per Domain; a Domain's certificate is set through the Service's Domains",
  'google_compute_health_check.stack_vm':
    "made once per port a Stack VM's Domains reach; set through the stack's Domains",
  'google_compute_backend_service.stack_vm':
    "made once per port a Stack VM's Domains reach; set through the stack's Domains",
};

/**
 * What decides whether a Service makes an address **right now**, beyond its
 * kind. A fact only a Google Environment's saved Service knows is absent on
 * any other target, and an absent fact is never a reason to refuse.
 */
export interface GcpMadeFacts {
  /** It is an Existing database or an existing bucket, used as given (ADR-0033). */
  readonly existing?: boolean;
}

/**
 * A value lock: the argument is open, but only within `allowed` for the
 * entry's kind (reach may be narrowed, never widened).
 */
export interface GcpValueLock {
  readonly allowed: (kind: ConfigKind) => readonly string[];
  readonly reason: (kind: ConfigKind) => string;
}

/** One address a kind makes, with its locks. */
export interface GcpAddressEntry {
  /** The resource type, which picks its committed schema. */
  readonly type: string;
  /**
   * The provider its definition names, whose committed schema it is checked
   * against: `hashicorp/google` for every address (ADR-0030,
   * as amended). Operators never write it.
   */
  readonly provider: Extract<PinnedProvider, 'google'>;
  /** The kinds whose definition writes it. */
  readonly kinds: readonly ConfigKind[];
  /** Locked whole, with the reason: no argument of it may be set. */
  readonly whole?: string;
  /**
   * Locked arguments, each with its reason: a top-level argument by name,
   * one inside a block by its dotted path (`settings.ip_configuration`).
   */
  readonly locked?: Readonly<Record<string, string>>;
  /** Arguments open only within the values a kind allows, by name. */
  readonly limited?: Readonly<Record<string, GcpValueLock>>;
  /**
   * Arguments open on one kind and refused on another, by dotted path,
   * each with the reason it gives: another engine's switch on a kind made
   * by one definition. Read when checked, never at load.
   */
  readonly refusedOn?: (kind: ConfigKind) => Readonly<Record<string, string>>;
  /**
   * Whether an Existing database or an existing bucket makes it: `only`
   * (its endpoint), `also` (an existing bucket's own account and key), or,
   * left out, only what Cloudgate makes itself.
   */
  readonly existing?: 'only' | 'also';
}

/** The kinds whose Cloud Run resource is a service (`cloudRunResourceOf`). */
const CLOUD_RUN_SERVICE_KINDS = ['web', 'web-private'] as const;
/** The kinds made by the one Cloud Run builder, whatever their resource. */
const CLOUD_RUN_PIECE_KINDS = ['web', 'web-private', 'worker', 'cron'] as const;
/** The kinds Cloud SQL makes: a `postgres` and a `mysql`, by one definition. */
const DATABASE = ['postgres', 'mysql'] as const;

const IDENTITY = "Cloudgate's name for it, which it finds and deletes it by";
const RUNS_ARE_CLOUDGATES =
  "a run is started by Cloudgate's timetable, Run now or nothing: a token here would start one";
const ONE_RUN = 'a run is one task, one fresh container (ADR-0034)';
const NETWORK =
  "the Environment network's, shared with every other Service in it";
const RUNS_AS = 'who the Service runs as is Cloudgate’s';
const ROUTING =
  "the Service's routing from the Environment's load balancer is Cloudgate's";
const CONFIG_OWNS = (field: string) => `the config's ${field} sets it`;
const IGNORED = (by: string) => `Cloudgate sets this itself: ${by}`;
const GCP_TAGS =
  'Resource Manager tags are read by IAM conditions and organization policies, so a tag can widen who reaches what Cloudgate made';
const LOGIN =
  'the login is Cloudgate’s, which every linked Service is wired with';
const MADE_FROM = 'what the database is made from is Cloudgate’s';
/** A Compose stack's Stack VM (ADR-0070). */
const STACK_VM = ['compose'] as const;
const STACK_VM_NEVER_PUBLIC =
  'a Stack VM has no external IP; Cloudgate reaches it through IAP’s tunnel';
const STACK_VM_FIRST_BOOT =
  "its first boot installs Cloudgate's pinned Docker and mounts its data disk";
const MADE_FROM_STACK = "the data disk starts empty, Docker's volume folder";
const STACK_VM_DISK_REPLACE =
  'Google makes the data disk again for it, deleting every volume on it';

/**
 * Another engine's point-in-time recovery switch on a Cloud SQL instance
 * refused by name and pointing at the kind's own: the planner
 * reads only the kind's own switch, and the pinned provider refuses the
 * other's, so it would plan as unread and fail at `tofu plan`.
 */
function otherEnginesSwitch(kind: ConfigKind): Record<string, string> {
  const own = CLOUD_SQL_SWITCHES[kind as CloudSqlEngineName];
  const at = 'settings.backup_configuration';
  return Object.fromEntries(
    Object.values(CLOUD_SQL_SWITCHES)
      .filter((other) => other !== own)
      .map((other) => [
        `${at}.${other.pointInTimeRecoveryArgument}`,
        `${other.label}'s switch for point-in-time recovery, which a ${own.label} instance does not take; write ${at}.${own.pointInTimeRecoveryArgument}`,
      ]),
  );
}
const CACHE_TLS =
  'every linked Service is wired with its TLS and its CA (ADR-0042)';
const CACHE_REACH =
  'the cache is reached only from the Environment network, through its private link';
const OUTLIVES_DELETE =
  'a file kept by it would outlive Delete and bill, which empties the bucket it asked to';
const ENDPOINT =
  "an Existing database's endpoint in the Environment network is how every linked Service reaches it, Cloudgate's";
const BUCKET_KEY = "the bucket's own key is Cloudgate's, rotated by Rotate key";

/** Cloud Run's `ingress` values, as the provider spells them. */
export const INGRESS = {
  all: 'INGRESS_TRAFFIC_ALL',
  loadBalancer: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
  internal: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
} as const;

/**
 * **Reach may be narrowed, never widened**: a public `web`
 * may close its `run.app` address; a Private web service stays internal.
 */
const INGRESS_LOCK: GcpValueLock = {
  allowed: (kind) =>
    kind === 'web-private'
      ? [INGRESS.internal]
      : [INGRESS.all, INGRESS.loadBalancer],
  reason: (kind) =>
    kind === 'web-private'
      ? `a Private web service is reached only from inside its Environment, so its ingress stays ${INGRESS.internal}`
      : `a web's ingress is Cloudgate's ${INGRESS.all}, or ${INGRESS.loadBalancer} to close its run.app address while its Domains still answer; reach may be narrowed, never widened`,
};

/**
 * **Every address a Service makes on Google Cloud that `native.gcp` may
 * name, by kind, with its locks**. The census holds it
 * equal to what the definition builders write.
 */
export const GCP_ADDRESSES: Readonly<Record<string, GcpAddressEntry>> = {
  // ── A Cloud Run service: web and web-private ──
  'google_artifact_registry_repository.service': {
    type: 'google_artifact_registry_repository',
    provider: 'google',
    kinds: CLOUD_RUN_PIECE_KINDS,
    locked: {
      repository_id: IDENTITY,
      format: 'the Service’s images are Docker images, which Cloudgate builds',
      mode: 'the repository holds the images Cloudgate builds and pushes',
      remote_repository_config:
        'the repository holds the images Cloudgate builds and pushes',
      virtual_repository_config:
        'the repository holds the images Cloudgate builds and pushes',
      docker_config: IGNORED(
        'tags stay mutable so a deploy’s clean-up can remove old images',
      ),
    },
  },
  'google_service_account.service': {
    type: 'google_service_account',
    provider: 'google',
    kinds: CLOUD_RUN_PIECE_KINDS,
    whole: RUNS_AS,
  },
  'google_cloud_run_v2_service.service': {
    type: 'google_cloud_run_v2_service',
    provider: 'google',
    kinds: CLOUD_RUN_SERVICE_KINDS,
    locked: {
      name: IDENTITY,
      invoker_iam_disabled:
        "who may call the Service is Cloudgate's; its load balancer and Environment reach it",
      default_uri_disabled:
        "the run.app address is closed by ingress, which keeps the Environment's own calls working",
      deletion_protection: "Delete is Cloudgate's, and asks before it deletes",
      launch_stage: IGNORED('Stop moves it to BETA by a direct call'),
      scaling: IGNORED(
        'the copy count is Stop’s and Start’s, set outside the plan',
      ),
      client: IGNORED('the console and gcloud stamp it'),
      client_version: IGNORED('the console and gcloud stamp it'),
      traffic: 'every request goes to the Deployment Cloudgate made live',
      build_config: 'the image is the Deployment’s, which Cloudgate built',
      multi_region_settings: LOCATION,
      'template.service_account': RUNS_AS,
      'template.workload_identity_config': RUNS_AS,
      'template.vpc_access': NETWORK,
      'template.scaling': IGNORED(
        'the copy count is Stop’s and Start’s, set outside the plan',
      ),
      'template.labels': LABELS,
      'template.revision':
        "each revision is a Deployment's, which Cloudgate names",
      'template.sandboxes':
        'the Service runs one container, the image Cloudgate built',
    },
    limited: { ingress: INGRESS_LOCK },
  },
  'google_cloud_run_v2_worker_pool.service': {
    type: 'google_cloud_run_v2_worker_pool',
    provider: 'google',
    kinds: ['worker'],
    locked: {
      name: IDENTITY,
      deletion_protection: "Delete is Cloudgate's, and asks before it deletes",
      launch_stage: 'a worker pool is GA; the launch stage is Cloudgate’s',
      scaling: IGNORED(
        'the instance count is Stop’s and Start’s, set outside the plan',
      ),
      client: IGNORED('the console and gcloud stamp it'),
      client_version: IGNORED('the console and gcloud stamp it'),
      instance_splits: 'every instance runs the Deployment Cloudgate made live',
      'template.service_account': RUNS_AS,
      'template.vpc_access': NETWORK,
      'template.labels': LABELS,
      'template.revision':
        "each revision is a Deployment's, which Cloudgate names",
    },
  },
  // ── A Cron service's Cloud Run job ──
  'google_cloud_run_v2_job.service': {
    type: 'google_cloud_run_v2_job',
    provider: 'google',
    kinds: ['cron'],
    locked: {
      name: IDENTITY,
      deletion_protection: "Delete is Cloudgate's, and asks before it deletes",
      launch_stage: 'a job is GA; the launch stage is Cloudgate’s',
      client: IGNORED('the console and gcloud stamp it'),
      client_version: IGNORED('the console and gcloud stamp it'),
      run_execution_token: RUNS_ARE_CLOUDGATES,
      start_execution_token: RUNS_ARE_CLOUDGATES,
      'template.labels': LABELS,
      'template.task_count': ONE_RUN,
      'template.parallelism': ONE_RUN,
      'template.delay_execution':
        'a run starts when Cloudgate fires it, and its timeout counts from then; Google’s delayed start would run it up to 12 hours late',
      'template.template.max_retries':
        'a run is never retried (ADR-0034): a failed run waits for the next tick',
      'template.template.timeout':
        "a run's timeout is the config's, which Cloudgate cancels it at; the job's own is its 24h backstop",
      'template.template.service_account': RUNS_AS,
      'template.template.vpc_access': NETWORK,
    },
  },
  'google_compute_region_network_endpoint_group.service': {
    type: 'google_compute_region_network_endpoint_group',
    provider: 'google',
    kinds: ['web'],
    whole: ROUTING,
  },
  'google_compute_backend_service.service': {
    type: 'google_compute_backend_service',
    provider: 'google',
    kinds: ['web'],
    locked: {
      name: IDENTITY,
      protocol: ROUTING,
      load_balancing_scheme: ROUTING,
      backend: ROUTING,
      enable_cdn:
        'Cloud CDN waits for slice 7, which decides how a Service is cached',
      cdn_policy:
        'Cloud CDN waits for slice 7, which decides how a Service is cached',
      external_managed_migration_state: ROUTING,
      external_managed_migration_testing_percentage: ROUTING,
      params: GCP_TAGS,
    },
  },

  // ── postgres and mysql on Cloud SQL ──
  'google_sql_database_instance.database': {
    type: 'google_sql_database_instance',
    provider: 'google',
    kinds: DATABASE,
    refusedOn: otherEnginesSwitch,
    locked: {
      name: IDENTITY,
      database_version: CONFIG_OWNS('version'),
      deletion_protection:
        'Delete lifts deletion protection itself, as its first step',
      master_instance_name: MADE_FROM,
      replica_configuration: MADE_FROM,
      clone: MADE_FROM,
      restore_backup_context: MADE_FROM,
      point_in_time_restore_context: MADE_FROM,
      root_password: LOGIN,
      root_password_wo: LOGIN,
      root_password_wo_version: LOGIN,
      'settings.user_labels': LABELS,
      'settings.deletion_protection_enabled':
        'Delete lifts deletion protection itself, as its first step',
      'settings.retain_backups_on_delete':
        'the backup Delete takes outlives the instance through it',
      'settings.ip_configuration':
        'the host and ca Outputs, and who may reach the database, depend on it; only the Environment network reaches it',
      'settings.activation_policy': IGNORED(
        'Stop and Start set it by a direct call',
      ),
      'settings.data_api_access':
        "the data API reaches the database from outside the Environment network, through Google's API",
      'settings.connector_enforcement':
        'every linked Service connects directly, with its host and ca; requiring a connector would refuse them',
      instance_type: MADE_FROM,
      replica_names:
        'what the database replicates with reaches past its Service',
      replication_cluster:
        'what the database replicates with reaches past its Service',
      backupdr_backup: MADE_FROM,
      enforce_new_sql_network_architecture: NETWORK,
      final_backup_description:
        'the backup Delete takes is Delete’s, never Cloud SQL’s expiring final backup',
      'settings.final_backup_config':
        'the backup Delete takes is Delete’s, never Cloud SQL’s expiring final backup',
    },
  },
  'google_sql_database.database': {
    type: 'google_sql_database',
    provider: 'google',
    kinds: DATABASE,
    whole: `${CONFIG_OWNS('database')}, and every linked Service is wired with it`,
  },
  'google_sql_user.user': {
    type: 'google_sql_user',
    provider: 'google',
    kinds: DATABASE,
    whole: LOGIN,
  },

  // ── redis on Memorystore for Valkey ──
  'google_memorystore_instance.cache': {
    type: 'google_memorystore_instance',
    provider: 'google',
    kinds: ['redis'],
    locked: {
      instance_id: IDENTITY,
      mode: IGNORED('cluster mode is set at create and never changed'),
      shard_count: 'every linked Service is wired to one primary endpoint',
      engine_version: CONFIG_OWNS('version'),
      authorization_mode: IGNORED(
        'every linked Service is wired with no password (ADR-0042)',
      ),
      acl_policy: 'every linked Service is wired with no password (ADR-0042)',
      transit_encryption_mode: IGNORED(CACHE_TLS),
      server_ca_mode: IGNORED(CACHE_TLS),
      server_ca_pool: CACHE_TLS,
      deletion_protection_enabled:
        "Delete is Cloudgate's, and reclaims the cache (ADR-0018)",
      desired_auto_created_endpoints: CACHE_REACH,
      desired_psc_auto_connections: CACHE_REACH,
      cross_instance_replication_config:
        'what the cache replicates with reaches past its Service',
      gcs_source: 'what the cache is made from is Cloudgate’s',
      managed_backup_source: 'what the cache is made from is Cloudgate’s',
    },
  },

  // ── compose on its Stack VM (ADR-0070) ──
  'google_compute_instance.stack_vm': {
    type: 'google_compute_instance',
    provider: 'google',
    kinds: STACK_VM,
    locked: {
      name: IDENTITY,
      zone: 'the zone is recorded when it is made; its data disk is there',
      boot_disk:
        'the image it was made from is recorded; only an approved "replace VM" line moves it',
      attached_disk: "its data disk is Docker's volume folder, Cloudgate's",
      scratch_disk: "its data disk is Docker's volume folder, Cloudgate's",
      network_interface: `${STACK_VM_NEVER_PUBLIC}; ${NETWORK}`,
      can_ip_forward: STACK_VM_NEVER_PUBLIC,
      service_account: 'who the Stack VM runs as is Cloudgate’s',
      metadata: STACK_VM_FIRST_BOOT,
      metadata_startup_script: STACK_VM_FIRST_BOOT,
      desired_status: 'Stop and Start are Cloudgate’s',
      allow_stopping_for_update:
        'a new machine type stops and starts the Stack VM, as its plan line says',
      deletion_protection:
        "Delete is Cloudgate's, and reclaims the Stack VM (ADR-0018)",
      resource_policies:
        "the daily snapshots are its data disk's own schedule (ADR-0070)",
      params: GCP_TAGS,
    },
  },
  'google_compute_disk.data': {
    type: 'google_compute_disk',
    provider: 'google',
    kinds: STACK_VM,
    locked: {
      name: IDENTITY,
      zone: "it sits in its Stack VM's zone",
      size: 'the data disk starts at 20 GB and only grows, from the stack page',
      type: STACK_VM_DISK_REPLACE,
      image: MADE_FROM_STACK,
      snapshot: MADE_FROM_STACK,
      source_disk: MADE_FROM_STACK,
      source_instant_snapshot: MADE_FROM_STACK,
      source_storage_object: MADE_FROM_STACK,
      source_image_encryption_key: MADE_FROM_STACK,
      source_snapshot_encryption_key: MADE_FROM_STACK,
      disk_encryption_key: STACK_VM_DISK_REPLACE,
      architecture: STACK_VM_DISK_REPLACE,
      enable_confidential_compute: STACK_VM_DISK_REPLACE,
      guest_os_features: STACK_VM_DISK_REPLACE,
      licenses: STACK_VM_DISK_REPLACE,
      physical_block_size_bytes: STACK_VM_DISK_REPLACE,
      storage_pool: STACK_VM_DISK_REPLACE,
      access_mode: 'it is attached to its own Stack VM alone',
      async_primary_disk:
        'what the disk replicates with reaches past its stack',
      create_snapshot_before_destroy:
        "what a destroy keeps is Delete's, which asks before it deletes",
      create_snapshot_before_destroy_prefix:
        "what a destroy keeps is Delete's, which asks before it deletes",
      params: GCP_TAGS,
    },
  },
  'google_service_account.stack_vm': {
    type: 'google_service_account',
    provider: 'google',
    kinds: STACK_VM,
    whole: 'who the Stack VM runs as is Cloudgate’s',
  },
  'google_compute_firewall.iap': {
    type: 'google_compute_firewall',
    provider: 'google',
    kinds: STACK_VM,
    whole: `who may reach the Stack VM is Cloudgate's: IAP's tunnel, on SSH only`,
  },
  'google_compute_instance_group.stack_vm': {
    type: 'google_compute_instance_group',
    provider: 'google',
    kinds: STACK_VM,
    whole:
      "the Stack VM as the load balancer's backend, on its Domains' ports, is set through the stack's Domains",
  },
  'google_compute_firewall.load_balancer': {
    type: 'google_compute_firewall',
    provider: 'google',
    kinds: STACK_VM,
    whole: `who may reach the Stack VM is Cloudgate's: the load balancer, on its Domains' ports only`,
  },
  'google_compute_resource_policy.snapshots': {
    type: 'google_compute_resource_policy',
    provider: 'google',
    kinds: STACK_VM,
    whole: 'the data disk is snapshotted daily and each kept 7 days (ADR-0070)',
  },
  'google_compute_disk_resource_policy_attachment.snapshots': {
    type: 'google_compute_disk_resource_policy_attachment',
    provider: 'google',
    kinds: STACK_VM,
    whole: 'the data disk is snapshotted daily and each kept 7 days (ADR-0070)',
  },

  // ── An Existing database's endpoint ──
  ...Object.fromEntries(
    [
      'google_compute_address.endpoint',
      'google_compute_forwarding_rule.endpoint',
      'google_dns_managed_zone.instance',
      'google_dns_record_set.instance',
    ].map((address) => [address, existingEndpoint(address, DATABASE)]),
  ),
  ...Object.fromEntries(
    [
      'google_compute_address.primary',
      'google_compute_address.reader',
      'google_compute_forwarding_rule.primary',
      'google_compute_forwarding_rule.reader',
    ].map((address) => [address, existingEndpoint(address, ['redis'])]),
  ),

  // ── bucket on Cloud Storage ──
  'google_storage_bucket.bucket': storageBucket('bucket', {
    cors: "the trusted origins are the bucket page's",
  }),
  'google_storage_bucket_iam_member.object_user': {
    type: 'google_storage_bucket_iam_member',
    provider: 'google',
    kinds: ['bucket'],
    whole: "the bucket's key reaches it through this grant alone",
  },
  'google_service_account.bucket': {
    type: 'google_service_account',
    provider: 'google',
    kinds: ['bucket'],
    whole: BUCKET_KEY,
    existing: 'also',
  },
  'google_storage_hmac_key.key': {
    type: 'google_storage_hmac_key',
    provider: 'google',
    kinds: ['bucket'],
    whole: BUCKET_KEY,
    existing: 'also',
  },
  'google_storage_hmac_key.key_b': {
    type: 'google_storage_hmac_key',
    provider: 'google',
    kinds: ['bucket'],
    whole: BUCKET_KEY,
    existing: 'also',
  },

  // ── static on Cloud Storage and Cloud CDN ──
  'google_storage_bucket.site': storageBucket('static', {
    cors: 'the site is read through its load balancer, never by a browser from the bucket',
  }),
  'google_compute_backend_bucket.site': {
    type: 'google_compute_backend_bucket',
    provider: 'google',
    kinds: ['static'],
    locked: {
      name: IDENTITY,
      bucket_name: 'the site is served from its own bucket’s live folder',
      load_balancing_scheme: ROUTING,
      params: GCP_TAGS,
    },
  },
  'google_storage_bucket_iam_member.load_balancer': {
    type: 'google_storage_bucket_iam_member',
    provider: 'google',
    kinds: ['static'],
    whole: 'only the load balancer may read the site’s bucket',
  },
};

/** An Existing database's endpoint address, locked whole, made only for one. */
function existingEndpoint(
  address: string,
  kinds: readonly ConfigKind[],
): GcpAddressEntry {
  return {
    type: address.split('.')[0],
    provider: 'google',
    kinds,
    whole: ENDPOINT,
    existing: 'only',
  };
}

/**
 * A Cloud Storage bucket Cloudgate makes, a `bucket`'s or a `static` site's:
 * what AWS's twins lock, and what would outlive Delete.
 */
function storageBucket(
  kind: 'bucket' | 'static',
  own: Readonly<Record<string, string>>,
): GcpAddressEntry {
  return {
    type: 'google_storage_bucket',
    provider: 'google',
    kinds: [kind],
    locked: {
      name: IDENTITY,
      force_destroy:
        'a destroy never empties a bucket; Delete asks before it does',
      uniform_bucket_level_access:
        'IAM alone decides who reaches the bucket, never an object’s ACL',
      public_access_prevention: 'the bucket is never reachable from outside',
      custom_placement_config: LOCATION,
      requester_pays:
        'Cloudgate and every linked Service read the bucket as its owner',
      soft_delete_policy: OUTLIVES_DELETE,
      versioning: OUTLIVES_DELETE,
      retention_policy: OUTLIVES_DELETE,
      enable_object_retention: OUTLIVES_DELETE,
      default_event_based_hold: OUTLIVES_DELETE,
      ...own,
    },
  };
}

/**
 * **The Environment network's addresses**: in the
 * network's own state, which no config entry describes, so `native.gcp`
 * names none of them (ADR-0044 Consequences) and each is
 * refused whole with this reason. Its per-Domain addresses are
 * {@link GCP_PER_INSTANCE}'s. The census holds the list equal to what
 * `networkDefinition` writes.
 */
const ENVIRONMENT_NETWORK =
  'the Environment network has no native block: no config entry describes it, and every Service in the Environment shares it';

export const GCP_ENVIRONMENT_NETWORK: Readonly<Record<string, string>> =
  Object.fromEntries(
    [
      'google_compute_network.network',
      'google_compute_subnetwork.network',
      'google_compute_subnetwork.private_link',
      'google_compute_global_address.network',
      'google_certificate_manager_certificate_map.network',
      'google_certificate_manager_certificate.default',
      'google_certificate_manager_certificate_map_entry.default',
      'google_compute_url_map.network',
      'google_compute_url_map.redirect',
      'google_network_connectivity_service_connection_policy.cloud_sql',
      'google_network_connectivity_service_connection_policy.memorystore',
      'google_compute_firewall.redis_ports',
      // The private `run.app` zone of its Private web services.
      'google_dns_managed_zone.run_app',
      'google_dns_record_set.run_app',
      'google_dns_record_set.run_app_wildcard',
      // The Cloud NAT of its Stack VMs.
      'google_compute_router.nat',
      'google_compute_router_nat.nat',
      'google_compute_target_https_proxy.network',
      'google_compute_target_http_proxy.network',
      'google_compute_global_forwarding_rule.https',
      'google_compute_global_forwarding_rule.http',
      // A hosted cloud build's source bucket, on the Hosted
      // instance only.
      'google_storage_bucket.build_source',
    ].map((address) => [address, ENVIRONMENT_NETWORK]),
  );

/**
 * **What `native.gcp` names on each kind** (ADR-0044 rule 11): one
 * entry per kind the config describes, the census's record that each was
 * looked at. The addresses themselves are {@link GCP_ADDRESSES}'.
 */
export const GCP_KIND_ENTRIES: Readonly<Record<ConfigKind, string>> = {
  web: 'its Cloud Run service, repository and account, and the NEG and backend service its Domains are routed to; its secrets are refused whole',
  'web-private':
    'its internal-only Cloud Run service, repository and account, with no NEG or backend service; its ingress stays internal; its secrets are refused whole; not laid until slice 8',
  worker:
    'its Cloud Run worker pool, repository and account; its secrets are refused whole',
  cron: 'its Cloud Run job, repository and account; one task, never retried, and its runs are Cloudgate’s; its secrets are refused whole',
  postgres:
    "its Cloud SQL instance, with its database and user locked whole; an Existing database's endpoint is locked whole",
  mysql:
    "its Cloud SQL instance, postgres's entries, with its database and user locked whole; an Existing database's endpoint is locked whole",
  redis:
    "its Memorystore instance; an Existing database's endpoint is locked whole",
  bucket:
    'its Cloud Storage bucket; its grant, account and key slots are locked whole, and an existing bucket makes only its account and key',
  static:
    "its site's Cloud Storage bucket and Cloud CDN backend bucket; the load balancer's grant is locked whole",
  compose:
    "its Stack VM's instance and data disk (ADR-0070): the machine type is open, what reaches it and what it boots are locked; its service account, firewall rule and snapshot schedule are locked whole",
};

/**
 * **The kinds Google Cloud makes whose definition does not lay `native.gcp`
 * yet**, each with why: a `web`'s, a `postgres`'s and a `redis`'s are
 * laid, and the native settings spec lays none of these. Their addresses stay
 * classed above, so the census holds them, but a block naming one is
 * refused on every plan, whatever the target, rather than accepted and
 * then silently not applied (ADR-0044 rule 9). `gcp-lay.ts` holds the kinds
 * that are laid; a test holds the two equal to the kinds Google Cloud makes.
 */
export const GCP_NOT_LAID: Readonly<Partial<Record<ConfigKind, string>>> = {
  'web-private':
    'a Private web service’s Cloud Run service does not lay native.gcp yet, so nothing set here would reach it',
  worker:
    'a worker’s Cloud Run worker pool does not lay native.gcp yet, so nothing set here would reach it',
  cron: 'a cron’s Cloud Run job does not lay native.gcp yet, so nothing set here would reach it',
  bucket:
    'a bucket’s Cloud Storage definition does not lay native.gcp yet, so nothing set here would reach it',
  static:
    'a static site’s Cloud Storage and Cloud CDN definition does not lay native.gcp yet, so nothing set here would reach it',
};

/**
 * The one container a Cloud Run Service runs: `template.containers` written as
 * **one object** in the provider's spelling, merged into Cloudgate's
 * container. These keys Cloudgate depends on, or the config already owns.
 * Every other argument of it is open (`resources`, the probes,
 * `working_dir`, `volume_mounts`, …).
 */
export const GCP_CONTAINER_LOCKS: Readonly<Record<string, string>> = {
  name: 'Cloudgate reads the container and its logs by this name',
  image: "the image is the Deployment's, which Cloudgate built",
  ports: CONFIG_OWNS('port'),
  env: CONFIG_OWNS('env'),
  command: CONFIG_OWNS('command'),
  args: CONFIG_OWNS('args'),
  depends_on: 'the Service runs one container, Cloudgate’s',
};

/** The address of the Cloud Run container, and where in it the file writes it. */
export const GCP_CONTAINER_ADDRESS = 'google_cloud_run_v2_service.service';

/**
 * Every address whose one container is written as one object at
 * {@link GCP_CONTAINER_PATH}: a Cloud Run service's and a worker pool's
 * (slice 9's resources take the service's entries).
 */
export const GCP_CONTAINER_ADDRESSES: readonly string[] = [
  GCP_CONTAINER_ADDRESS,
  'google_cloud_run_v2_worker_pool.service',
];
export const GCP_CONTAINER_PATH: readonly string[] = ['template', 'containers'];

/**
 * A Cron service's job's one container, a level deeper: a job's
 * `template` holds the task's. Its keys are {@link GCP_CONTAINER_LOCKS}.
 */
export const GCP_JOB_CONTAINER = {
  address: 'google_cloud_run_v2_job.service',
  at: ['template', 'template', 'containers'],
} as const;

/**
 * **What a native change may never replace**: each
 * address holding data, with what its replace loses, as AWS's
 * `AWS_DATA_HOLDING` is. The plan refuses any native change OpenTofu would
 * carry out as a replace of one, naming the path, read from the cloud
 * plan's actions by the one rule every cloud shares (`replaceRefusals` in
 * `lay.ts`, through `nativeGcpReplaceRefusals`): a postgres's Cloud SQL
 * instance and a redis's Memorystore instance.
 */
export const GCP_DATA_HOLDING: Readonly<Record<string, string>> = {
  'google_sql_database_instance.database':
    'the Cloud SQL instance for it, deleting the data it holds (set it back, or move the data to a new Service yourself)',
  'google_memorystore_instance.cache':
    'the Memorystore instance for it, deleting the data it holds (set it back, or move the data to a new Service yourself)',
  'google_compute_disk.data':
    "the Stack VM's data disk for it, deleting every volume on it (set it back, or move the data to a new Service yourself)",
};
