import {
  GOOGLE_ROLE_VERSION,
  googleRoleVersion,
  holdsStackVms,
  instanceGoogleRole,
  makesBuildIdentity,
  SELF_HOSTED_GOOGLE_ROLE_VERSION,
  requiredApis,
  requiredPermissions,
  roleDefinition,
} from '../../../src/cloud-accounts/gcp/deploy-role';

/**
 * The custom role, version 1 (spec "One custom role"): one table feeds
 * the role definition and the connect check, so what the operator grants is
 * exactly what the check tests.
 */
describe('requiredPermissions and roleDefinition', () => {
  const permissions = requiredPermissions(1);

  it('ships version 8, and version 7 to a Self-hosted instance', () => {
    expect(GOOGLE_ROLE_VERSION).toBe(8);
    expect(SELF_HOSTED_GOOGLE_ROLE_VERSION).toBe(7);
    expect(googleRoleVersion(true)).toBe(8);
    expect(googleRoleVersion(false)).toBe(7);
  });

  it.each([
    [
      'Cloud Run: services with their IAM policy, revisions, operations and locations',
      [
        'run.services.create',
        'run.services.get',
        'run.services.list',
        'run.services.update',
        'run.services.delete',
        'run.services.setIamPolicy',
        'run.services.getIamPolicy',
        'run.revisions.get',
        'run.revisions.list',
        'run.revisions.delete',
        'run.operations.get',
        'run.locations.list',
      ],
    ],
    [
      'Artifact Registry: repositories, versions, tags and locations',
      [
        'artifactregistry.repositories.create',
        'artifactregistry.repositories.get',
        'artifactregistry.repositories.list',
        'artifactregistry.repositories.update',
        'artifactregistry.repositories.delete',
        'artifactregistry.repositories.uploadArtifacts',
        'artifactregistry.repositories.downloadArtifacts',
        'artifactregistry.versions.list',
        'artifactregistry.versions.delete',
        'artifactregistry.tags.list',
        'artifactregistry.tags.delete',
        'artifactregistry.locations.list',
      ],
    ],
    [
      'Compute: the network, the load balancer pieces and their operations',
      [
        'compute.networks.create',
        'compute.networks.delete',
        'compute.subnetworks.create',
        'compute.subnetworks.use',
        'compute.globalAddresses.create',
        'compute.globalAddresses.setLabels',
        'compute.globalForwardingRules.create',
        'compute.targetHttpsProxies.create',
        'compute.targetHttpProxies.create',
        'compute.urlMaps.create',
        'compute.urlMaps.use',
        'compute.backendServices.create',
        'compute.backendServices.use',
        'compute.regionNetworkEndpointGroups.create',
        'compute.regionNetworkEndpointGroups.use',
        'compute.globalOperations.get',
        'compute.regionOperations.get',
      ],
    ],
    [
      'Certificate Manager: certificates, maps, map entries, DNS authorizations and operations',
      [
        'certificatemanager.certs.create',
        'certificatemanager.certs.use',
        'certificatemanager.certmaps.create',
        'certificatemanager.certmaps.use',
        'certificatemanager.certmapentries.create',
        'certificatemanager.dnsauthorizations.create',
        'certificatemanager.dnsauthorizations.use',
        'certificatemanager.operations.get',
      ],
    ],
    [
      'IAM: service accounts, acting as them included',
      [
        'iam.serviceAccounts.create',
        'iam.serviceAccounts.get',
        'iam.serviceAccounts.list',
        'iam.serviceAccounts.update',
        'iam.serviceAccounts.delete',
        'iam.serviceAccounts.actAs',
      ],
    ],
    [
      'Secret Manager: secrets with their IAM policy, and versions (S1)',
      [
        'secretmanager.secrets.create',
        'secretmanager.secrets.get',
        'secretmanager.secrets.list',
        'secretmanager.secrets.update',
        'secretmanager.secrets.delete',
        'secretmanager.secrets.getIamPolicy',
        'secretmanager.secrets.setIamPolicy',
        'secretmanager.versions.add',
        'secretmanager.versions.get',
        'secretmanager.versions.list',
        'secretmanager.versions.access',
        'secretmanager.versions.enable',
        'secretmanager.versions.disable',
        'secretmanager.versions.destroy',
      ],
    ],
    ['Logging', ['logging.logEntries.list']],
    [
      'Resource Manager and Service Usage',
      ['resourcemanager.projects.get', 'serviceusage.services.list'],
    ],
  ])('holds %s', (_group, expected) => {
    expect(permissions).toEqual(expect.arrayContaining(expected));
  });

  it('names each permission once, and never a wildcard', () => {
    expect(new Set(permissions).size).toBe(permissions.length);
    expect(
      permissions.filter((permission) => permission.includes('*')),
    ).toEqual([]);
  });

  it('needs the 11 APIs, Certificate Manager and Secret Manager among them', () => {
    expect([...requiredApis(1)].sort()).toEqual([
      'artifactregistry.googleapis.com',
      'certificatemanager.googleapis.com',
      'cloudresourcemanager.googleapis.com',
      'compute.googleapis.com',
      'iam.googleapis.com',
      'iamcredentials.googleapis.com',
      'logging.googleapis.com',
      'run.googleapis.com',
      'secretmanager.googleapis.com',
      'serviceusage.googleapis.com',
      'sts.googleapis.com',
    ]);
  });

  it('defines the role for gcloud with every permission of its version, the version in its description', () => {
    const definition = roleDefinition(1);

    expect(definition).toContain('title: Cloudgate deploy');
    expect(definition).toContain(
      'description: Cloudgate deploy role, version 1',
    );
    expect(definition).toContain('stage: GA');
    for (const permission of permissions) {
      expect(definition).toContain(`\n  - ${permission}\n`);
    }
  });
});

/**
 * Version 2: version 1, plus what a `postgres` on Cloud SQL
 * a `redis` on Memorystore and the private link they attach
 * through need, so "permissions out of date" names exactly those.
 */
describe('requiredPermissions and requiredApis, version 2', () => {
  const crud = (prefix: string) =>
    ['create', 'get', 'list', 'update', 'delete'].map(
      (verb) => `${prefix}.${verb}`,
    );
  const before = new Set(requiredPermissions(1));
  const added = requiredPermissions(2).filter((one) => !before.has(one));

  it('keeps every permission of version 1', () => {
    expect(requiredPermissions(2)).toEqual(
      expect.arrayContaining(requiredPermissions(1)),
    );
  });

  it('adds Cloud SQL, the private link’s policies, the Redis firewall rule, Memorystore and the label search’s lists, and nothing else', () => {
    expect([...added].sort()).toEqual(
      [
        ...crud('cloudsql.instances'),
        ...crud('cloudsql.databases'),
        ...crud('cloudsql.users'),
        ...crud('networkconnectivity.serviceConnectionPolicies'),
        'networkconnectivity.operations.get',
        ...crud('compute.firewalls'),
        'compute.networks.updatePolicy',
        ...crud('memorystore.instances'),
        'memorystore.operations.get',
        // The label search after an Environment's Delete.
        'compute.addresses.list',
        'compute.forwardingRules.list',
      ].sort(),
    );
  });

  it('names each permission once, and never a wildcard', () => {
    const permissions = requiredPermissions(2);
    expect(new Set(permissions).size).toBe(permissions.length);
    expect(permissions.filter((one) => one.includes('*'))).toEqual([]);
  });

  it('needs the APIs Cloud SQL, Memorystore and their Private Service Connect set-up use', () => {
    const apis = new Set(requiredApis(1));
    expect(
      requiredApis(2)
        .filter((api) => !apis.has(api))
        .sort(),
    ).toEqual([
      'dns.googleapis.com',
      'memorystore.googleapis.com',
      'networkconnectivity.googleapis.com',
      'serviceconsumermanagement.googleapis.com',
      'servicenetworking.googleapis.com',
      'sqladmin.googleapis.com',
    ]);
  });

  it('defines the role with version 2 in its description', () => {
    expect(roleDefinition(2)).toContain(
      'description: Cloudgate deploy role, version 2',
    );
  });
});

/**
 * What a static site on Cloud Storage + Cloud CDN uses: its
 * backend bucket, which the network's URL map uses; its files, uploaded,
 * copied into `live/` (a rewrite is a create and a get, over an object
 * there a delete) and deleted; and each Domain's cache clear.
 */
const STATIC_SITE = [
  'compute.backendBuckets.create',
  'compute.backendBuckets.get',
  'compute.backendBuckets.list',
  'compute.backendBuckets.update',
  'compute.backendBuckets.delete',
  'compute.backendBuckets.use',
  'storage.objects.create',
  'storage.objects.get',
  'storage.objects.list',
  'storage.objects.delete',
  'compute.urlMaps.invalidateCache',
];

/**
 * Version 3: version 2, plus what a
 * `bucket` on Cloud Storage needs — the bucket, its IAM binding for its own
 * service account, and `roles/storage.hmacKeyAdmin`'s key permissions, which
 * `roles/storage.admin` does not hold, and what its Delete needs of its
 * objects — and what an Existing database on Cloud SQL's manual Private
 * Service Connect endpoint and private DNS zone need, so "permissions out of
 * date" names exactly those. The endpoint's and zone's are taken from
 * Google's docs; the walk by hand proves them.
 */
describe('requiredPermissions and requiredApis, version 3', () => {
  const crud = (prefix: string) =>
    ['create', 'get', 'list', 'update', 'delete'].map(
      (verb) => `${prefix}.${verb}`,
    );
  const before = new Set(requiredPermissions(2));
  const added = requiredPermissions(3).filter((one) => !before.has(one));

  it('keeps every permission of version 2', () => {
    expect(requiredPermissions(3)).toEqual(
      expect.arrayContaining(requiredPermissions(2)),
    );
  });

  it("adds the bucket, its IAM policy and the HMAC key admin's permissions, the endpoint's address and forwarding rule, the private zone, its network binding and its record, the backups' reads and writes, the static site's backend bucket and files, a bucket Delete's object list and delete, and an existing Valkey's CA and Memorystore for Redis reads, and nothing else", () => {
    // The Backups tab's latest recovery time is `cloudsql.instances.get`, version 2's.
    expect(requiredPermissions(2)).toContain('cloudsql.instances.get');
    expect([...added].sort()).toEqual(
      [
        'storage.buckets.create',
        'storage.buckets.get',
        'storage.buckets.list',
        'storage.buckets.update',
        'storage.buckets.delete',
        'storage.buckets.getIamPolicy',
        'storage.buckets.setIamPolicy',
        // roles/storage.hmacKeyAdmin, as Google lists it.
        'storage.hmacKeys.create',
        'storage.hmacKeys.get',
        'storage.hmacKeys.list',
        'storage.hmacKeys.update',
        'storage.hmacKeys.delete',
        // An Existing database's endpoint and private zone.
        'compute.addresses.create',
        'compute.addresses.createInternal',
        'compute.addresses.get',
        'compute.addresses.delete',
        'compute.addresses.deleteInternal',
        'compute.addresses.use',
        'compute.addresses.useInternal',
        'compute.addresses.setLabels',
        'compute.forwardingRules.create',
        'compute.forwardingRules.get',
        'compute.forwardingRules.delete',
        'compute.forwardingRules.setLabels',
        'compute.forwardingRules.pscCreate',
        'compute.forwardingRules.pscDelete',
        'compute.forwardingRules.pscSetLabels',
        'compute.forwardingRules.pscUpdate',
        'compute.networks.use',
        ...crud('dns.managedZones'),
        'dns.networks.bindPrivateDNSZone',
        ...crud('dns.resourceRecordSets'),
        'dns.changes.create',
        'dns.changes.get',
        // A Google database's final backup on Delete, and its
        // Backups tab read live.
        'cloudsql.backupRuns.create',
        'cloudsql.backupRuns.get',
        'cloudsql.backupRuns.list',
        'memorystore.instances.backup',
        'memorystore.backups.get',
        'memorystore.backups.list',
        'memorystore.backupCollections.get',
        'memorystore.backupCollections.list',
        // An existing Valkey's lookup.
        'redis.instances.get',
        'redis.clusters.get',
        // A static site on Cloud Storage behind Cloud CDN.
        ...crud('compute.backendBuckets'),
        'compute.backendBuckets.use',
        'storage.objects.create',
        'storage.objects.get',
        // A static site's files, and a bucket's Delete:
        // its one-object list, and force_destroy's emptying.
        'storage.objects.list',
        'storage.objects.delete',
        // Each of a static site's Domains' cache clear.
        'compute.urlMaps.invalidateCache',
      ].sort(),
    );
  });

  it("adds a static site's backend bucket, its objects and the per-Domain cache clear", () => {
    expect(added).toEqual(expect.arrayContaining(STATIC_SITE));
  });

  it('makes the bucket’s own service account with version 1’s service account permissions', () => {
    expect(requiredPermissions(1)).toEqual(
      expect.arrayContaining([
        'iam.serviceAccounts.create',
        'iam.serviceAccounts.delete',
      ]),
    );
  });

  it('names each permission once, and never a wildcard', () => {
    const permissions = requiredPermissions(3);
    expect(new Set(permissions).size).toBe(permissions.length);
    expect(permissions.filter((one) => one.includes('*'))).toEqual([]);
  });

  it("needs Cloud Storage's API too, and Cloud DNS's is version 2's", () => {
    const apis = new Set(requiredApis(2));
    expect(requiredApis(3).filter((api) => !apis.has(api))).toEqual([
      'storage.googleapis.com',
    ]);
    expect(requiredApis(2)).toContain('dns.googleapis.com');
  });

  it('defines the role with version 3 in its description', () => {
    expect(roleDefinition(3)).toContain(
      'description: Cloudgate deploy role, version 3',
    );
  });
});

/**
 * Version 4: version 3, plus what a Worker (a Cloud Run
 * worker pool), a Cron service (a Cloud Run job, its executions and their
 * tasks) and the Environment network's private `run.app` zone for Private
 * web services need. Its spec calls this "version 3"; the bucket and static
 * site spec took 3 first, so it is 4.
 * `run.workerpools.*` and `dns.managedZones.*` are written out, since a
 * custom role holds no wildcard, as Google's Cloud Run and Cloud DNS
 * permission pages list them. Of the Cloud DNS ones only the zone's IAM
 * policy pair is new: version 3 already holds the rest for an Existing
 * database's zone.
 */
/**
 * Version 3's size; a shipped version is never edited.
 * The one exception: it shipped with `memorystore.instances.getCertificateAuthority`,
 * which Google does not have and refuses a custom role over, so no project
 * ever held version 3 (or 4) and the walk by hand took it out of both.
 */
const VERSION_3_COUNT = 226;

describe('requiredPermissions and requiredApis, version 4', () => {
  const before = new Set(requiredPermissions(3));
  const added = requiredPermissions(4).filter((one) => !before.has(one));

  it('keeps every permission of version 3', () => {
    expect(requiredPermissions(4)).toEqual(
      expect.arrayContaining(requiredPermissions(3)),
    );
  });

  it("adds worker pools, jobs with no runWithOverrides, executions, their tasks and the rest of the Cloud DNS zone's, and nothing else", () => {
    expect([...added].sort()).toEqual(
      [
        'run.workerpools.create',
        'run.workerpools.get',
        'run.workerpools.list',
        'run.workerpools.update',
        'run.workerpools.delete',
        'run.workerpools.getIamPolicy',
        'run.workerpools.setIamPolicy',
        'run.jobs.create',
        'run.jobs.get',
        'run.jobs.list',
        'run.jobs.update',
        'run.jobs.delete',
        'run.jobs.run',
        'run.executions.get',
        'run.executions.list',
        'run.executions.cancel',
        'run.executions.delete',
        'run.tasks.get',
        'run.tasks.list',
        'dns.managedZones.getIamPolicy',
        'dns.managedZones.setIamPolicy',
      ].sort(),
    );
    expect(requiredPermissions(4)).not.toContain('run.jobs.runWithOverrides');
  });

  it('holds every Cloud DNS permission its spec names, each once', () => {
    expect(requiredPermissions(4)).toEqual(
      expect.arrayContaining([
        'dns.managedZones.create',
        'dns.managedZones.get',
        'dns.managedZones.list',
        'dns.managedZones.update',
        'dns.managedZones.delete',
        'dns.managedZones.getIamPolicy',
        'dns.managedZones.setIamPolicy',
        'dns.changes.create',
        'dns.changes.get',
        'dns.resourceRecordSets.create',
        'dns.resourceRecordSets.get',
        'dns.resourceRecordSets.list',
        'dns.resourceRecordSets.update',
        'dns.resourceRecordSets.delete',
        'dns.networks.bindPrivateDNSZone',
      ]),
    );
  });

  it('names each permission once, and never a wildcard', () => {
    const permissions = requiredPermissions(4);
    expect(new Set(permissions).size).toBe(permissions.length);
    expect(permissions.filter((one) => one.includes('*'))).toEqual([]);
  });

  it("needs no API version 3 does not: Cloud DNS's is version 2's, Cloud Run's version 1's", () => {
    expect(requiredApis(4)).toEqual(requiredApis(3));
    expect(requiredApis(4)).toEqual(
      expect.arrayContaining(['dns.googleapis.com', 'run.googleapis.com']),
    );
  });

  it('defines the role with version 4 in its description', () => {
    expect(roleDefinition(4)).toContain(
      'description: Cloudgate deploy role, version 4',
    );
  });

  it('leaves version 3 as it was', () => {
    expect(requiredPermissions(3)).toHaveLength(VERSION_3_COUNT);
    expect(requiredPermissions(3)).not.toEqual(
      expect.arrayContaining(['run.workerpools.create']),
    );
    expect(roleDefinition(3)).toContain(
      'description: Cloudgate deploy role, version 3',
    );
  });
});

/** Version 4's size; a shipped version is never edited. */
const VERSION_4_COUNT = 247;

/**
 * Version 5 (from the walk by hand): version 4, plus the Service Directory
 * registration Google makes, as the caller, when an Existing database's PSC
 * endpoint is created in `goog-psc-default`. Version 4 was refused there for
 * `servicedirectory.services.create` and `servicedirectory.namespaces.create`.
 */
describe('requiredPermissions and requiredApis, version 5', () => {
  const before = new Set(requiredPermissions(4));
  const added = requiredPermissions(5).filter((one) => !before.has(one));

  it('keeps every permission of version 4', () => {
    expect(requiredPermissions(5)).toEqual(
      expect.arrayContaining(requiredPermissions(4)),
    );
  });

  it("adds the PSC endpoint's Service Directory namespace and service, and nothing else", () => {
    expect([...added].sort()).toEqual(
      [
        'servicedirectory.namespaces.create',
        'servicedirectory.namespaces.get',
        'servicedirectory.services.create',
        'servicedirectory.services.get',
        'servicedirectory.services.delete',
      ].sort(),
    );
  });

  it('names each permission once, and never a wildcard', () => {
    const permissions = requiredPermissions(5);
    expect(new Set(permissions).size).toBe(permissions.length);
    expect(permissions.filter((one) => one.includes('*'))).toEqual([]);
  });

  it('needs no API version 4 does not', () => {
    expect(requiredApis(5)).toEqual(requiredApis(4));
  });

  it('defines the role with version 5 in its description', () => {
    expect(roleDefinition(5)).toContain(
      'description: Cloudgate deploy role, version 5',
    );
  });

  it('leaves version 4 as it was', () => {
    expect(requiredPermissions(4)).toHaveLength(VERSION_4_COUNT);
    expect(requiredPermissions(4)).not.toEqual(
      expect.arrayContaining(['servicedirectory.services.create']),
    );
  });
});

/** Version 5's size; a shipped version is never edited. */
const VERSION_5_COUNT = VERSION_4_COUNT + 5;

/**
 * Version 6 (ADR-0047): version 5, plus a hosted cloud build in
 * Cloud Build: start, watch, find and cancel a build, and the Cloud Build
 * API. The Hosted instance's version only.
 */
describe('requiredPermissions and requiredApis, version 6', () => {
  const before = new Set(requiredPermissions(5));
  const added = requiredPermissions(6).filter((one) => !before.has(one));

  it('keeps every permission of version 5', () => {
    expect(requiredPermissions(6)).toEqual(
      expect.arrayContaining(requiredPermissions(5)),
    );
  });

  it('adds the four cloudbuild.builds permissions, and nothing else', () => {
    expect([...added].sort()).toEqual([
      'cloudbuild.builds.create',
      'cloudbuild.builds.get',
      'cloudbuild.builds.list',
      'cloudbuild.builds.update',
    ]);
  });

  it('adds the Cloud Build API, and no other', () => {
    expect(requiredApis(6)).toEqual([
      ...requiredApis(5),
      'cloudbuild.googleapis.com',
    ]);
  });

  it('defines the role with version 6 in its description', () => {
    expect(roleDefinition(6)).toContain(
      'description: Cloudgate deploy role, version 6',
    );
    expect(roleDefinition(6)).toContain('  - cloudbuild.builds.create\n');
  });

  it('leaves version 5 as it was', () => {
    expect(requiredPermissions(5)).toHaveLength(VERSION_5_COUNT);
    expect(JSON.stringify(requiredPermissions(5))).not.toContain('cloudbuild');
    expect(requiredApis(5)).not.toContain('cloudbuild.googleapis.com');
  });
});

/**
 * The role seam at the instance's mode: read on each use, so a
 * Self-hosted instance, which builds on its platform host, is never asked
 * for version 6.
 */
describe('instanceGoogleRole', () => {
  it("answers the mode's version each time it is asked", () => {
    const mode = { isHosted: false };
    const role = instanceGoogleRole(mode);
    expect(role.version).toBe(7);
    mode.isHosted = true;
    expect(role.version).toBe(8);
  });
});

/**
 * Versions 7 and 8 (ADR-0070, #1366): what a Stack VM needs, on both
 * instances alike. The versions fork by mode (ADR-0047): a Self-hosted
 * instance's 7 is version 5 with the Stack VM group, the Hosted instance's
 * 8 is version 6 with the same, so a Self-hosted Cloud account is never
 * asked for Cloud Build.
 */
describe('requiredPermissions and requiredApis, versions 7 and 8', () => {
  const added = (to: number, over: number) => {
    const before = new Set(requiredPermissions(over));
    return requiredPermissions(to).filter((one) => !before.has(one));
  };

  it('adds the same permissions over version 5 for a Self-hosted instance as over version 6 for the Hosted one', () => {
    expect(added(7, 5).sort()).toEqual(added(8, 6).sort());
    expect(requiredPermissions(7)).toEqual(
      expect.arrayContaining(requiredPermissions(5)),
    );
    expect(requiredPermissions(8)).toEqual(
      expect.arrayContaining(requiredPermissions(6)),
    );
    expect(JSON.stringify(requiredPermissions(7))).not.toContain('cloudbuild');
    expect(requiredApis(7)).not.toContain('cloudbuild.googleapis.com');
  });

  it("adds IAP tunnelling, the Stack VM's Compute instance, disks, snapshot schedule and snapshots, the zone's operations and the network's router", () => {
    expect(added(7, 5)).toEqual(
      expect.arrayContaining([
        'iap.tunnelInstances.accessViaIAP',
        'compute.instances.create',
        'compute.instances.delete',
        'compute.instances.start',
        'compute.instances.stop',
        'compute.instances.setMachineType',
        'compute.instances.attachDisk',
        'compute.instances.setServiceAccount',
        'compute.disks.create',
        'compute.disks.delete',
        'compute.disks.resize',
        'compute.disks.addResourcePolicies',
        'compute.disks.createSnapshot',
        'compute.resourcePolicies.create',
        'compute.resourcePolicies.delete',
        'compute.snapshots.create',
        'compute.zoneOperations.get',
        'compute.routers.create',
        'compute.routers.update',
      ]),
    );
    // Its own service account is version 1's `iam.serviceAccounts`.
    expect(requiredPermissions(1)).toEqual(
      expect.arrayContaining([
        'iam.serviceAccounts.create',
        'iam.serviceAccounts.delete',
        'iam.serviceAccounts.actAs',
      ]),
    );
  });

  it('names each permission once, and never a wildcard', () => {
    for (const version of [7, 8]) {
      const permissions = requiredPermissions(version);
      expect(new Set(permissions).size).toBe(permissions.length);
      expect(permissions.some((one) => one.includes('*'))).toBe(false);
    }
  });

  it("adds IAP's API, and no other", () => {
    expect(requiredApis(7)).toEqual([...requiredApis(5), 'iap.googleapis.com']);
    expect(requiredApis(8)).toEqual([...requiredApis(6), 'iap.googleapis.com']);
  });

  it('holds Stack VMs from version 7 on, and the build identity only in the Hosted versions', () => {
    expect([5, 6, 7, 8].map(holdsStackVms)).toEqual([false, false, true, true]);
    expect([5, 6, 7, 8].map(makesBuildIdentity)).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it('leaves versions 5 and 6 as they were', () => {
    expect(requiredPermissions(5)).toHaveLength(VERSION_5_COUNT);
    expect(JSON.stringify(requiredPermissions(6))).not.toContain('iap.');
  });
});
