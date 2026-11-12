import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NETWORK_ADDRESS_RANGE } from '../../../../src/cloud-accounts/aws/definitions/network-definition';
import {
  RDS_POSTGRES_DEFAULTS,
  rdsDatabaseDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/postgres-definition';
import type { RdsDatabaseDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/postgres-definition';
import { RDS_ENGINES } from '../../../../src/cloud-accounts/aws/definitions/rds-engines';
import { rdsMysqlVersion } from '../../../../src/cloud-accounts/aws/definitions/mysql-version';
import { rdsMysqlNameRefusal } from '../../../../src/cloud-accounts/aws/definitions/rds-names';
import { judgeLookup } from '../../../../src/cloud-accounts/aws/plan-reader/existing-postgres';
import type {
  FoundPostgres,
  LookupContext,
} from '../../../../src/cloud-accounts/aws/plan-reader/existing-postgres';
import { readPlan } from '../../../../src/cloud-accounts/aws/plan-reader/read-plan';
import type { TofuShowJson } from '../../../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import { resource } from './definition-helpers';

/**
 * A `mysql` on RDS: `postgres` on RDS's definition and rules with
 * MySQL's parameters — its engine, port 3306, `db_name` always set, RDS's
 * default parameter group, MySQL 8.4 and MySQL's names.
 */

const INSTANCE = 'aws_db_instance.database';

function version(image: string) {
  const read = rdsMysqlVersion('db-1', image);
  if (!read.ok) throw new Error(read.refusal.message);
  return read.version;
}

function input(
  overrides: Partial<RdsDatabaseDefinitionInput> = {},
): RdsDatabaseDefinitionInput {
  return {
    engine: 'mysql',
    configName: 'db-1',
    serviceId: 'My_Id-1',
    account: {
      cloudAccountId: 'cloud-acct-1',
      awsAccountId: '123456789012',
      deployRoleArn:
        'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
      externalId: 'ext-abc',
    },
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-db-1',
    network: {
      vpcId: 'vpc-0a1b',
      privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
    },
    version: version('mysql:8.4'),
    settings: { ...RDS_POSTGRES_DEFAULTS, instanceClass: 'db.t4g.micro' },
    login: { user: 'shop', database: 'shop', password: 'generated' },
    finalSnapshot: {
      projectName: 'Shop',
      environmentName: 'production',
      date: '2026-10-24',
    },
    ...overrides,
  };
}

describe('rdsDatabaseDefinition, a mysql', () => {
  it('is an RDS for MySQL instance on 3306, its database always named', () => {
    const { definition } = rdsDatabaseDefinition(input());

    expect(resource(definition, INSTANCE)).toMatchObject({
      identifier: 'cloudgate-myxidx1',
      engine: 'mysql',
      engine_version: '8.4',
      auto_minor_version_upgrade: true,
      instance_class: 'db.t4g.micro',
      storage_type: 'gp3',
      allocated_storage: 20,
      max_allocated_storage: 200,
      multi_az: false,
      publicly_accessible: false,
      apply_immediately: true,
      backup_retention_period: 7,
      deletion_protection: true,
      final_snapshot_identifier: 'shop-production-db-1-final-2026-10-24',
      db_name: 'shop',
      username: 'shop',
      port: 3306,
    });
  });

  it("keeps RDS's default parameter group, so TLS is not required", () => {
    const { definition } = rdsDatabaseDefinition(input());

    expect(resource(definition, INSTANCE)).not.toHaveProperty(
      'parameter_group_name',
    );
    expect(JSON.stringify(definition)).not.toContain('aws_db_parameter_group');
  });

  it('admits 3306 only from the subnets where the Environment’s Services run', () => {
    const group = resource(
      rdsDatabaseDefinition(input()).definition,
      'aws_security_group.database',
    ) as { ingress: Record<string, unknown>[]; egress: unknown[] };

    expect(group.ingress.map((one) => one.cidr_blocks)).toEqual(
      NETWORK_ADDRESS_RANGE.publicSubnets.map((cidr) => [cidr]),
    );
    for (const one of group.ingress) {
      expect(one).toMatchObject({ from_port: 3306, to_port: 3306 });
    }
    expect(group.egress).toEqual([]);
  });

  it("is postgres's definition with only MySQL's parameters changed", () => {
    const mysql = rdsDatabaseDefinition(input()).definition;
    const postgres = rdsDatabaseDefinition(
      input({
        engine: 'postgres',
        version: { engineVersion: '17', autoMinorUpgrade: true },
      }),
    ).definition;
    const differing = (
      one: Record<string, unknown>,
      other: Record<string, unknown>,
    ) =>
      Object.keys(one)
        .filter(
          (key) => JSON.stringify(one[key]) !== JSON.stringify(other[key]),
        )
        .sort();

    expect(
      differing(resource(mysql, INSTANCE), resource(postgres, INSTANCE)),
    ).toEqual(['engine', 'engine_version', 'port']);
  });
});

describe('rdsMysqlVersion', () => {
  it("runs no version as RDS's default 8.4 minor, minor upgrades automatic", () => {
    expect(rdsMysqlVersion('db-1', RDS_ENGINES.mysql.defaultImage)).toEqual({
      ok: true,
      version: {
        written: '8.4',
        major: 8.4,
        minor: null,
        engineVersion: '8.4',
        autoMinorUpgrade: true,
        droppedSuffix: null,
      },
    });
  });

  it('pins a minor with automatic minor upgrades off', () => {
    expect(rdsMysqlVersion('db-1', 'mysql:8.4.11')).toMatchObject({
      ok: true,
      version: {
        written: '8.4.11',
        major: 8.4,
        minor: 11,
        engineVersion: '8.4.11',
        autoMinorUpgrade: false,
      },
    });
  });

  it('drops an image suffix and says so', () => {
    expect(rdsMysqlVersion('db-1', 'mysql:8.4-oracle')).toMatchObject({
      ok: true,
      version: { engineVersion: '8.4', droppedSuffix: '-oracle' },
    });
  });

  it.each([
    ['mysql:8.0', 'MySQL 8.0'],
    ['mysql:8.0.40', 'MySQL 8.0'],
    ['mysql:9.1', 'MySQL 9.1'],
    ['mysql:9.7', 'MySQL 9.7'],
    ['mysql:5.7', 'MySQL 5.7'],
  ])('refuses %s by name', (image, named) => {
    const read = rdsMysqlVersion('db-1', image);

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.at).toBe('db-1.version');
    expect(read.refusal.message).toContain(named);
    expect(read.refusal.message).toContain('"8.4"');
  });

  it('says 8.0 is paid Extended Support on RDS', () => {
    const read = rdsMysqlVersion('db-1', 'mysql:8.0');

    expect(!read.ok && read.refusal.message).toContain('Extended Support');
  });

  it.each(['mysql:8', 'mysql:latest', 'mysql:lts'])(
    'refuses %s, which names no RDS major',
    (image) => {
      const read = rdsMysqlVersion('db-1', image);

      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.refusal.message).toContain(image.slice('mysql:'.length));
      expect(read.refusal.message).toContain('"8.4"');
    },
  );
});

describe('rdsMysqlNameRefusal', () => {
  it.each(['app', 'shop_1', 'Admin2', 'a'.repeat(16)])(
    'takes %s as a user',
    (name) => {
      expect(rdsMysqlNameRefusal('db-1', 'user', name)).toBeNull();
    },
  );

  it.each([
    ['root', 'root'],
    ['ROOT', 'root'],
    ['a'.repeat(17), '1 to 16'],
    ['app-user', 'letters, digits or underscores'],
    ['1app', 'starting with a letter'],
    ['rdsadmin', 'reserved'],
    ['select', 'reserved'],
  ])('refuses %s as a user, naming the field', (name, why) => {
    const refusal = rdsMysqlNameRefusal('db-1', 'user', name);

    expect(refusal?.at).toBe('db-1.user');
    expect(refusal?.message).toContain('MySQL');
    expect(refusal?.message).toContain(why);
  });

  it('says root is a Server’s only', () => {
    expect(rdsMysqlNameRefusal('db-1', 'user', 'root')?.message).toContain(
      'Server',
    );
  });

  it.each(['shop', 'a'.repeat(64), 'pg_1'])(
    'takes %s as a database',
    (name) => {
      expect(rdsMysqlNameRefusal('db-1', 'database', name)).toBeNull();
    },
  );

  it.each([
    ['a'.repeat(65), '1 to 64'],
    ['my-db', 'letters, digits or underscores'],
    ['mysql', 'reserved'],
    ['information_schema', 'reserved'],
    ['table', 'reserved'],
  ])('refuses %s as a database', (name, why) => {
    const refusal = rdsMysqlNameRefusal('db-1', 'database', name);

    expect(refusal?.at).toBe('db-1.database');
    expect(refusal?.message).toContain(why);
  });
});

describe('judgeLookup, a mysql', () => {
  const context: LookupContext = {
    engine: 'mysql',
    serviceName: 'db-1',
    identifier: 'acme-prod',
    cloudAccount: 'Production AWS (123456789012)',
    region: 'eu-central-1',
    networkVpcId: 'vpc-00000000000000001',
    madeReachable: false,
    configVersion: null,
  };
  const found: FoundPostgres = {
    identifier: 'acme-prod',
    engine: 'mysql',
    engineVersion: '8.4.6',
    host: 'acme-prod.aaaaaaaaaa.eu-central-1.rds.amazonaws.com',
    port: 3306,
    vpcId: 'vpc-00000000000000001',
    tags: {},
  };

  it('uses a MySQL instance as given', () => {
    expect(judgeLookup(found, context)).toEqual({
      ok: true,
      address: { host: found.host, port: 3306 },
      lines: [
        `db-1: existing database acme-prod, MySQL 8.4.6, at ${found.host}:3306; used as given, Cloudgate changes nothing in it`,
      ],
    });
  });

  it('refuses a PostgreSQL instance named as a mysql', () => {
    const verdict = judgeLookup({ ...found, engine: 'postgres' }, context);

    expect(verdict).toEqual({
      ok: false,
      reason:
        'db-1 uses the existing database acme-prod, but acme-prod runs postgres, not MySQL, so a mysql cannot use it',
    });
  });

  it('refuses a MySQL instance named as a postgres', () => {
    const verdict = judgeLookup(found, { ...context, engine: 'postgres' });

    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain('not PostgreSQL');
  });
});

describe('readPlan, a mysql on RDS', () => {
  /** The stored RDS create, its instance a MySQL one. */
  function mysqlCreate(): TofuShowJson {
    const show = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', 'fixtures', 'plans', 'mysql-create.json'),
        'utf8',
      ),
    ) as TofuShowJson;
    return show;
  }

  it('shows the size beside the class, then storage, backups and MySQL 8.4', () => {
    const reading = readPlan({
      show: mysqlCreate(),
      tagSearch: [],
      context: { serviceName: 'db-1', sizeName: 'small' },
    });

    expect(reading.summary).toEqual(
      expect.arrayContaining([
        'db-1 small → db.t4g.micro (2 vCPU, 1 GB)',
        'db-1 storage: 20 GB gp3, grows to 200 GB',
        'db-1 backups: kept 7 days',
        "db-1 version: MySQL 8.4, RDS's default minor, minor upgrades automatic",
      ]),
    );
    expect(reading.summary.join('\n')).not.toContain('PostgreSQL');
  });

  it('marks a new 8.4 minor as a restart, never a major upgrade', () => {
    const show = mysqlCreate();
    const change = (show.resource_changes ?? []).find(
      (one) => one.type === 'aws_db_instance',
    )!;
    const after = change.change.after as Record<string, unknown>;
    const moved: TofuShowJson = {
      ...show,
      resource_changes: [
        {
          ...change,
          change: {
            ...change.change,
            actions: ['update'],
            before: { ...after, engine_version: '8.4.5' },
            after: { ...after, engine_version: '8.4.6' },
          },
        },
      ],
    };

    const reading = readPlan({
      show: moved,
      tagSearch: [],
      context: { serviceName: 'db-1' },
    });

    expect(reading.outages).toEqual([
      {
        kind: 'restart',
        serviceName: 'db-1',
        line: 'restarts db-1: a few minutes offline',
      },
    ]);
  });
});
