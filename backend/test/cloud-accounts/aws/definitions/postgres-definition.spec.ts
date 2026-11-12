import { NETWORK_ADDRESS_RANGE } from '../../../../src/cloud-accounts/aws/definitions/network-definition';
import {
  MASTER_PASSWORD_VARIABLE,
  RDS_POSTGRES_DEFAULTS,
  finalSnapshotIdentifier,
  rdsDatabaseDefinition,
  rdsInstanceIdentifier,
} from '../../../../src/cloud-accounts/aws/definitions/postgres-definition';
import { rdsPostgresVersion } from '../../../../src/cloud-accounts/aws/definitions/postgres-version';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import {
  addresses,
  effectiveTags,
  resource,
  taggableResources,
} from './definition-helpers';
import type { RdsDatabaseDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/postgres-definition';

const PASSWORD = 'a-generated-password-never-in-the-file';

function version(image: string) {
  const read = rdsPostgresVersion('pg-1', image);
  if (!read.ok) throw new Error(read.refusal.message);
  return read.version;
}

function input(
  overrides: Partial<RdsDatabaseDefinitionInput> = {},
): RdsDatabaseDefinitionInput {
  return {
    engine: 'postgres',
    configName: 'pg-1',
    serviceId: 'Pg_Id-1',
    account: {
      cloudAccountId: 'cloud-acct-1',
      awsAccountId: '123456789012',
      deployRoleArn:
        'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
      externalId: 'ext-abc',
    },
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-pg-1',
    network: {
      vpcId: 'vpc-0a1b',
      privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
    },
    version: version('postgres:17'),
    settings: { ...RDS_POSTGRES_DEFAULTS, instanceClass: 'db.t4g.micro' },
    login: { user: 'shop', database: 'shop', password: PASSWORD },
    finalSnapshot: {
      projectName: 'Shop',
      environmentName: 'production',
      date: '2026-10-17',
    },
    ...overrides,
  };
}

const INSTANCE = 'aws_db_instance.database';

describe('rdsDatabaseDefinition, a postgres', () => {
  it('holds one RDS instance, its subnet group and its security group', () => {
    const { definition } = rdsDatabaseDefinition(input());

    expect(addresses(definition)).toEqual([
      'aws_db_instance.database',
      'aws_db_subnet_group.database',
      'aws_security_group.database',
    ]);
  });

  it("puts the instance in the Environment network's two private subnets, never public", () => {
    const { definition } = rdsDatabaseDefinition(input());

    expect(resource(definition, 'aws_db_subnet_group.database')).toMatchObject({
      subnet_ids: ['subnet-0ccc', 'subnet-0ddd'],
    });
    expect(resource(definition, INSTANCE)).toMatchObject({
      publicly_accessible: false,
      db_subnet_group_name: '${aws_db_subnet_group.database.name}',
      vpc_security_group_ids: ['${aws_security_group.database.id}'],
    });
  });

  it.each(['postgres:17', 'postgres:16.4', 'postgres:18-alpine'])(
    'is never publicly accessible, whatever the version (%s)',
    (image) => {
      const { definition } = rdsDatabaseDefinition(
        input({ version: version(image) }),
      );

      expect(resource(definition, INSTANCE).publicly_accessible).toBe(false);
      expect(renderDefinition(definition)).not.toContain(
        '"publicly_accessible": true',
      );
    },
  );

  it('admits PostgreSQL only from the subnets where the Environment’s Services run', () => {
    const { definition } = rdsDatabaseDefinition(input());
    const group = resource(definition, 'aws_security_group.database') as {
      vpc_id: string;
      ingress: Record<string, unknown>[];
      egress: unknown[];
    };

    expect(group.vpc_id).toBe('vpc-0a1b');
    expect(group.ingress).toHaveLength(2);
    expect(group.ingress.map((one) => one.cidr_blocks)).toEqual(
      NETWORK_ADDRESS_RANGE.publicSubnets.map((cidr) => [cidr]),
    );
    for (const one of group.ingress) {
      expect(one).toMatchObject({
        from_port: 5432,
        to_port: 5432,
        protocol: 'tcp',
        security_groups: [],
      });
    }
    expect(JSON.stringify(group)).not.toContain('0.0.0.0/0');
    expect(group.egress).toEqual([]);
  });

  it("sets every argument the spec names, from Cloudgate's settings", () => {
    const { definition } = rdsDatabaseDefinition(input());

    expect(resource(definition, INSTANCE)).toMatchObject({
      identifier: 'cloudgate-pgxidx1',
      engine: 'postgres',
      instance_class: 'db.t4g.micro',
      storage_type: 'gp3',
      allocated_storage: 20,
      max_allocated_storage: 200,
      multi_az: false,
      apply_immediately: true,
      backup_retention_period: 7,
      deletion_protection: true,
      skip_final_snapshot: false,
      final_snapshot_identifier: 'shop-production-pg-1-final-2026-10-17',
      copy_tags_to_snapshot: true,
      db_name: 'shop',
      username: 'shop',
      port: 5432,
    });
  });

  it("writes protection off and the Delete's own snapshot for a Delete's run", () => {
    const { definition } = rdsDatabaseDefinition(
      input({
        deleting: { finalSnapshot: 'shop-production-pg-1-final-2026-12-01' },
      }),
    );

    expect(resource(definition, INSTANCE)).toMatchObject({
      deletion_protection: false,
      skip_final_snapshot: false,
      final_snapshot_identifier: 'shop-production-pg-1-final-2026-12-01',
      copy_tags_to_snapshot: true,
      // A Delete's check counts the automated snapshots gone with it.
      delete_automated_backups: true,
    });
  });

  it('skips the final snapshot for a Delete that asked for the data to go', () => {
    const { definition } = rdsDatabaseDefinition(
      input({ deleting: { finalSnapshot: null } }),
    );

    expect(resource(definition, INSTANCE)).toMatchObject({
      deletion_protection: false,
      skip_final_snapshot: true,
      final_snapshot_identifier: null,
    });
  });

  it("runs a major alone on RDS's default minor with automatic minor upgrades", () => {
    const { definition } = rdsDatabaseDefinition(input());

    expect(resource(definition, INSTANCE)).toMatchObject({
      engine_version: '17',
      auto_minor_version_upgrade: true,
      allow_major_version_upgrade: false,
    });
  });

  it('allows a major upgrade only for the run that approved one', () => {
    const { definition } = rdsDatabaseDefinition(
      input({ version: version('postgres:18'), allowMajorUpgrade: true }),
    );

    expect(resource(definition, INSTANCE)).toMatchObject({
      engine_version: '18',
      allow_major_version_upgrade: true,
    });
  });

  it("writes the console's class, storage, Multi-AZ and retention as they are", () => {
    const { definition } = rdsDatabaseDefinition(
      input({
        settings: {
          instanceClass: 'db.t4g.medium',
          storageGb: 50,
          maxStorageGb: 400,
          multiAz: true,
          backupRetentionDays: 14,
        },
      }),
    );

    expect(resource(definition, INSTANCE)).toMatchObject({
      instance_class: 'db.t4g.medium',
      allocated_storage: 50,
      max_allocated_storage: 400,
      multi_az: true,
      backup_retention_period: 14,
      apply_immediately: true,
    });
  });

  it('pins a minor with automatic minor upgrades off', () => {
    const { definition } = rdsDatabaseDefinition(
      input({ version: version('postgres:17.2') }),
    );

    expect(resource(definition, INSTANCE)).toMatchObject({
      engine_version: '17.2',
      auto_minor_version_upgrade: false,
    });
  });

  it('hands the password to tofu as a sensitive variable, never in the file', () => {
    const { definition, variables } = rdsDatabaseDefinition(input());

    expect(resource(definition, INSTANCE).password).toBe(
      `\${var.${MASTER_PASSWORD_VARIABLE}}`,
    );
    expect(
      (definition.variable as Record<string, unknown>)[
        MASTER_PASSWORD_VARIABLE
      ],
    ).toMatchObject({ sensitive: true });
    expect(variables).toEqual({ [MASTER_PASSWORD_VARIABLE]: PASSWORD });
    expect(renderDefinition(definition)).not.toContain(PASSWORD);
  });

  it("tags every resource with Cloudgate's mark and its own address", () => {
    const { definition } = rdsDatabaseDefinition(input());

    for (const found of taggableResources(definition)) {
      expect(effectiveTags(definition, found.body)).toMatchObject({
        'cloudgate:cloud-account': 'cloud-acct-1',
        'cloudgate:environment': 'env-prod',
        'cloudgate:state': 'state-pg-1',
        'cloudgate:address': found.address,
      });
    }
  });

  it('writes the same bytes for the same input', () => {
    expect(renderDefinition(rdsDatabaseDefinition(input()).definition)).toBe(
      renderDefinition(rdsDatabaseDefinition(input()).definition),
    );
  });
});

describe('finalSnapshotIdentifier', () => {
  it('is <project>-<environment>-<service>-final-<date>, folded for RDS', () => {
    expect(
      finalSnapshotIdentifier({
        projectName: 'My Shop!',
        environmentName: 'Prod_EU',
        configName: 'pg-1',
        date: '2026-10-17',
      }),
    ).toBe('my-shop-prod-eu-pg-1-final-2026-10-17');
  });

  it('starts with a letter, as RDS requires', () => {
    expect(
      finalSnapshotIdentifier({
        projectName: '42 shop',
        environmentName: 'prod',
        configName: 'db',
        date: '2026-10-17',
      }),
    ).toMatch(/^[a-z]/);
  });
});

describe('rdsInstanceIdentifier', () => {
  it('folds a Service id into lower-case letters and digits', () => {
    expect(rdsInstanceIdentifier('Ab_C-d9')).toBe('cloudgate-abxcxd9');
  });
});
