import { readdirSync, readFileSync } from 'node:fs';
import { stackVmPinsOn } from '../../../../src/cloud-accounts/definitions/stack-vm-pins';
import { join } from 'node:path';

import { bucketDefinition } from '../../../../src/cloud-accounts/aws/definitions/bucket-definition';
import { destroyDefinition } from '../../../../src/cloud-accounts/aws/definitions/destroy-definition';
import { rdsMysqlVersion } from '../../../../src/cloud-accounts/aws/definitions/mysql-version';
import { networkDefinition } from '../../../../src/cloud-accounts/aws/definitions/network-definition';
import {
  RDS_POSTGRES_DEFAULTS,
  rdsDatabaseDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/postgres-definition';
import { rdsPostgresVersion } from '../../../../src/cloud-accounts/aws/definitions/postgres-version';
import {
  ELASTICACHE_REDIS_DEFAULTS,
  redisDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/redis-definition';
import { stackVmDefinition } from '../../../../src/cloud-accounts/aws/definitions/stack-vm-definition';
import { valkeyVersion } from '../../../../src/cloud-accounts/aws/definitions/redis-version';
import { staticDefinition } from '../../../../src/cloud-accounts/aws/definitions/static-definition';
import { ecsDefinitionOf } from '../../../../src/cloud-accounts/aws/definitions/web-definition';
import { resources, sampleWebEntry } from './definition-helpers';
import type { RdsDatabaseDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/postgres-definition';
import type { EcsServiceDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/web-definition';

/**
 * EC2 refuses a security group whose description, or any of whose rules'
 * descriptions, is 256 characters or more or holds a character outside this
 * set, and refuses it only at Apply: a `tofu plan` takes it (where a
 * `web-private`'s apostrophe failed CreateSecurityGroup). The AWS provider
 * replaces a group whose description changes, so a fix after a release is a
 * replacement on every Environment that has one.
 */
const EC2_DESCRIPTION = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]{0,255}$/;

/** The separate security group rule resources, should any appear. */
const RULE_TYPES = new Set([
  'aws_security_group_rule',
  'aws_vpc_security_group_ingress_rule',
  'aws_vpc_security_group_egress_rule',
]);

/**
 * Where the producers live. The census reads this directory rather than a
 * list written by hand, so a new `*-definition.ts` fails here until it is
 * built below (`CODING_STANDARDS.md` §1.7).
 */
const DEFINITIONS_DIR = join(
  __dirname,
  '../../../../src/cloud-accounts/aws/definitions',
);

/**
 * Files in {@link DEFINITIONS_DIR} that name a security group type but build
 * no definition, each with what it does with the name instead.
 */
const NAMES_A_GROUP_WITHOUT_MAKING_ONE: Record<string, string> = {
  'imports.ts':
    'maps an existing group to its import id; the definition that adopts it is the one checked',
};

const ACCOUNT = {
  cloudAccountId: 'cloud-acct-1',
  awsAccountId: '123456789012',
  deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
  externalId: 'ext-abc',
};
const WHERE = { region: 'eu-west-1', environmentId: 'env-prod' };
const PRIVATE_NETWORK = {
  vpcId: 'vpc-0a1b',
  privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'] as const,
};
const FINAL_SNAPSHOT = {
  projectName: 'Shop',
  environmentName: 'production',
  date: '2026-10-25',
};

function ok<T>(
  read: ({ ok: true } & T) | { ok: false; refusal: { message: string } },
): T {
  if (!read.ok) throw new Error(read.refusal.message);
  return read;
}

/**
 * Not shared with `web-definition.spec.ts`'s `input()`: that one is a
 * `WebDefinitionInput` with no private DNS namespace, and this one feeds
 * `ecsDefinitionOf` for every kind, a Private web service among them.
 */
const ECS: Omit<EcsServiceDefinitionInput, 'routing'> = {
  configName: 'api',
  entry: sampleWebEntry('api'),
  service: { serviceId: 'App_Id-1', replicas: 2 },
  account: {
    ...ACCOUNT,
    taskExecutionRoleArn:
      'arn:aws:iam::123456789012:role/cloudgate/cloudgate-task-execution',
    permissionsBoundaryArn:
      'arn:aws:iam::123456789012:policy/cloudgate/cloudgate-task-boundary',
  },
  ...WHERE,
  stateId: 'state-api-1',
  network: {
    vpcId: 'vpc-0a1b',
    publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'],
    clusterArn: 'arn:aws:ecs:eu-west-1:123456789012:cluster/cloudgate-env-prod',
    httpsListenerArn:
      'arn:aws:elasticloadbalancing:eu-west-1:123456789012:listener/app/cg-x/1/2',
    albSecurityGroupId: 'sg-0alb',
    privateDnsNamespaceId: 'ns-0private',
  },
  image: { tag: 'dep-42', architecture: 'amd64' },
  variables: { values: {}, digestSecret: 'a-test-secret' },
};

interface Built {
  /** The `*-definition.ts` file in {@link DEFINITIONS_DIR} that built it. */
  readonly from: string;
  readonly definition: Record<string, unknown>;
}

function ecs(kind: string): Built {
  return {
    from: 'web-definition.ts',
    definition: ok(ecsDefinitionOf(kind, ECS, { port: 4000, domains: [] }))
      .definition,
  };
}

function rds(
  engine: RdsDatabaseDefinitionInput['engine'],
  version: RdsDatabaseDefinitionInput['version'],
): Built {
  return {
    from: 'postgres-definition.ts',
    definition: rdsDatabaseDefinition({
      engine,
      configName: 'db-1',
      serviceId: 'Db_Id-1',
      account: ACCOUNT,
      ...WHERE,
      stateId: 'state-db-1',
      network: PRIVATE_NETWORK,
      version,
      settings: { ...RDS_POSTGRES_DEFAULTS, instanceClass: 'db.t4g.micro' },
      login: { user: 'shop', database: 'shop', password: 'generated' },
      finalSnapshot: FINAL_SNAPSHOT,
    }).definition,
  };
}

/**
 * Every AWS definition the repo generates, by what it is. A file that makes
 * no security group is built here too, so the census sees it make none rather
 * than taking a declaration's word for it.
 */
const BUILT: Record<string, Built> = {
  network: {
    from: 'network-definition.ts',
    definition: networkDefinition({
      cloudAccountId: ACCOUNT.cloudAccountId,
      account: ACCOUNT,
      ...WHERE,
      stateId: 'state-network-1',
    }),
  },
  'network with private DNS': {
    from: 'network-definition.ts',
    definition: networkDefinition({
      cloudAccountId: ACCOUNT.cloudAccountId,
      account: ACCOUNT,
      ...WHERE,
      stateId: 'state-network-1',
      privateLinks: ['private-dns'],
    }),
  },
  'web (public target group)': ecs('web'),
  'worker (routing none)': ecs('worker'),
  'web-private (private DNS)': ecs('web-private'),
  cron: ecs('cron'),
  postgres: rds(
    'postgres',
    ok(rdsPostgresVersion('db-1', 'postgres:17')).version,
  ),
  mysql: rds('mysql', ok(rdsMysqlVersion('db-1', 'mysql:8.4')).version),
  redis: {
    from: 'redis-definition.ts',
    definition: redisDefinition({
      configName: 'redis',
      serviceId: 'Redis_Id-1',
      account: ACCOUNT,
      ...WHERE,
      stateId: 'state-redis',
      network: PRIVATE_NETWORK,
      version: ok(valkeyVersion('redis', 'redis:8')).version,
      settings: { ...ELASTICACHE_REDIS_DEFAULTS, nodeType: 'cache.t4g.small' },
      authToken: 'a'.repeat(32) + 'b'.repeat(32),
      finalSnapshot: FINAL_SNAPSHOT,
    }).definition,
  },
  'compose (Stack VM)': {
    from: 'stack-vm-definition.ts',
    definition: stackVmDefinition({
      configName: 'analytics',
      serviceId: 'Cmp_Id-1',
      account: ACCOUNT,
      ...WHERE,
      stateId: 'state-analytics',
      network: PRIVATE_NETWORK,
      machineType: 't3.small',
      zone: null,
      pins: stackVmPinsOn('aws'),
      dataDiskGb: 20,
      snapshotDays: 7,
      imageId: null,
      sshPublicKey: null,
    }).definition,
  },
  static: {
    from: 'static-definition.ts',
    definition: staticDefinition({
      configName: 'docs',
      serviceId: 'app_static_1',
      bucketName: 'docs-p4x8m2rt-123456789012-eu-west-1-an',
      spa: false,
      account: ACCOUNT,
      ...WHERE,
      stateId: 'state-static-1',
      liveFolder: null,
    }),
  },
  bucket: {
    from: 'bucket-definition.ts',
    definition: bucketDefinition({
      configName: 'uploads',
      bucketName: 'uploads-k3f9a2qd-123456789012-eu-west-1-an',
      account: ACCOUNT,
      ...WHERE,
      stateId: 'state-bucket-1',
      origins: [],
    }),
  },
  destroy: {
    from: 'destroy-definition.ts',
    definition: destroyDefinition(ACCOUNT, WHERE.region, {
      cloudAccountId: ACCOUNT.cloudAccountId,
      environmentId: WHERE.environmentId,
      stateId: 'state-destroy-1',
    }),
  },
};

/** Every source file in {@link DEFINITIONS_DIR}, by basename. */
const SOURCES = readdirSync(DEFINITIONS_DIR).filter((file) =>
  file.endsWith('.ts'),
);

/** Every security group and rule description in a definition, by where. */
function descriptions(
  definition: Record<string, unknown>,
): { where: string; description: unknown }[] {
  return resources(definition).flatMap(({ address, type, body }) => {
    if (RULE_TYPES.has(type)) {
      return [{ where: address, description: body.description }];
    }
    if (type !== 'aws_security_group') return [];
    const rules = (side: 'ingress' | 'egress') =>
      ((body[side] ?? []) as Record<string, unknown>[]).map((rule, i) => ({
        where: `${address}.${side}[${i}]`,
        description: rule.description,
      }));
    return [
      { where: address, description: body.description },
      ...rules('ingress'),
      ...rules('egress'),
    ];
  });
}

describe('backend/src/cloud-accounts/aws/definitions — every security group and rule description', () => {
  describe('the census', () => {
    it('builds a definition from every *-definition.ts, and from no file that is gone', () => {
      const producers = SOURCES.filter((file) =>
        file.endsWith('-definition.ts'),
      ).sort();
      const built = [
        ...new Set(Object.values(BUILT).map(({ from }) => from)),
      ].sort();

      expect(built).toEqual(producers);
    });

    it('builds every file that names a security group type, or says what it does with the name', () => {
      const naming = SOURCES.filter((file) =>
        /['"`]aws_(?:vpc_)?security_group/.test(
          readFileSync(join(DEFINITIONS_DIR, file), 'utf8'),
        ),
      ).sort();
      const accounted = [
        ...new Set([
          ...Object.values(BUILT).map(({ from }) => from),
          ...Object.keys(NAMES_A_GROUP_WITHOUT_MAKING_ONE),
        ]),
      ].filter((file) => naming.includes(file));

      expect(accounted.sort()).toEqual(naming);
      // A declaration whose file stopped naming a group is an amnesty for
      // nothing, so it goes.
      expect(
        Object.keys(NAMES_A_GROUP_WITHOUT_MAKING_ONE).filter(
          (file) => !naming.includes(file),
        ),
      ).toEqual([]);
    });

    it('finds a security group wherever one is made, so it is not empty', () => {
      const grouped = Object.entries(BUILT)
        .filter(([, { definition }]) =>
          resources(definition).some((r) => r.type === 'aws_security_group'),
        )
        .map(([name]) => name);
      expect(grouped).toEqual([
        'network',
        'network with private DNS',
        'web (public target group)',
        'worker (routing none)',
        'web-private (private DNS)',
        'cron',
        'postgres',
        'mysql',
        'redis',
        'compose (Stack VM)',
      ]);
    });
  });

  it.each(Object.keys(BUILT))('%s: every one is a string EC2 takes', (name) => {
    const refused = descriptions(BUILT[name].definition).filter(
      ({ description }) =>
        typeof description !== 'string' || !EC2_DESCRIPTION.test(description),
    );
    expect(refused).toEqual([]);
  });
});
