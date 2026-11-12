import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CreateSubnetCommand,
  CreateVpcCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  CreateDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  ModifyDBInstanceCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

import { existingPostgresLookup } from '../../../src/cloud-accounts/aws/definitions/existing-postgres-lookup';
import { existingRedisLookup } from '../../../src/cloud-accounts/aws/definitions/existing-redis-lookup';
import { NETWORK_ADDRESS_RANGE } from '../../../src/cloud-accounts/aws/definitions/network-definition';
import {
  finalSnapshotIdentifier,
  POSTGRES_INSTANCE_ADDRESS,
  rdsDatabaseDefinition,
  RDS_POSTGRES_DEFAULTS,
} from '../../../src/cloud-accounts/aws/definitions/postgres-definition';
import type {
  DatabaseNetworkIds,
  DeletingDatabase,
  RdsPostgresSettings,
} from '../../../src/cloud-accounts/aws/definitions/postgres-definition';
import {
  ELASTICACHE_REDIS_DEFAULTS,
  redisDefinition,
} from '../../../src/cloud-accounts/aws/definitions/redis-definition';
import { TofuRunner } from '../../../src/cloud-accounts/tofu/tofu-runner';
import { foundPostgres } from '../../../src/cloud-accounts/aws/plan-reader/existing-postgres';
import { isMissingReplicationGroup } from '../../../src/cloud-accounts/aws/plan-reader/existing-redis';
import type { TofuShowJson } from '../../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import type {
  TofuApplyOutcome,
  TofuPlanOutcome,
  TofuShow,
} from '../../../src/cloud-accounts/cloud.port';
import { closeMotoGaps } from './moto-gaps';
import { normalisePlan } from './normalise-plan';

/**
 * A `postgres` on RDS, a `redis` on ElastiCache and an
 * Existing database's lookup, their generated definitions run by the real
 * pinned OpenTofu and AWS provider, through the real runner, against moto,
 * as `moto-lane.moto-spec.ts` runs a `web`'s.
 *
 * The postgres goes the whole loop: it is planned and made, plans no
 * changes against its own state (the key property: its final snapshot's
 * name is dated the day the Service was made, never today), plans a new
 * class, new settings and a major upgrade, shows a change made by hand and
 * puts it back, and is deleted as a Delete deletes it: protection
 * lifted and the final snapshot named first, then destroyed, leaving the
 * snapshot. The lookup reads an instance made by hand, and finds nothing
 * for an identifier AWS has no instance of.
 *
 * A mysql on RDS goes the same loop as the postgres — made, clean,
 * changed by hand and put back, deleted leaving its final snapshot — from
 * the same definition with MySQL's engine and port (`mysql-create`).
 *
 * An existing redis's lookup is run for an id AWS has no
 * replication group of, and fails as its reader expects.
 *
 * The redis is planned only (`redis-create`): moto 5.2.3 has no cache
 * parameter groups and no ModifyReplicationGroup, so its apply and its
 * change plans (`redis-resize`, `redis-replica-on`, `redis-major-upgrade`)
 * stay hand-shaped; so do `existing-redis-lookup` (the provider fails
 * reading moto's replication group) and `existing-redis-serverless` (moto
 * has no serverless caches). See `MOTO_MISSING` in `moto-gaps.ts`.
 *
 * What moto cannot stand in for, this never claims: TLS, a real connection
 * to either, a real endpoint, the time a create takes, a snapshot's
 * contents, and the restart a class change brings. Those are the walk by
 * hand's (`docs/aws-walk-by-hand.md`).
 *
 * Needs `OPENTOFU_BINARY` and `OPENTOFU_PROVIDER_MIRROR` (filled by
 * `install-opentofu.sh`) and Docker. Run with `pnpm test:moto`.
 */

const MOTO_IMAGE = 'motoserver/moto:5.2.3';
const POSTGRES_IMAGE = 'postgres:17-alpine';

const REPO = resolve(__dirname, '..', '..', '..', '..');
const PLANS = resolve(__dirname, '..', 'fixtures', 'plans');

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const ENVIRONMENT = 'env_1';
const CLOUD_ACCOUNT = 'ca_1';
const APP_SECRET = 'moto-lane-app-encryption-secret';
const STATE_PASSWORD = 'moto-lane-state-login';
const CREDENTIAL = { accessKeyId: 'moto', secretAccessKey: 'moto' };

/** What the final snapshots are named after: the sample's Project and Environment, the day they were made. */
const SNAPSHOT_NAMES = {
  projectName: 'shop',
  environmentName: 'production',
  date: '2026-10-17',
};

const POSTGRES = { configName: 'pg-1', serviceId: 'svc_1', state: 'st_pg_1' };
/** A mysql on RDS: the same definition with MySQL's engine and port. */
const MYSQL = { configName: 'db-1', serviceId: 'svc_3', state: 'st_db_1' };
const REDIS = { configName: 'redis', serviceId: 'svc_2', state: 'st_redis' };
const LOOKUP_STATE = 'st_existing_1';
/** The instance the operator made by hand, and the version it runs. */
const EXISTING = { identifier: 'acme-prod', engineVersion: '17.4' };
const CACHE_LOOKUP_STATE = 'st_existing_2';

/** Stored with a fixture's values; a stand-in, never a real password. */
const MASTER_PASSWORD = 'moto-lane-master-password';
const AUTH_TOKEN = 'moto-lane-auth-token-0123456789';

const ACCOUNT_ACCESS = {
  awsAccountId: ACCOUNT,
  deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-deploy`,
  externalId: 'moto-lane-external-id',
  cloudAccountId: CLOUD_ACCOUNT,
};

/** Every AWS service the definitions and the hand changes reach. */
const ENDPOINTS = ['ec2', 'elasticache', 'iam', 'rds', 'sts'];

const SMALL: RdsPostgresSettings = {
  ...RDS_POSTGRES_DEFAULTS,
  instanceClass: 'db.t4g.micro',
};

let postgres: StartedPostgreSqlContainer;
let moto: StartedTestContainer;
let motoUrl: string;
let runner: TofuRunner;
let network: DatabaseNetworkIds;
const log: string[] = [];

function postgresRun(
  options: {
    settings?: RdsPostgresSettings;
    engineVersion?: string;
    allowMajorUpgrade?: boolean;
    deleting?: DeletingDatabase;
  } = {},
) {
  const engineVersion = options.engineVersion ?? '17';
  const generated = rdsDatabaseDefinition({
    engine: 'postgres',
    configName: POSTGRES.configName,
    serviceId: POSTGRES.serviceId,
    account: ACCOUNT_ACCESS,
    region: REGION,
    environmentId: ENVIRONMENT,
    stateId: POSTGRES.state,
    network,
    version: { engineVersion, autoMinorUpgrade: !engineVersion.includes('.') },
    settings: options.settings ?? SMALL,
    allowMajorUpgrade: options.allowMajorUpgrade ?? false,
    login: { user: 'shop', database: 'shop', password: MASTER_PASSWORD },
    finalSnapshot: SNAPSHOT_NAMES,
    ...(options.deleting ? { deleting: options.deleting } : {}),
  });
  return {
    stateId: POSTGRES.state,
    credential: CREDENTIAL,
    definition: generated.definition,
    variables: generated.variables,
    onLine: (line: string) => log.push(line),
  };
}

function mysqlRun(options: { deleting?: DeletingDatabase } = {}) {
  const generated = rdsDatabaseDefinition({
    engine: 'mysql',
    configName: MYSQL.configName,
    serviceId: MYSQL.serviceId,
    account: ACCOUNT_ACCESS,
    region: REGION,
    environmentId: ENVIRONMENT,
    stateId: MYSQL.state,
    network,
    version: { engineVersion: '8.4', autoMinorUpgrade: true },
    settings: SMALL,
    login: { user: 'shop', database: 'shop', password: MASTER_PASSWORD },
    finalSnapshot: SNAPSHOT_NAMES,
    ...(options.deleting ? { deleting: options.deleting } : {}),
  });
  return {
    stateId: MYSQL.state,
    credential: CREDENTIAL,
    definition: generated.definition,
    variables: generated.variables,
    onLine: (line: string) => log.push(line),
  };
}

function redisRun() {
  const generated = redisDefinition({
    configName: REDIS.configName,
    serviceId: REDIS.serviceId,
    account: ACCOUNT_ACCESS,
    region: REGION,
    environmentId: ENVIRONMENT,
    stateId: REDIS.state,
    network,
    version: { engineVersion: '7.2', parameterFamily: 'valkey7' },
    settings: { ...ELASTICACHE_REDIS_DEFAULTS, nodeType: 'cache.t4g.small' },
    authToken: AUTH_TOKEN,
    finalSnapshot: SNAPSHOT_NAMES,
  });
  return {
    stateId: REDIS.state,
    credential: CREDENTIAL,
    definition: generated.definition,
    variables: generated.variables,
    onLine: (line: string) => log.push(line),
  };
}

function lookupRun(identifier: string) {
  return {
    stateId: LOOKUP_STATE,
    credential: CREDENTIAL,
    definition: existingPostgresLookup({
      account: ACCOUNT_ACCESS,
      region: REGION,
      environmentId: ENVIRONMENT,
      stateId: LOOKUP_STATE,
      identifier,
    }),
    onLine: (line: string) => log.push(line),
  };
}

function cacheLookupRun(identifier: string) {
  return {
    stateId: CACHE_LOOKUP_STATE,
    credential: CREDENTIAL,
    definition: existingRedisLookup({
      account: ACCOUNT_ACCESS,
      region: REGION,
      environmentId: ENVIRONMENT,
      stateId: CACHE_LOOKUP_STATE,
      identifier,
    }),
    onLine: (line: string) => log.push(line),
  };
}

function shown(outcome: TofuPlanOutcome | TofuApplyOutcome): TofuShow {
  if (!outcome.ok) {
    const printed = log.splice(0).slice(-60).join('\n');
    throw new Error(`${outcome.reason}: ${outcome.message}\n${printed}`);
  }
  log.length = 0;
  return closeMotoGaps(outcome.show);
}

async function applied(outcome: Promise<TofuApplyOutcome>) {
  shown(await outcome);
}

interface Change {
  address: string;
  change: { actions: string[] };
}

/** Each resource's actions, `no-op`s left out. */
function actions(show: TofuShow): Record<string, string> {
  const changes = (show.resource_changes ?? []) as Change[];
  return Object.fromEntries(
    changes
      .filter((c) => c.change.actions.join() !== 'no-op')
      .map((c) => [c.address, c.change.actions.join()]),
  );
}

function drifted(show: TofuShow): string[] {
  return ((show.resource_drift ?? []) as Change[]).map((c) => c.address);
}

/** Re-saves a stored plan file, its run-to-run values made stable. */
function save(name: string, show: TofuShow) {
  const known = [network.vpcId, ...network.privateSubnetIds];
  writeFileSync(
    join(PLANS, `${name}.json`),
    `${JSON.stringify(normalisePlan(show, { motoUrl, known }), null, 2)}\n`,
  );
}

function aws<T>(Client: new (config: object) => T): T {
  return new Client({
    region: REGION,
    endpoint: motoUrl,
    credentials: CREDENTIAL,
  });
}

/** The Environment network's VPC and private subnets, as its Apply makes them. */
async function makeNetwork(): Promise<DatabaseNetworkIds> {
  const ec2 = aws(EC2Client);
  const vpc = await ec2.send(
    new CreateVpcCommand({ CidrBlock: NETWORK_ADDRESS_RANGE.vpc }),
  );
  const vpcId = vpc.Vpc!.VpcId!;
  const subnet = async (cidr: string, zone: string) =>
    (
      await ec2.send(
        new CreateSubnetCommand({
          VpcId: vpcId,
          CidrBlock: cidr,
          AvailabilityZone: `${REGION}${zone}`,
        }),
      )
    ).Subnet!.SubnetId!;
  const [a, b] = NETWORK_ADDRESS_RANGE.privateSubnets;
  return {
    vpcId,
    privateSubnetIds: [await subnet(a, 'a'), await subnet(b, 'b')],
  };
}

beforeAll(async () => {
  const binary = process.env.OPENTOFU_BINARY;
  const providerMirror = process.env.OPENTOFU_PROVIDER_MIRROR;
  if (!binary || !providerMirror) {
    throw new Error(
      'Set OPENTOFU_BINARY and OPENTOFU_PROVIDER_MIRROR: backend/test/cloud-accounts/moto/install-opentofu.sh <dir> fills them',
    );
  }

  [postgres, moto] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase('cloudgate').start(),
    new GenericContainer(MOTO_IMAGE)
      .withExposedPorts(5000)
      .withWaitStrategy(Wait.forHttp('/moto-api/', 5000))
      .start(),
  ]);
  motoUrl = `http://${moto.getHost()}:${moto.getMappedPort(5000)}`;

  const pool = new Pool({ connectionString: postgres.getConnectionUri() });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: join(REPO, 'backend/drizzle'),
    });
    await pool.query(
      `CREATE ROLE cloudgate_state LOGIN PASSWORD '${STATE_PASSWORD}'`,
    );
    await pool.query(
      readFileSync(join(REPO, 'deploy/opentofu/state-login.sql'), 'utf8'),
    );
  } finally {
    await pool.end();
  }
  const stateUrl = new URL(postgres.getConnectionUri());
  stateUrl.username = 'cloudgate_state';
  stateUrl.password = STATE_PASSWORD;
  stateUrl.searchParams.set('sslmode', 'disable');

  network = await makeNetwork();

  runner = new TofuRunner({
    binary,
    providerMirror,
    stateDatabaseUrl: stateUrl.toString(),
    appEncryptionSecret: APP_SECRET,
    pinsDirectory: join(REPO, 'deploy/opentofu'),
    providerOverride: {
      provider: {
        aws: {
          endpoints: Object.fromEntries(ENDPOINTS.map((s) => [s, motoUrl])),
        },
      },
    },
  });
}, 300_000);

afterAll(async () => {
  await Promise.all([postgres?.stop(), moto?.stop()]);
});

describe("a postgres on RDS's generated definition, against moto", () => {
  const snapshot = finalSnapshotIdentifier({
    ...SNAPSHOT_NAMES,
    configName: POSTGRES.configName,
  });

  it('plans a new instance, its DB subnet group and its security group', async () => {
    const show = shown(await runner.plan(postgresRun()));

    expect(actions(show)).toEqual({
      'aws_db_instance.database': 'create',
      'aws_db_subnet_group.database': 'create',
      'aws_security_group.database': 'create',
    });
    save('postgres-create', show);
  });

  it('applies it, then plans no changes against its own state (the key property)', async () => {
    await applied(runner.apply(postgresRun()));

    expect(actions(shown(await runner.plan(postgresRun())))).toEqual({});
  });

  it('plans a new class as a change of the instance alone', async () => {
    const show = shown(
      await runner.plan(
        postgresRun({ settings: { ...SMALL, instanceClass: 'db.t4g.medium' } }),
      ),
    );

    expect(actions(show)).toEqual({ 'aws_db_instance.database': 'update' });
    save('postgres-class-change', show);
  });

  it("plans Cloudgate's settings edited on its page as a change of the instance alone", async () => {
    const show = shown(
      await runner.plan(
        postgresRun({
          settings: {
            ...SMALL,
            storageGb: 50,
            maxStorageGb: 400,
            multiAz: true,
            backupRetentionDays: 14,
          },
        }),
      ),
    );

    expect(actions(show)).toEqual({ 'aws_db_instance.database': 'update' });
    save('postgres-settings-change', show);
  });

  it('plans an approved major upgrade in place', async () => {
    const show = shown(
      await runner.plan(
        postgresRun({ engineVersion: '18', allowMajorUpgrade: true }),
      ),
    );

    expect(actions(show)).toEqual({ 'aws_db_instance.database': 'update' });
    save('postgres-major-upgrade', show);
  });

  it('shows a change made by hand in the console, and puts it back', async () => {
    await aws(RDSClient).send(
      new ModifyDBInstanceCommand({
        DBInstanceIdentifier: 'cloudgate-svcx1',
        BackupRetentionPeriod: 3,
        ApplyImmediately: true,
      }),
    );
    const show = shown(await runner.plan(postgresRun()));

    expect(actions(show)).toEqual({ 'aws_db_instance.database': 'update' });
    expect(drifted(show)).toContain('aws_db_instance.database');

    await applied(runner.apply(postgresRun()));
    expect(actions(shown(await runner.plan(postgresRun())))).toEqual({});
  });

  it('is deleted as a Delete deletes it: protection lifted, the final snapshot named, then destroyed', async () => {
    const deleting = { finalSnapshot: snapshot };
    const prepared = shown(
      await runner.apply({
        ...postgresRun({ deleting }),
        targets: [POSTGRES_INSTANCE_ADDRESS],
      }),
    );
    expect(actions(prepared)).toEqual({ 'aws_db_instance.database': 'update' });

    await applied(runner.destroy(postgresRun({ deleting })));

    const rds = aws(RDSClient);
    const left = await rds.send(new DescribeDBInstancesCommand({}));
    expect(
      (left.DBInstances ?? []).map((one) => one.DBInstanceIdentifier),
    ).not.toContain('cloudgate-svcx1');
    const snapshots = await rds.send(
      new DescribeDBSnapshotsCommand({
        DBInstanceIdentifier: 'cloudgate-svcx1',
      }),
    );
    expect(
      (snapshots.DBSnapshots ?? []).map((one) => one.DBSnapshotIdentifier),
    ).toContain(snapshot);
  });
});

describe("a mysql on RDS's generated definition, against moto", () => {
  const snapshot = finalSnapshotIdentifier({
    ...SNAPSHOT_NAMES,
    configName: MYSQL.configName,
  });

  it('plans an RDS for MySQL instance on 3306, its DB subnet group and its security group', async () => {
    const show = shown(await runner.plan(mysqlRun()));

    expect(actions(show)).toEqual({
      'aws_db_instance.database': 'create',
      'aws_db_subnet_group.database': 'create',
      'aws_security_group.database': 'create',
    });
    save('mysql-create', show);
  });

  it('applies it, then plans no changes against its own state', async () => {
    await applied(runner.apply(mysqlRun()));

    const made = await aws(RDSClient).send(
      new DescribeDBInstancesCommand({
        DBInstanceIdentifier: 'cloudgate-svcx3',
      }),
    );
    expect(made.DBInstances?.[0]).toMatchObject({
      Engine: 'mysql',
      DBName: 'shop',
      MasterUsername: 'shop',
    });
    expect(actions(shown(await runner.plan(mysqlRun())))).toEqual({});
  });

  it('shows a change made by hand in the console, and puts it back', async () => {
    await aws(RDSClient).send(
      new ModifyDBInstanceCommand({
        DBInstanceIdentifier: 'cloudgate-svcx3',
        BackupRetentionPeriod: 3,
        ApplyImmediately: true,
      }),
    );
    const show = shown(await runner.plan(mysqlRun()));

    expect(actions(show)).toEqual({ 'aws_db_instance.database': 'update' });
    expect(drifted(show)).toContain('aws_db_instance.database');

    await applied(runner.apply(mysqlRun()));
    expect(actions(shown(await runner.plan(mysqlRun())))).toEqual({});
  });

  it('is deleted as a Delete deletes it, leaving its final snapshot', async () => {
    const deleting = { finalSnapshot: snapshot };
    await applied(
      runner.apply({
        ...mysqlRun({ deleting }),
        targets: [POSTGRES_INSTANCE_ADDRESS],
      }),
    );
    await applied(runner.destroy(mysqlRun({ deleting })));

    const rds = aws(RDSClient);
    const left = await rds.send(new DescribeDBInstancesCommand({}));
    expect(
      (left.DBInstances ?? []).map((one) => one.DBInstanceIdentifier),
    ).not.toContain('cloudgate-svcx3');
    const snapshots = await rds.send(
      new DescribeDBSnapshotsCommand({
        DBInstanceIdentifier: 'cloudgate-svcx3',
      }),
    );
    expect(
      (snapshots.DBSnapshots ?? []).map((one) => one.DBSnapshotIdentifier),
    ).toContain(snapshot);
  });
});

describe("a redis on ElastiCache's generated definition, against moto", () => {
  it('plans a new replication group, its parameter, subnet and security groups', async () => {
    const show = shown(await runner.plan(redisRun()));

    expect(actions(show)).toEqual({
      'aws_elasticache_parameter_group.valkey7': 'create',
      'aws_elasticache_replication_group.cache': 'create',
      'aws_elasticache_subnet_group.cache': 'create',
      'aws_security_group.cache': 'create',
    });
    save('redis-create', show);
  });
});

describe("an Existing database's lookup, against moto", () => {
  it('reads an instance made by hand, its address and its VPC, and plans nothing', async () => {
    const rds = aws(RDSClient);
    await rds.send(
      new CreateDBSubnetGroupCommand({
        DBSubnetGroupName: 'acme-subnets',
        DBSubnetGroupDescription: 'made by hand',
        SubnetIds: [...network.privateSubnetIds],
      }),
    );
    await rds.send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: EXISTING.identifier,
        Engine: 'postgres',
        EngineVersion: EXISTING.engineVersion,
        DBInstanceClass: 'db.t4g.micro',
        AllocatedStorage: 20,
        MasterUsername: 'acme',
        MasterUserPassword: MASTER_PASSWORD,
        DBSubnetGroupName: 'acme-subnets',
        Tags: [{ Key: 'Team', Value: 'shop' }],
      }),
    );
    const show = shown(await runner.plan(lookupRun(EXISTING.identifier)));

    expect(actions(show)).toEqual({});
    expect(foundPostgres(show as TofuShowJson)).toMatchObject({
      identifier: EXISTING.identifier,
      engine: 'postgres',
      engineVersion: EXISTING.engineVersion,
      port: 5432,
      vpcId: network.vpcId,
      tags: { Team: 'shop' },
    });
    save('existing-postgres-lookup', show);
  });

  it('finds nothing, and fails no plan, for an identifier AWS has no instance of', async () => {
    const show = shown(await runner.plan(lookupRun('acme-missing')));

    expect(foundPostgres(show as TofuShowJson)).toBeNull();
  });
});

describe('an Existing database that is a redis, its lookup against moto', () => {
  it('fails the plan for an id AWS has no replication group of, as the reader tells apart', async () => {
    const outcome = await runner.plan(cacheLookupRun('acme-missing'));
    log.length = 0;

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && isMissingReplicationGroup(outcome.message)).toBe(
      true,
    );
  });
});
