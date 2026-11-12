import { networkDefinition as awsNetworkDefinition } from '../../src/cloud-accounts/aws/definitions/network-definition';
import { stackVmPinsOn } from '../../src/cloud-accounts/definitions/stack-vm-pins';
import { bucketDefinition } from '../../src/cloud-accounts/aws/definitions/bucket-definition';
import { rdsMysqlVersion } from '../../src/cloud-accounts/aws/definitions/mysql-version';
import {
  RDS_POSTGRES_DEFAULTS,
  rdsDatabaseDefinition,
} from '../../src/cloud-accounts/aws/definitions/postgres-definition';
import { rdsPostgresVersion } from '../../src/cloud-accounts/aws/definitions/postgres-version';
import {
  ELASTICACHE_REDIS_DEFAULTS,
  redisDefinition,
} from '../../src/cloud-accounts/aws/definitions/redis-definition';
import { valkeyVersion } from '../../src/cloud-accounts/aws/definitions/redis-version';
import { networkStandIns } from '../../src/cloud-accounts/aws/definitions/stand-ins';
import { staticDefinition } from '../../src/cloud-accounts/aws/definitions/static-definition';
import { stackVmDefinition } from '../../src/cloud-accounts/aws/definitions/stack-vm-definition';
import { ecsDefinitionOf } from '../../src/cloud-accounts/aws/definitions/web-definition';
import type { TofuDefinition } from '../../src/cloud-accounts/definitions/tofu-json';
import { gcpBucketDefinition } from '../../src/cloud-accounts/gcp/definitions/bucket-definition';
import {
  cloudRunRoutingOf,
  cloudRunServiceDefinition,
} from '../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import { cloudSqlDefinition } from '../../src/cloud-accounts/gcp/definitions/cloud-sql-definition';
import { existingCloudSqlDefinition } from '../../src/cloud-accounts/gcp/definitions/existing-cloud-sql-definition';
import { existingValkeyDefinition } from '../../src/cloud-accounts/gcp/definitions/existing-valkey-definition';
import { memorystoreDefinition } from '../../src/cloud-accounts/gcp/definitions/memorystore-definition';
import { networkDefinition as gcpNetworkDefinition } from '../../src/cloud-accounts/gcp/definitions/network-definition';
import { gcpNetworkStandIns } from '../../src/cloud-accounts/gcp/definitions/stand-ins';
import { gcpStaticDefinition } from '../../src/cloud-accounts/gcp/definitions/static-definition';
import { googleStackVmDefinition } from '../../src/cloud-accounts/gcp/definitions/stack-vm-definition';
import { toSize } from '../../src/project-config/format/config-size';
import { awsAddressKey } from '../../src/native/aws-locks';
import type { NativeCloud } from '../../src/native/address-snapshot';
import type { ConfigKind } from '../../src/project-config/planner/plan.types';

/**
 * **What the cloud definition builders write, built**: the
 * one driver that runs every builder, read by two gates.
 *
 * - The census (`test/coding-standards/native-lock-census.spec.ts`)
 *   holds the lock tables equal to every shape here, the Environment
 *   networks' among them.
 * - The address snapshot (`test/native/address-snapshot.spec.ts`)
 *   holds `GENERATED_ADDRESSES` to {@link generatedAddresses}: the
 *   addresses of every shape a native block may name.
 *
 * Each kind a cloud makes is built through the builder its plan and deploy
 * call, in **every shape that adds an address** another shape does not:
 * bare and with Domains, a linked bucket and variables; a database being
 * deleted; a bucket with and without browser origins, holding a rotation's
 * spare key and used as an existing one; an Existing database; and the
 * Environment network with every private link and Domains. It calls the
 * builders themselves, never a list of what they write, so a builder that
 * stops writing an address shows here as it would in an operator's plan.
 * A built definition holds only the branch its input took, so the census
 * also reads every type the builders' source names (`generatedTypes()`)
 * and fails on a type no shape here builds.
 *
 * The inputs are the definition specs' own (`test/cloud-accounts/*`), cut to
 * what changes an address.
 */

/** One shape of one Service's (or the network's) definition, and what made it. */
export interface BuiltShape {
  readonly shape: string;
  readonly definition: TofuDefinition;
  /**
   * Set on what the Cloud account already has (an Existing database): its
   * lookups and endpoints are refused whole, and make nothing a native
   * block may name, so the address snapshot leaves them out.
   */
  readonly existing?: true;
}

/** Every `<type>.<local>` a definition's `resource` block holds. */
export function addressesOf(definition: TofuDefinition): string[] {
  const blocks = (definition.resource ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.entries(blocks).flatMap(([type, byName]) =>
    Object.keys(byName).map((local) => `${type}.${local}`),
  );
}

/** A resource's body in a definition, by its address. */
export function bodyOf(
  definition: TofuDefinition,
  address: string,
): Record<string, unknown> {
  const [type, local] = address.split('.');
  const blocks = definition.resource as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  return blocks[type][local];
}

function expectOk<R extends { ok: boolean }>(
  result: R,
): Extract<R, { ok: true }> {
  if (!result.ok) {
    throw new Error(
      `a census shape was refused: ${JSON.stringify((result as { refusal?: unknown }).refusal)}`,
    );
  }
  return result as Extract<R, { ok: true }>;
}

// ── AWS ──

const AWS_ACCOUNT = {
  cloudAccountId: 'cloud-acct-1',
  awsAccountId: '123456789012',
  deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
  externalId: 'ext-abc',
};

const AWS_PLACE = {
  region: 'eu-west-1',
  environmentId: 'env-prod',
};

const AWS_DATABASE_NETWORK = {
  vpcId: 'vpc-0a1b',
  privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'] as [string, string],
};

const FINAL_SNAPSHOT = {
  projectName: 'Shop',
  environmentName: 'production',
  date: '2026-10-17',
};

const AWS_DOMAINS = [
  {
    domainId: 'dom_1',
    host: 'shop.example.com',
    path: '/',
    attempt: 1,
    attach: true,
  },
  {
    domainId: 'dom_2',
    host: 'www.example.com',
    path: '/api',
    attempt: 2,
    attach: false,
  },
];

/** An ECS-run kind through `ecsDefinitionOf`, the one place a kind picks its shape. */
function ecs(kind: ConfigKind, full: boolean): TofuDefinition {
  const network = {
    ...networkStandIns(AWS_PLACE.region, AWS_ACCOUNT.awsAccountId),
    privateDnsNamespaceId: 'ns-0abc',
  };
  return expectOk(
    ecsDefinitionOf(
      kind,
      {
        configName: 'api',
        entry: {
          size: toSize('small'),
          command: 'node server.js',
          args: ['--port', '4000'],
        },
        service: { serviceId: 'App_Id-1', replicas: 2 },
        account: {
          ...AWS_ACCOUNT,
          taskExecutionRoleArn:
            'arn:aws:iam::123456789012:role/cloudgate/cloudgate-task-execution',
          permissionsBoundaryArn:
            'arn:aws:iam::123456789012:policy/cloudgate/cloudgate-task-boundary',
        },
        ...AWS_PLACE,
        stateId: 'state-api-1',
        network,
        image: {
          tag: 'dep-42',
          architecture: 'amd64',
          ...(full ? { healthCheck: { test: ['CMD', 'true'] } } : {}),
        },
        variables: {
          values: full ? { API_KEY: 'not-a-secret', EMPTY: '' } : {},
          digestSecret: 'a-test-app-encryption-secret',
        },
        buckets: full ? ['cloudgate-uploads-1'] : [],
      },
      { port: 4000, domains: full ? AWS_DOMAINS : [] },
    ),
  ).definition;
}

function rds(engine: 'postgres' | 'mysql', deleting: boolean): TofuDefinition {
  const read =
    engine === 'postgres'
      ? rdsPostgresVersion('db-1', 'postgres:17')
      : rdsMysqlVersion('db-1', 'mysql:8.4');
  if (!read.ok) throw new Error(read.refusal.message);
  return rdsDatabaseDefinition({
    engine,
    configName: 'db-1',
    serviceId: 'Db_Id-1',
    account: AWS_ACCOUNT,
    ...AWS_PLACE,
    stateId: 'state-db-1',
    network: AWS_DATABASE_NETWORK,
    version: read.version,
    settings: { ...RDS_POSTGRES_DEFAULTS, instanceClass: 'db.t4g.micro' },
    login: { user: 'shop', database: 'shop', password: 'not-a-secret' },
    finalSnapshot: FINAL_SNAPSHOT,
    deleting: deleting ? { finalSnapshot: null } : undefined,
  }).definition;
}

function elastiCache(): TofuDefinition {
  const read = valkeyVersion('redis', 'redis:8');
  if (!read.ok) throw new Error(read.refusal.message);
  return redisDefinition({
    configName: 'redis',
    serviceId: 'Redis_Id-1',
    account: AWS_ACCOUNT,
    ...AWS_PLACE,
    stateId: 'state-redis',
    network: AWS_DATABASE_NETWORK,
    version: read.version,
    settings: { ...ELASTICACHE_REDIS_DEFAULTS, nodeType: 'cache.t4g.small' },
    authToken: 'a'.repeat(32) + 'b'.repeat(32),
    finalSnapshot: FINAL_SNAPSHOT,
  }).definition;
}

/** An ECS-run kind bare, and with Domains (a web's), a linked bucket and variables. */
function ecsShapes(kind: ConfigKind): BuiltShape[] {
  return [
    { shape: 'bare', definition: ecs(kind, false) },
    {
      shape:
        kind === 'web'
          ? 'with Domains, a linked bucket and variables'
          : 'with a linked bucket and variables',
      definition: ecs(kind, true),
    },
  ];
}

function rdsShapes(engine: 'postgres' | 'mysql'): BuiltShape[] {
  return [
    { shape: 'on RDS', definition: rds(engine, false) },
    { shape: 'on RDS, being deleted', definition: rds(engine, true) },
  ];
}

function awsBucket(origins: string[]): TofuDefinition {
  return bucketDefinition({
    configName: 'uploads',
    bucketName: 'cloudgate-uploads-1',
    account: AWS_ACCOUNT,
    ...AWS_PLACE,
    stateId: 'state-bucket-1',
    origins,
  });
}

function awsStatic(domains: boolean): TofuDefinition {
  return staticDefinition({
    configName: 'docs',
    serviceId: 'app_static_1',
    bucketName: 'cloudgate-docs-1',
    spa: domains,
    account: AWS_ACCOUNT,
    ...AWS_PLACE,
    stateId: 'state-static-1',
    liveFolder: domains ? 'dep-1' : null,
    domains: domains
      ? [
          {
            domainId: 'dom_3',
            host: 'docs.example.com',
            path: '/',
            attempt: 1,
            attach: true,
          },
        ]
      : [],
  });
}

/** A Compose stack's Stack VM, first made (reading Ubuntu's image) and made, and with Domains. */
function awsStackVm(
  imageId: string | null,
  withDomains = false,
): TofuDefinition {
  return stackVmDefinition({
    configName: 'analytics',
    serviceId: 'Cmp_Id-1',
    account: AWS_ACCOUNT,
    ...AWS_PLACE,
    stateId: 'state-analytics',
    network: AWS_DATABASE_NETWORK,
    machineType: 't3.small',
    dataDiskGb: 20,
    snapshotDays: 7,
    imageId,
    sshPublicKey: null,
    zone: null,
    pins: stackVmPinsOn('aws'),
    ...(withDomains
      ? {
          domains: [
            {
              domainId: 'Dom_S',
              host: 'shop.example.com',
              path: '/',
              attempt: 1,
              attach: true,
              port: 2368,
            },
          ],
          loadBalancer: networkStandIns(
            AWS_PLACE.region,
            AWS_ACCOUNT.awsAccountId,
          ),
        }
      : {}),
  }).definition;
}

/** Each kind AWS makes, in every shape that adds an address. */
export function awsBuilt(): Readonly<
  Partial<Record<ConfigKind, BuiltShape[]>>
> {
  return {
    web: ecsShapes('web'),
    'web-private': ecsShapes('web-private'),
    worker: ecsShapes('worker'),
    cron: ecsShapes('cron'),
    postgres: rdsShapes('postgres'),
    mysql: rdsShapes('mysql'),
    redis: [{ shape: 'on ElastiCache', definition: elastiCache() }],
    bucket: [
      { shape: 'trusting no browser origin', definition: awsBucket([]) },
      {
        shape: 'trusting browser origins',
        definition: awsBucket(['https://app.example.com']),
      },
    ],
    static: [
      { shape: 'bare', definition: awsStatic(false) },
      { shape: 'with a Domain', definition: awsStatic(true) },
    ],
    compose: [
      { shape: 'on a new Stack VM', definition: awsStackVm(null) },
      {
        shape: 'on a Stack VM with its image recorded',
        definition: awsStackVm('ami-0123456789abcdef0'),
      },
      {
        shape: 'on a Stack VM with a Domain',
        definition: awsStackVm('ami-0123456789abcdef0', true),
      },
    ],
  };
}

/** The AWS Environment network, with every private link it can hold. */
export function awsNetworkBuilt(): BuiltShape[] {
  return [
    {
      shape: 'with the private DNS namespace and the NAT gateway',
      definition: awsNetworkDefinition({
        cloudAccountId: AWS_ACCOUNT.cloudAccountId,
        account: AWS_ACCOUNT,
        ...AWS_PLACE,
        stateId: 'state-network-1',
        privateLinks: ['private-dns', 'nat-gateway'],
      }),
    },
    {
      // The Hosted instance's: a cloud build's standing pieces too.
      shape: "with a hosted cloud build's standing pieces",
      definition: awsNetworkDefinition({
        cloudAccountId: AWS_ACCOUNT.cloudAccountId,
        account: AWS_ACCOUNT,
        ...AWS_PLACE,
        stateId: 'state-network-1',
        cloudBuilds: true,
      }),
    },
  ];
}

// ── Google Cloud ──

const MARK = {
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'acme-prod-123',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
};

/** A Cloud Run kind through `cloudRunRoutingOf`, the one place a kind picks its routing. */
function cloudRun(kind: ConfigKind, variables: boolean): TofuDefinition {
  return expectOk(
    cloudRunServiceDefinition({
      ...MARK,
      configName: 'api',
      entry: { command: 'node server.js', args: ['--port', '8080'] },
      routing: cloudRunRoutingOf(kind, 8080, 2),
      service: { serviceId: 'Svc_Web', copies: { min: 0, max: 10 } },
      stateId: 'State_Svc-1',
      network: gcpNetworkStandIns(),
      pair: { cpu: 1, memoryMb: 512 },
      imageTag: 'dep-42',
      variables: variables ? { API_KEY: 'not-a-secret', EMPTY: '' } : {},
    }),
  ).definition;
}

function gcpBucket(
  shape: Partial<Parameters<typeof gcpBucketDefinition>[0]>,
): TofuDefinition {
  return gcpBucketDefinition({
    ...MARK,
    serviceId: 'Svc_Bucket',
    bucketName: 'cloudgate-abcdefghijkl-a1b2c3d4',
    stateId: 'State_Bucket-1',
    origins: [],
    ...shape,
  });
}

/** Each kind Google Cloud makes, in every shape that adds an address. */
export function gcpBuilt(): Readonly<
  Partial<Record<ConfigKind, BuiltShape[]>>
> {
  return {
    web: [
      { shape: 'bare', definition: cloudRun('web', false) },
      { shape: 'with variables', definition: cloudRun('web', true) },
    ],
    'web-private': [
      { shape: 'bare', definition: cloudRun('web-private', false) },
      { shape: 'with variables', definition: cloudRun('web-private', true) },
    ],
    worker: [
      { shape: 'bare', definition: cloudRun('worker', false) },
      { shape: 'with variables', definition: cloudRun('worker', true) },
    ],
    cron: [
      { shape: 'bare', definition: cloudRun('cron', false) },
      { shape: 'with variables', definition: cloudRun('cron', true) },
    ],
    postgres: [
      {
        shape: 'on Cloud SQL',
        definition: cloudSqlDefinition({
          ...MARK,
          serviceId: 'Svc_Pg',
          stateId: 'State_Pg-1',
          network: gcpNetworkStandIns(),
          tier: 'db-custom-1-3840',
          engine: 'postgres' as const,
          databaseVersion: 'POSTGRES_17',
          login: { user: 'pg_1', database: 'pg_1', password: 'not-a-secret' },
          backupRetentionDays: 7,
          pointInTimeRecovery: true,
        }).definition,
      },
      {
        shape: 'as an Existing database',
        existing: true,
        definition: existingCloudSqlDefinition({
          ...MARK,
          serviceId: 'Svc_Pg',
          stateId: 'State_Pg-1',
          serviceAttachment:
            'projects/a1b2c3d4e5f6-tp/regions/europe-west1/serviceAttachments/a-1234-psc-service-attachment-abcd',
          dnsName: '4c583468c161.1idghei1xv0vf.europe-west1.sql.goog.',
        }),
      },
    ],
    // A mysql on Cloud SQL: postgres's definition, MySQL's engine.
    mysql: [
      {
        shape: 'on Cloud SQL',
        definition: cloudSqlDefinition({
          ...MARK,
          serviceId: 'Svc_My',
          stateId: 'State_My-1',
          network: gcpNetworkStandIns(),
          tier: 'db-custom-1-3840',
          engine: 'mysql',
          databaseVersion: 'MYSQL_8_4',
          login: {
            user: 'my_1',
            database: 'my_1',
            password: 'not-a-secret',
            rootPassword: 'not-a-secret-either',
          },
          backupRetentionDays: 7,
          pointInTimeRecovery: true,
        }).definition,
      },
      {
        shape: 'as an Existing database',
        existing: true,
        definition: existingCloudSqlDefinition({
          ...MARK,
          serviceId: 'Svc_My',
          stateId: 'State_My-1',
          serviceAttachment:
            'projects/a1b2c3d4e5f6-tp/regions/europe-west1/serviceAttachments/a-1234-psc-service-attachment-abcd',
          dnsName: '4c583468c161.1idghei1xv0vf.europe-west1.sql.goog.',
        }),
      },
    ],
    redis: [
      {
        shape: 'on Memorystore',
        definition: memorystoreDefinition({
          ...MARK,
          serviceId: 'Svc_Redis',
          stateId: 'State_Redis-1',
          network: gcpNetworkStandIns(),
          nodeType: 'CUSTOM_MICRO',
          engineVersion: 'VALKEY_8_0',
          highAvailability: false,
          backupRetentionDays: 1,
        }),
      },
      {
        shape: 'on Memorystore, highly available',
        definition: memorystoreDefinition({
          ...MARK,
          serviceId: 'Svc_Redis',
          stateId: 'State_Redis-1',
          network: gcpNetworkStandIns(),
          nodeType: 'CUSTOM_PICO',
          engineVersion: 'VALKEY_8_0',
          highAvailability: true,
          backupRetentionDays: 1,
        }),
      },
      {
        shape: 'as an Existing database',
        existing: true,
        definition: existingValkeyDefinition({
          ...MARK,
          serviceId: 'Svc_Cache',
          stateId: 'State_Cache-1',
          serviceAttachments: {
            primary:
              'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa',
            reader:
              'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa-2',
          },
        }),
      },
    ],
    bucket: [
      {
        shape: 'trusting browser origins, one key',
        definition: gcpBucket({
          origins: ['https://app.example.com'],
          keys: { live: 'key', spare: false },
        }),
      },
      {
        shape:
          'trusting browser origins, a rotation’s new key beside the live one',
        definition: gcpBucket({
          origins: ['https://app.example.com'],
          keys: { live: 'key', spare: true },
        }),
      },
      {
        shape: 'the live key in the second slot',
        definition: gcpBucket({ keys: { live: 'key_b', spare: false } }),
      },
      {
        shape: 'an existing bucket',
        definition: gcpBucket({
          bucketName: 'acme-prod-uploads',
          keys: { live: 'key', spare: true },
          existing: true,
        }),
      },
    ],
    static: [
      {
        shape: 'on Cloud Storage and Cloud CDN',
        definition: gcpStaticDefinition({
          ...MARK,
          serviceId: 'Svc_Docs',
          bucketName: 'cloudgate-abcdefghijkl-p4x8m2rt',
          projectNumber: '123456789012',
          stateId: 'State_Docs-1',
        }),
      },
    ],
    compose: [
      { shape: 'on a new Stack VM', definition: gcpStackVm(null) },
      {
        shape: 'on a Stack VM with its image and zone recorded',
        definition: gcpStackVm(
          'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261101',
        ),
      },
      {
        shape: 'on a Stack VM with a Domain',
        definition: gcpStackVm(
          'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261101',
          [2368],
        ),
      },
    ],
  };
}

/** A Compose stack's Stack VM on Google Cloud, first made (reading Ubuntu's image) and made. */
function gcpStackVm(imageId: string | null, ports?: number[]): TofuDefinition {
  return googleStackVmDefinition({
    ...MARK,
    configName: 'analytics',
    serviceId: 'Cmp_Id-1',
    stateId: 'State_Analytics',
    network: gcpNetworkStandIns(),
    machineType: 'e2-small',
    dataDiskGb: 20,
    snapshotDays: 7,
    imageId,
    zone: imageId === null ? null : 'europe-west1-c',
    sshPublicKey: null,
    pins: stackVmPinsOn('gcp'),
    ...(ports ? { ports } : {}),
  }).definition;
}

/** The Google Environment network, with Domains and every private link. */
export function gcpNetworkBuilt(): BuiltShape[] {
  return [
    {
      shape:
        'with Domains, a static site’s among them, both private links, the run.app zone and Cloud NAT',
      definition: gcpNetworkDefinition({
        ...MARK,
        stateId: 'State_Net-1',
        domains: [
          {
            domainId: 'Dom_A',
            host: 'acme.dev',
            path: '/',
            attempt: 1,
            serviceId: 'Svc_Web',
          },
          {
            domainId: 'Dom_C',
            host: 'docs.acme.dev',
            path: '/',
            attempt: 1,
            serviceId: 'Svc_Docs',
            site: { spa: true },
          },
        ],
        privateLinks: ['cloud-sql', 'memorystore', 'run-app-zone', 'cloud-nat'],
      }),
    },
    {
      // The Hosted instance's: a cloud build's source bucket too.
      shape: "with a hosted cloud build's source bucket",
      definition: gcpNetworkDefinition({
        ...MARK,
        stateId: 'State_Net-1',
        domains: [],
        privateLinks: [],
        cloudBuilds: true,
      }),
    },
  ];
}

/**
 * Every address the builders generate now that a native block may name, by
 * cloud, then kind, sorted: what `GENERATED_ADDRESSES` is held to.
 * A parameter group is listed by its table key
 * (`aws_elasticache_parameter_group.<family>`), since its local name is the
 * version's family and moves with it by design. Not here: the Environment
 * network, which no config entry describes and so has no native block
 * (ADR-0044, Consequences), and an Existing database's lookups.
 */
export function generatedAddresses(): Record<
  NativeCloud,
  Record<string, string[]>
> {
  const by = (
    built: Readonly<Partial<Record<ConfigKind, BuiltShape[]>>>,
    keyOf: (address: string) => string,
  ) =>
    Object.fromEntries(
      Object.entries(built).map(([kind, shapes]) => [
        kind,
        [
          ...new Set(
            (shapes ?? [])
              .filter((shape) => !shape.existing)
              .flatMap((shape) => addressesOf(shape.definition))
              .map(keyOf),
          ),
        ].sort(),
      ]),
    );
  return {
    aws: by(awsBuilt(), awsAddressKey),
    gcp: by(gcpBuilt(), (address) => address),
  };
}
