/**
 * The custom role the deploy service account holds on the project (the Google
 * Cloud spec, "One custom role, versioned like the AWS policy"). One
 * table, by version, feeds both the role definition the setup script makes
 * and the connect check's `testIamPermissions`, so what the operator grants
 * is exactly what Cloudgate tests.
 *
 * **Versions are append-only.** A shipped version is never edited: "permissions
 * out of date" compares a Cloud account's checked version with the current
 * one by subtracting their lists, which is exact only if neither
 * changes. A new need is a new version. Google's predefined roles are not
 * used: they over-grant.
 */

import { CLOUD_BUILD_API } from './cloud-build-names';
import type { InstanceMode } from '../../instance-mode/instance-mode.service';

/**
 * The newest role version this Cloudgate knows: the one the Hosted instance
 * generates and checks against.
 */
export const GOOGLE_ROLE_VERSION = 8;

/**
 * The version a Self-hosted instance generates and checks against (ADR-0047):
 * version 6 adds only what a hosted cloud build needs, and a
 * Self-hosted instance builds on its platform host, so its Cloud accounts are
 * never asked to re-run setup for it. So the versions fork: what both
 * instances need later is added twice, as a Self-hosted version over 5 and
 * a Hosted one over 6 — Stack VMs (ADR-0070) as 7 and 8.
 */
export const SELF_HOSTED_GOOGLE_ROLE_VERSION = 7;

/** The version an instance in this mode generates and checks against. */
export function googleRoleVersion(hosted: boolean): number {
  return hosted ? GOOGLE_ROLE_VERSION : SELF_HOSTED_GOOGLE_ROLE_VERSION;
}

/**
 * The first version whose setup script makes the build identity, as a
 * refusal names it. Version 7 does not: ask {@link makesBuildIdentity}.
 */
export const BUILD_IDENTITY_FROM = 6;

/** One group of a version's permissions, named for a reader of the role. */
interface PermissionGroup {
  readonly group: string;
  readonly permissions: readonly string[];
}

/** `<prefix>.<verb>` for each verb. */
const each = (prefix: string, verbs: readonly string[]) =>
  verbs.map((verb) => `${prefix}.${verb}`);

const CRUD = ['create', 'get', 'list', 'update', 'delete'] as const;

const VERSION_1: readonly PermissionGroup[] = [
  {
    group: 'Cloud Run',
    permissions: [
      // `setIamPolicy` for the invoker check: a public web turns it off
      // rather than granting allUsers.
      ...each('run.services', [...CRUD, 'setIamPolicy', 'getIamPolicy']),
      ...each('run.revisions', ['get', 'list', 'delete']),
      'run.operations.get',
      'run.locations.list',
    ],
  },
  {
    group: 'Artifact Registry',
    permissions: [
      ...each('artifactregistry.repositories', [
        ...CRUD,
        'uploadArtifacts',
        'downloadArtifacts',
      ]),
      ...each('artifactregistry.versions', ['list', 'delete']),
      ...each('artifactregistry.tags', ['list', 'delete']),
      'artifactregistry.locations.list',
    ],
  },
  {
    group: 'Compute',
    permissions: [
      ...each('compute.networks', CRUD),
      ...each('compute.subnetworks', [...CRUD, 'use']),
      // The kinds that take labels set them (S5).
      ...each('compute.globalAddresses', [
        'create',
        'get',
        'list',
        'delete',
        'use',
        'setLabels',
      ]),
      ...each('compute.globalForwardingRules', [...CRUD, 'setTarget']),
      ...each('compute.targetHttpsProxies', [
        ...CRUD,
        'use',
        'setUrlMap',
        'setCertificateMap',
      ]),
      ...each('compute.targetHttpProxies', [...CRUD, 'use', 'setUrlMap']),
      ...each('compute.urlMaps', [...CRUD, 'use']),
      ...each('compute.backendServices', [...CRUD, 'use']),
      ...each('compute.regionNetworkEndpointGroups', [
        'create',
        'get',
        'list',
        'delete',
        'use',
      ]),
      'compute.globalOperations.get',
      'compute.regionOperations.get',
    ],
  },
  {
    group: 'Certificate Manager',
    permissions: [
      ...each('certificatemanager.certs', [...CRUD, 'use']),
      ...each('certificatemanager.certmaps', [...CRUD, 'use']),
      ...each('certificatemanager.certmapentries', CRUD),
      ...each('certificatemanager.dnsauthorizations', [...CRUD, 'use']),
      'certificatemanager.operations.get',
    ],
  },
  {
    group: 'IAM',
    // Each Service has a service account of its own (ADR-0032), so the role
    // makes them and acts as them — any in the project, which is why the
    // setup page asks for a project of Cloudgate's own.
    permissions: each('iam.serviceAccounts', [...CRUD, 'actAs']),
  },
  {
    group: 'Secret Manager',
    permissions: [
      ...each('secretmanager.secrets', [
        ...CRUD,
        'getIamPolicy',
        'setIamPolicy',
      ]),
      ...each('secretmanager.versions', [
        'add',
        'get',
        'list',
        'access',
        'enable',
        'disable',
        'destroy',
      ]),
    ],
  },
  { group: 'Logging', permissions: ['logging.logEntries.list'] },
  {
    group: 'Resource Manager and Service Usage',
    permissions: ['resourcemanager.projects.get', 'serviceusage.services.list'],
  },
];

/**
 * The APIs a version needs on, which the operator turns on in the setup
 * script (S1, S2). **Cloudgate never turns on an API.**
 */
const APIS_1: readonly string[] = [
  'run.googleapis.com',
  'artifactregistry.googleapis.com',
  'compute.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'serviceusage.googleapis.com',
  'logging.googleapis.com',
  'certificatemanager.googleapis.com',
  'secretmanager.googleapis.com',
];

/**
 * What version 2 adds (slice 7, the Google Cloud databases spec): a `postgres` on Cloud SQL
 * a `redis` on Memorystore for Valkey, and the Environment
 * network's private link both attach through. Each permission is one the
 * definitions' resources or the port's calls use:
 *
 * - **Cloud SQL**: `google_sql_database_instance`, `google_sql_database` and
 *   `google_sql_user` (the instance's own CA is read with `get`, its
 *   operations too), and the port's search by name (`list`).
 * - **Network Connectivity**: the private link's service connection policy
 *   per kind and its operations.
 * - **Compute**: Memorystore's firewall rule for Redis's ports; a rule on a
 *   network also needs `networks.updatePolicy`. The link's subnet is
 *   version 1's `subnetworks`.
 * - **Memorystore**: `google_memorystore_instance` and its operations, and
 *   the port's search by name. Nothing reads a token: the walk
 *   found `memorystore.authTokens.list` is not a permission a custom role
 *   may hold, nor does any predefined role, so the instance has no password
 *   (ADR-0042).
 *
 * - **Compute label search**: the label search after an Environment's
 *   Delete lists addresses and forwarding rules in every region by
 *   Cloudgate's label, so a Private Service Connect address Google still
 *   lists is named.
 *
 * Google itself makes each instance's address on the link's subnet, its
 * forwarding rule and Cloud SQL's private DNS zone, through its own service
 * agents, so the role makes no address, forwarding rule or DNS zone and
 * needs only those two lists; the APIs below must be on for Google to.
 */
const VERSION_2: readonly PermissionGroup[] = [
  ...VERSION_1,
  {
    group: 'Cloud SQL',
    permissions: [
      ...each('cloudsql.instances', CRUD),
      ...each('cloudsql.databases', CRUD),
      ...each('cloudsql.users', CRUD),
    ],
  },
  {
    group: 'Network Connectivity',
    permissions: [
      ...each('networkconnectivity.serviceConnectionPolicies', CRUD),
      'networkconnectivity.operations.get',
    ],
  },
  {
    group: 'Compute firewall',
    permissions: [
      ...each('compute.firewalls', CRUD),
      'compute.networks.updatePolicy',
    ],
  },
  {
    group: 'Compute label search',
    permissions: ['compute.addresses.list', 'compute.forwardingRules.list'],
  },
  {
    group: 'Memorystore',
    permissions: [
      ...each('memorystore.instances', CRUD),
      'memorystore.operations.get',
    ],
  },
];

/**
 * Version 2's APIs (the Google Cloud databases spec): Cloud SQL Admin and Memorystore, Network
 * Connectivity for the private link's policies, and the three Google's own
 * Private Service Connect set-up uses: Service Networking and Cloud DNS for
 * Cloud SQL's, Service Consumer Management for Memorystore's.
 */
const APIS_2: readonly string[] = [
  ...APIS_1,
  'sqladmin.googleapis.com',
  'servicenetworking.googleapis.com',
  'networkconnectivity.googleapis.com',
  'dns.googleapis.com',
  'memorystore.googleapis.com',
  'serviceconsumermanagement.googleapis.com',
];

/**
 * What version 3 adds (slice 7, the Google Cloud buckets spec): a `bucket` on Cloud Storage
 * reached through its own service account's HMAC key (ADR-0032 as amended).
 * Each permission is one the bucket definition's
 * resources or the port's calls use:
 *
 * - **Cloud Storage buckets**: `google_storage_bucket` (made, read, changed
 *   and deleted), the port's search by name (`list`), and
 *   `google_storage_bucket_iam_member`, which binds the bucket's own service
 *   account on that one bucket (`getIamPolicy`, `setIamPolicy`).
 * - **HMAC keys**: `google_storage_hmac_key`, whose permissions are
 *   `roles/storage.hmacKeyAdmin`'s, which `roles/storage.admin` does not
 *   hold.
 * - **Cloud Storage objects**: a bucket's Delete lists one object
 *   to tell whether it holds files (`list`), and "also delete its files"
 *   has the provider's `force_destroy` delete each one (`delete`).
 *
 * Making the bucket's own service account is version 1's
 * `iam.serviceAccounts`, which every Service's own account already needs.
 *
 * An **existing bucket** needs nothing more: its account and key are
 * the above, and the bucket itself is only read (`storage.buckets.get`); in
 * another project the operator grants `roles/storage.legacyBucketReader` on
 * it, and its key's access is the operator's grant, never the role's.
 *
 * It also adds an **Existing database** that is a Cloud SQL
 * `postgres` made outside Cloudgate, reached through Cloudgate's own manual
 * Private Service Connect endpoint and a private DNS zone for the
 * instance's own name (ADR-0033 as amended).
 * Unlike version 2's instances, whose address, forwarding rule and zone
 * Google's own service agents make, these are Cloudgate's, made by the
 * role:
 *
 * - **Compute endpoint**: the endpoint's internal address on the private
 *   link subnet (`createInternal`, `useInternal`, and its labels) and its
 *   forwarding rule to the instance's service attachment (the `psc` verbs
 *   Google checks for a rule whose target is one, and its labels). A rule
 *   on the network needs `networks.use`.
 * - **Cloud DNS**: the private zone, its binding to the Environment network
 *   (`networks.bindPrivateDNSZone`), and its A record, each record change a
 *   `changes.create` read back with `changes.get`.
 *
 * These were taken from Google's IAM and Cloud DNS access-control pages
 * and not yet tried with Cloudgate's role:
 * the walk by hand proves them. The instance itself is only read
 * (`cloudsql.instances.get`, version 2's); in another project the operator
 * grants `roles/cloudsql.viewer` there.
 *
 * - **Final backups**: a Google database's Delete takes one
 *   on-demand backup just before the destroy — a Cloud SQL backup run, a
 *   Memorystore instance's backup — and reads it back for its kept list;
 *   the Backups tab lists both live.
 * - **Static site**: a static site's backend bucket and its files.
 * - **Existing Valkey**: an existing Memorystore for Valkey
 *   `redis`'s two manual endpoints are the "Compute endpoint" group's; its
 *   lookup reads the instance and its CA (`getCertificateAuthority`, which
 *   Google gates on version 2's `memorystore.instances.get`: there is no
 *   permission of its own), and asks Memorystore for Redis
 *   whether the name is one of its instances or clusters, so the plan can
 *   say "use Valkey". In another project the operator grants
 *   `roles/memorystore.viewer` there.
 *
 * These tickets landed in this one version rather than one each.
 */
const VERSION_3: readonly PermissionGroup[] = [
  ...VERSION_2,
  {
    group: 'Cloud Storage buckets',
    permissions: each('storage.buckets', [
      ...CRUD,
      'getIamPolicy',
      'setIamPolicy',
    ]),
  },
  {
    group: 'Cloud Storage HMAC keys',
    permissions: each('storage.hmacKeys', CRUD),
  },
  {
    group: 'Compute endpoint',
    permissions: [
      ...each('compute.addresses', [
        'create',
        'createInternal',
        'get',
        'delete',
        'deleteInternal',
        'use',
        'useInternal',
        'setLabels',
      ]),
      ...each('compute.forwardingRules', [
        'create',
        'get',
        'delete',
        'setLabels',
        'pscCreate',
        'pscDelete',
        'pscSetLabels',
        'pscUpdate',
      ]),
      'compute.networks.use',
    ],
  },
  {
    group: 'Cloud DNS',
    permissions: [
      ...each('dns.managedZones', CRUD),
      'dns.networks.bindPrivateDNSZone',
      ...each('dns.resourceRecordSets', CRUD),
      'dns.changes.create',
      'dns.changes.get',
    ],
  },
  {
    // A Google database's Delete keeps a final backup: Cloud SQL's
    // on-demand backup run, and Memorystore's on-demand backup, read back
    // from its backup collection for the Delete's kept list. The Backups
    // tab reads them live: Cloud SQL's backup runs listed, and
    // Memorystore's collection and its backups. Its latest recovery time
    // (`instances.getLatestRecoveryTime`) names no permission of its own
    // on Google's pages; it is taken to be `cloudsql.instances.get`,
    // version 2's, which the walk checks.
    group: 'Backups',
    permissions: [
      ...each('cloudsql.backupRuns', ['create', 'get', 'list']),
      'memorystore.instances.backup',
      ...each('memorystore.backups', ['get', 'list']),
      ...each('memorystore.backupCollections', ['get', 'list']),
    ],
  },
  {
    // An existing Valkey's lookup: whether the name is Memorystore
    // for Redis's instead. Without the Redis API on, that read answers
    // nothing and the name is "not found", never a failed plan. Its CA needs
    // no permission here: Google has no
    // `memorystore.instances.getCertificateAuthority`, and a custom role
    // naming it is refused at create (the Google acceptance walk).
    group: 'Existing Valkey',
    permissions: ['redis.instances.get', 'redis.clusters.get'],
  },
  {
    // A static site on Cloud Storage behind Cloud CDN: its backend
    // bucket on the load balancer, and the site's files uploaded, copied
    // into `live/` and deleted. The bucket's IAM is the bucket definition's. A bucket's
    // Delete lists one of its objects to tell whether it holds
    // files, and "also delete its files" (force_destroy) deletes them.
    // A deploy clears each of the site's Domains' cache on the network's
    // URL map.
    group: 'Static site',
    permissions: [
      ...each('compute.backendBuckets', [...CRUD, 'use']),
      ...each('storage.objects', ['create', 'get', 'list', 'delete']),
      'compute.urlMaps.invalidateCache',
    ],
  },
];

/**
 * Version 3's APIs: Cloud Storage's, for the bucket and its key.
 * The existing Cloud SQL's endpoint and zone need none new: Cloud
 * DNS is version 2's.
 */
const APIS_3: readonly string[] = [...APIS_2, 'storage.googleapis.com'];

/**
 * What version 4 adds (the Google Cloud kinds spec), made once for
 * all of that spec's kinds on Google Cloud. It was planned as "version 3";
 * the buckets spec took 3 first, and the kinds spec's rule is that whichever
 * lands second takes the next number. Each permission is one a definition's resources or the
 * port's calls use:
 *
 * - **Cloud Run worker pools**: a Worker's `google_cloud_run_v2_worker_pool`
 *   and its Stop / Start by instance count (`run.workerpools.*`, written
 *   out as Google's Cloud Run permission page lists it, since a custom role
 *   holds no wildcard). Its revisions are version 1's `run.revisions`.
 * - **Cloud Run jobs and executions**: a Cron service's
 *   `google_cloud_run_v2_job`, each run started with `jobs.run`, watched
 *   with `executions.get`, its container's exit code read from its task
 *   (`run.tasks.get` and `list`; story 41), and cancelled at `timeout` with
 *   `executions.cancel`. No `run.jobs.runWithOverrides`: Cloudgate passes
 *   no overrides.
 * - **Cloud DNS**: the Environment network's private `run.app` zone for
 *   Private web services, its network binding and its records
 *   (`dns.managedZones.*` and `dns.resourceRecordSets.*` written out from
 *   Google's Cloud DNS access-control page). Version 3 already holds all of
 *   them but the zone's IAM policy pair, for an Existing database's zone
 * they are listed here again so this version says what it needs,
 *   and `requiredPermissions` names each once.
 *
 * Apply, Run now and Cancel need no new Cloudgate permission (story 72).
 */
const VERSION_4: readonly PermissionGroup[] = [
  ...VERSION_3,
  {
    group: 'Cloud Run worker pools',
    permissions: each('run.workerpools', [
      ...CRUD,
      'getIamPolicy',
      'setIamPolicy',
    ]),
  },
  {
    group: 'Cloud Run jobs and executions',
    permissions: [
      ...each('run.jobs', [...CRUD, 'run']),
      ...each('run.executions', ['get', 'list', 'cancel', 'delete']),
      ...each('run.tasks', ['get', 'list']),
    ],
  },
  {
    group: 'Cloud DNS run.app zone',
    permissions: [
      ...each('dns.managedZones', [...CRUD, 'getIamPolicy', 'setIamPolicy']),
      'dns.changes.create',
      'dns.changes.get',
      ...each('dns.resourceRecordSets', CRUD),
      'dns.networks.bindPrivateDNSZone',
    ],
  },
];

/**
 * Version 4's APIs are version 3's: Cloud Run's is version 1's and Cloud
 * DNS's version 2's.
 */
const APIS_4: readonly string[] = APIS_3;

/**
 * What version 5 adds: the Service Directory registration
 * Google makes for an Existing database's PSC endpoint. Creating the
 * forwarding rule registers it in the `goog-psc-default` namespace, as the
 * caller, and version 4 was refused there with PERMISSION_DENIED naming
 * `servicedirectory.services.create` and `servicedirectory.namespaces.create`
 * (`no_automate_dns_zone` on the rule did not avoid it). The existing
 * Cloud SQL postgres, mysql and Valkey endpoints all
 * take this path. Deleting the rule removes its service, so
 * `services.delete` and `services.get` are held too; the re-walk measures
 * whether each is used.
 */
const VERSION_5: readonly PermissionGroup[] = [
  ...VERSION_4,
  {
    group: 'Service Directory registration of a PSC endpoint',
    permissions: [
      'servicedirectory.namespaces.create',
      'servicedirectory.namespaces.get',
      ...each('servicedirectory.services', ['create', 'get', 'delete']),
    ],
  },
];

/**
 * Version 5's APIs are version 4's: the registration was refused for a
 * permission, not for the API, so Service Directory's API is on wherever a
 * PSC endpoint is made.
 */
const APIS_5: readonly string[] = APIS_4;

/**
 * What version 6 adds (ADR-0047): a hosted cloud build, in Cloud
 * Build in the customer's project. Starting one (`create`), watching
 * it (`get`, and `list` to find a build by its tags after a restart) and
 * cancelling it (`update`, which is what `builds.cancel` checks), and
 * nothing else. The build runs as the Cloud account's build identity, which
 * the setup script makes (`cloud-build-names.ts`): acting as it is version
 * 1's `iam.serviceAccounts.actAs`, uploading its source zip and the source
 * bucket itself version 3's Cloud Storage groups, and reading its log
 * version 1's `logging.logEntries.list`. On the Hosted instance only
 * ({@link googleRoleVersion}).
 */
const VERSION_6: readonly PermissionGroup[] = [
  ...VERSION_5,
  {
    group: 'Cloud Build',
    permissions: each('cloudbuild.builds', ['create', 'get', 'list', 'update']),
  },
];

/** Version 6's APIs: Cloud Build's, which the builds are started through. */
const APIS_6: readonly string[] = [...APIS_5, CLOUD_BUILD_API];

/**
 * What a Compose stack's **Stack VM** needs (ADR-0070,
 * `stack-vm-definition.ts`), on both instances alike. Each permission is
 * one the definition's resources, the network's Cloud NAT or the tunnel
 * uses:
 *
 * - **Compute instance**: the Stack VM itself, made, read, stopped,
 *   started, resized (`setMachineType`, which needs it stopped), its
 *   metadata (cloud-init, the tunnel's SSH key), labels, scheduling and
 *   service account set, its data disk attached and detached; `use` for
 *   the tunnel's connection to it. Its zone's operations, which every
 *   zonal call answers with.
 * - **Compute disks**: the data disk, made, read, grown, labelled, used by
 *   the instance, given and relieved of its snapshot schedule, and
 *   snapshotted for a Delete's final snapshot; the boot disk the instance
 *   makes from the public Ubuntu image.
 * - **Snapshot schedule**: the `google_compute_resource_policy`, and the
 *   snapshots it and a Delete take, read back for the kept list.
 * - **Cloud Router and Cloud NAT**: the Environment network's way out,
 *   added with its first Stack VM; a NAT is a part of its router, so
 *   `routers.update` makes and removes it.
 * - **IAP tunnelling**: Cloudgate reaches the Stack VM through IAP's TCP
 *   forwarding (`tunnelInstances.accessViaIAP`), with SSH inside.
 *
 * Its own service account and its firewall rule are version 1's
 * `iam.serviceAccounts` and version 2's `compute.firewalls`. Scoped as
 * every permission of the role is: to the project, which is Cloudgate's
 * own (ADR-0041); a custom role holds no condition.
 */
const STACK_VMS: PermissionGroup = {
  group: 'Stack VMs',
  permissions: [
    ...each('compute.instances', [
      'create',
      'get',
      'list',
      'delete',
      'start',
      'stop',
      'reset',
      'update',
      'use',
      'setMachineType',
      'setMetadata',
      'setLabels',
      'setScheduling',
      'setServiceAccount',
      'attachDisk',
      'detachDisk',
    ]),
    'compute.zoneOperations.get',
    'compute.machineTypes.get',
    ...each('compute.disks', [
      'create',
      'get',
      'list',
      'delete',
      'resize',
      'use',
      'setLabels',
      'addResourcePolicies',
      'removeResourcePolicies',
      'createSnapshot',
    ]),
    ...each('compute.resourcePolicies', [
      'create',
      'get',
      'list',
      'delete',
      'use',
    ]),
    ...each('compute.snapshots', [
      'create',
      'get',
      'list',
      'delete',
      'setLabels',
      'useReadOnly',
    ]),
    ...each('compute.routers', CRUD),
    'iap.tunnelInstances.accessViaIAP',
  ],
};

/**
 * Version 7, a Self-hosted instance's: version 5 and Stack VMs. Never
 * version 6's Cloud Build: versions fork by instance mode (ADR-0047), so a
 * newer version is not always a wider one. {@link makesBuildIdentity} says
 * which hold the build, never a `>=` on the number.
 */
const VERSION_7: readonly PermissionGroup[] = [...VERSION_5, STACK_VMS];

/** Version 8, the Hosted instance's: version 6 and Stack VMs. */
const VERSION_8: readonly PermissionGroup[] = [...VERSION_6, STACK_VMS];

/** The Stack VM versions' APIs: IAP's, which the tunnel goes through. */
const APIS_7: readonly string[] = [...APIS_5, 'iap.googleapis.com'];
const APIS_8: readonly string[] = [...APIS_6, 'iap.googleapis.com'];

const VERSIONS: Readonly<
  Record<
    number,
    { groups: readonly PermissionGroup[]; apis: readonly string[] }
  >
> = {
  1: { groups: VERSION_1, apis: APIS_1 },
  2: { groups: VERSION_2, apis: APIS_2 },
  3: { groups: VERSION_3, apis: APIS_3 },
  4: { groups: VERSION_4, apis: APIS_4 },
  5: { groups: VERSION_5, apis: APIS_5 },
  6: { groups: VERSION_6, apis: APIS_6 },
  7: { groups: VERSION_7, apis: APIS_7 },
  8: { groups: VERSION_8, apis: APIS_8 },
};

/**
 * Whether a version's setup script makes the build identity, and its role
 * may start builds. A version this Cloudgate does not know is a newer
 * one's (a rollback), which is taken to hold the Hosted instance's.
 */
export function makesBuildIdentity(version: number): boolean {
  const found = VERSIONS[version];
  return found ? found.apis.includes(CLOUD_BUILD_API) : version > NEWEST;
}

/** Whether a version holds what a Stack VM needs (ADR-0070); a newer one's does. */
export function holdsStackVms(version: number): boolean {
  const found = VERSIONS[version];
  return found ? found.groups.includes(STACK_VMS) : version > NEWEST;
}

/** The newest version in the table. */
const NEWEST = Math.max(...Object.keys(VERSIONS).map(Number));

/**
 * The permissions a Stack VM needs that a role at `version` lacks: those
 * of the Stack VM group it does not already hold; none from version 7 on.
 */
export function stackVmPermissionsMissing(version: number): string[] {
  if (holdsStackVms(version)) return [];
  const held = new Set(requiredPermissions(version));
  return STACK_VMS.permissions.filter((permission) => !held.has(permission));
}

/**
 * Everything the Stack VM versions add over the versions before them: the
 * permissions and APIs a role with none of a Stack VM's lacks.
 */
export function stackVmAdditions(): ReadonlySet<string> {
  return new Set([...stackVmPermissionsMissing(5), ...stackVmApisMissing(5)]);
}

/** The APIs a Stack VM needs that a version does not turn on. */
export function stackVmApisMissing(version: number): string[] {
  if (holdsStackVms(version)) return [];
  const on = new Set(requiredApis(version));
  return APIS_7.filter((api) => !on.has(api));
}

function versionOf(version: number) {
  const found = VERSIONS[version];
  if (!found) throw new Error(`No Google role version ${version}`);
  return found;
}

/** Every permission of a version, each once, in table order. */
export function requiredPermissions(version: number): string[] {
  return [
    ...new Set(versionOf(version).groups.flatMap((group) => group.permissions)),
  ];
}

/** The APIs a version needs on. */
export function requiredApis(version: number): string[] {
  return [...versionOf(version).apis];
}

/**
 * The role as `gcloud iam roles create|update --file` reads it: YAML, the
 * version in its description so a reader of the project can tell which one
 * it holds.
 */
export function roleDefinition(version: number): string {
  return [
    'title: Cloudgate deploy',
    `description: Cloudgate deploy role, version ${version}`,
    'stage: GA',
    'includedPermissions:',
    ...requiredPermissions(version).map((permission) => `  - ${permission}`),
    '',
  ].join('\n');
}

/**
 * The role's version table as the Cloud account checks read it — a seam,
 * like `AwsPolicy`, so a spec can hand in a second version to show
 * "permissions out of date" (CODING_STANDARDS §1.7).
 */
export interface GoogleRole {
  readonly version: number;
  readonly requiredPermissions: (version: number) => string[];
  readonly requiredApis: (version: number) => string[];
  readonly roleDefinition: (version: number) => string;
}

export const GOOGLE_ROLE = Symbol('GOOGLE_ROLE');

/** The version table this Cloudgate ships, at its newest version. */
export const SHIPPED_GOOGLE_ROLE: GoogleRole = {
  version: GOOGLE_ROLE_VERSION,
  requiredPermissions,
  requiredApis,
  roleDefinition,
};

/**
 * The shipped table at the version this instance's mode needs: the
 * Hosted instance's newest, which adds a cloud build's Cloud Build, and a
 * Self-hosted instance's version 7, which it builds without, so its Cloud
 * accounts are never asked for Cloud Build. The mode is read on each use,
 * through the instance-mode module, never copied.
 */
export function instanceGoogleRole(
  mode: Pick<InstanceMode, 'isHosted'>,
): GoogleRole {
  return {
    get version() {
      return googleRoleVersion(mode.isHosted);
    },
    requiredPermissions,
    requiredApis,
    roleDefinition,
  };
}
