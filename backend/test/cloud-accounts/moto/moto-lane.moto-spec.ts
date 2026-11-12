import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { DeleteServiceCommand, ECSClient } from '@aws-sdk/client-ecs';
import {
  CreatePolicyCommand,
  IAMClient,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

import { makeDefaultCertificate } from '../../../src/cloud-accounts/definitions/default-certificate';
import {
  networkDefinition,
  NETWORK_OUTPUTS,
} from '../../../src/cloud-accounts/aws/definitions/network-definition';
import { DEFAULT_CERTIFICATE_VARIABLES } from '../../../src/cloud-accounts/definitions/default-certificate';
import {
  networkStandIns,
  PRIVATE_DNS_NAMESPACE_STAND_IN,
  STAND_IN_IMAGE_TAG,
} from '../../../src/cloud-accounts/aws/definitions/stand-ins';
import type { NetworkLinkKind } from '../../../src/cloud-accounts/definitions/network-links';
import type { NetworkIds } from '../../../src/cloud-accounts/aws/definitions/stand-ins';
import {
  CRON_OUTPUTS,
  cronTaskDefinition,
  discoveryDigest,
  ecsRoutingOf,
  ecsServiceDefinition,
  ecsServiceName,
  logGroupName,
  serviceSecurityGroupName,
  webDefinition,
} from '../../../src/cloud-accounts/aws/definitions/web-definition';
import { TofuRunner } from '../../../src/cloud-accounts/tofu/tofu-runner';
import type {
  TofuApplyOutcome,
  TofuPlanOutcome,
  TofuShow,
} from '../../../src/cloud-accounts/cloud.port';
// From the files themselves: the module's index pulls in Nest, which this
// lane's plain jest config does not transform.
import { parseProjectConfig } from '../../../src/project-config/format/parse-config';
import type { WebEntry } from '../../../src/project-config/project-config.types';
import { closeMotoGaps } from './moto-gaps';
import { normalisePlan } from './normalise-plan';

/**
 * Seam 4 of the spec: the generated definitions run by the real pinned
 * OpenTofu and AWS provider, through the real runner, against moto.
 *
 * It proves the sample `web`, a Worker, a Private web service
 * a Cron service with no ECS service and their
 * Environment network apply, plan clean
 * against their own state, show a change made by hand, and destroy; and it
 * re-saves the stored plan files (`test/cloud-accounts/fixtures/plans/`)
 * that the in-memory cloud port replays in every e2e spec.
 *
 * What moto cannot stand in for, this never claims: the tag search after a
 * Delete, ENIs AWS makes, DNS validation of a certificate, running
 * containers, and routing. moto accepts every call these definitions make
 * and runs nothing.
 *
 * Needs `OPENTOFU_BINARY` and `OPENTOFU_PROVIDER_MIRROR` (filled by
 * `install-opentofu.sh`) and Docker. Run with `pnpm test:moto`.
 */

/** moto's own image, pinned like everything else this lane runs. */
const MOTO_IMAGE = 'motoserver/moto:5.2.3';
const POSTGRES_IMAGE = 'postgres:17-alpine';

const REPO = resolve(__dirname, '..', '..', '..', '..');
const PLANS = resolve(__dirname, '..', 'fixtures', 'plans');

/** moto's default account: an assumed role's session is in the role's. */
const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const ENVIRONMENT = 'env_1';
const CLOUD_ACCOUNT = 'cloud_1';
const SERVICE = 'svc_1';
const CONFIG_NAME = 'api';
const NETWORK_STATE = 'state_network_1';
const WEB_STATE = 'state_web_1';
const WORKER = {
  configName: 'jobs',
  serviceId: 'svc_2',
  state: 'state_worker_1',
} as const;
const INTERNAL = {
  configName: 'inside',
  serviceId: 'svc_3',
  state: 'state_web_private_1',
} as const;
const CRON = {
  configName: 'nightly',
  serviceId: 'svc_4',
  state: 'state_cron_1',
} as const;
const APP_SECRET = 'moto-lane-app-encryption-secret';
const STATE_PASSWORD = 'moto-lane-state-login';
const CREDENTIAL = { accessKeyId: 'moto', secretAccessKey: 'moto' };

const ACCESS = {
  awsAccountId: ACCOUNT,
  deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-deploy`,
  externalId: 'moto-lane-external-id',
};
const WEB_ACCOUNT = {
  ...ACCESS,
  cloudAccountId: CLOUD_ACCOUNT,
  taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-task-execution`,
  permissionsBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/cloudgate/cloudgate-task-boundary`,
};

/** Every AWS service the two definitions reach. */
const ENDPOINTS = [
  'acm',
  'ec2',
  'ecr',
  'ecs',
  'elbv2',
  'iam',
  'logs',
  'route53',
  'servicediscovery',
  'ssm',
  'sts',
];

/** A bucket on S3 the sample `web` links, by its real name. */
const LINKED_BUCKET = `uploads-k3f9a2qd-${ACCOUNT}-${REGION}-an`;

/** Stored with a fixture's values, which `read-plan.spec.ts` looks for. */
const API_KEY = 'hunter2-very-secret';
const API_KEY_ROTATED = 'rotated-secret-value-2';
const API_KEY_BY_HAND = 'changed-by-hand-secret';
/** Over SSM's Standard 4 KB, so an Advanced parameter. */
const BIG_CERT = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(5000)}\n-----END CERTIFICATE-----`;

let postgres: StartedPostgreSqlContainer;
let moto: StartedTestContainer;
let motoUrl: string;
let runner: TofuRunner;
let network: NetworkIds;
/** The parts the network holds once a Service needed them. */
let networkLinks: readonly NetworkLinkKind[] = [];
const log: string[] = [];

/** The sample config's `api` entry: size small, port 4000, `node dist/main.js`. */
function sampleEntry(): WebEntry {
  const parsed = parseProjectConfig(
    readFileSync(
      join(REPO, 'backend/test/project-config/cloudgate.sample.yaml'),
      'utf8',
    ),
  );
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  return parsed.config.services[CONFIG_NAME] as WebEntry;
}

function networkRun() {
  const certificate = makeDefaultCertificate();
  return {
    stateId: NETWORK_STATE,
    credential: CREDENTIAL,
    definition: networkDefinition({
      cloudAccountId: CLOUD_ACCOUNT,
      account: ACCESS,
      region: REGION,
      environmentId: ENVIRONMENT,
      stateId: NETWORK_STATE,
      privateLinks: networkLinks,
    }),
    variables: {
      [DEFAULT_CERTIFICATE_VARIABLES.certificate]: certificate.certificatePem,
      [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: certificate.privateKeyPem,
    },
    onLine: (line: string) => log.push(line),
  };
}

function webRun(options: {
  network: NetworkIds;
  tag: string;
  values: Record<string, string>;
  buckets?: readonly string[];
}) {
  const generated = webDefinition({
    configName: CONFIG_NAME,
    entry: sampleEntry(),
    service: { serviceId: SERVICE, replicas: 1 },
    account: WEB_ACCOUNT,
    region: REGION,
    environmentId: ENVIRONMENT,
    stateId: WEB_STATE,
    network: options.network,
    image: { tag: options.tag, architecture: 'amd64' },
    variables: { values: options.values, digestSecret: APP_SECRET },
    domains: [],
    buckets: options.buckets ?? [],
  });
  if (!generated.ok) throw new Error(generated.refusal.message);
  return {
    stateId: WEB_STATE,
    credential: CREDENTIAL,
    definition: generated.definition,
    variables: generated.variables,
    onLine: (line: string) => log.push(line),
  };
}

/**
 * A Worker on ECS: the sample `api`'s size and command with no
 * port, its routing none, in its own state beside the `web`'s.
 */
function workerRun(options: { network: NetworkIds; tag: string }) {
  const { size, command, args } = sampleEntry();
  const generated = ecsServiceDefinition({
    configName: WORKER.configName,
    entry: { size, command, args },
    routing: ecsRoutingOf('worker', null),
    service: { serviceId: WORKER.serviceId, replicas: 1 },
    account: WEB_ACCOUNT,
    region: REGION,
    environmentId: ENVIRONMENT,
    stateId: WORKER.state,
    network: options.network,
    image: { tag: options.tag, architecture: 'amd64' },
    variables: { values: { API_KEY }, digestSecret: APP_SECRET },
  });
  if (!generated.ok) throw new Error(generated.refusal.message);
  return {
    stateId: WORKER.state,
    credential: CREDENTIAL,
    definition: generated.definition,
    variables: generated.variables,
    onLine: (line: string) => log.push(line),
  };
}

/**
 * A Private web service on ECS: the sample `api`'s size and command
 * on port 4000, its routing private DNS, in its own state.
 */
function privateRun(options: { network: NetworkIds; tag: string }) {
  const { size, command, args } = sampleEntry();
  const generated = ecsServiceDefinition({
    configName: INTERNAL.configName,
    entry: { size, command, args },
    routing: ecsRoutingOf('web-private', 4000),
    service: { serviceId: INTERNAL.serviceId, replicas: 1 },
    account: WEB_ACCOUNT,
    region: REGION,
    environmentId: ENVIRONMENT,
    stateId: INTERNAL.state,
    network: options.network,
    image: { tag: options.tag, architecture: 'amd64' },
    variables: { values: {}, digestSecret: APP_SECRET },
  });
  if (!generated.ok) throw new Error(generated.refusal.message);
  return {
    stateId: INTERNAL.state,
    credential: CREDENTIAL,
    definition: generated.definition,
    variables: generated.variables,
    onLine: (line: string) => log.push(line),
  };
}

/**
 * A Cron service on ECS: the sample `api`'s size with a command of
 * its own, a task definition and no ECS service, in its own state. Its
 * image has a HEALTHCHECK, which the definition never carries.
 */
function cronRun(options: {
  network: NetworkIds;
  tag: string;
  command?: string;
}) {
  const { size } = sampleEntry();
  const generated = cronTaskDefinition({
    configName: CRON.configName,
    entry: {
      size,
      command: options.command ?? 'node dist/nightly.js',
      args: ['--all'],
    },
    service: { serviceId: CRON.serviceId },
    account: WEB_ACCOUNT,
    region: REGION,
    environmentId: ENVIRONMENT,
    stateId: CRON.state,
    network: options.network,
    image: {
      tag: options.tag,
      architecture: 'amd64',
      healthCheck: { test: ['CMD-SHELL', 'test -f /tmp/alive'] },
    },
    variables: { values: { API_KEY }, digestSecret: APP_SECRET },
  });
  if (!generated.ok) throw new Error(generated.refusal.message);
  return {
    stateId: CRON.state,
    credential: CREDENTIAL,
    definition: generated.definition,
    variables: generated.variables,
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
  const result = await outcome;
  shown(result);
  if (!result.ok) throw new Error('unreachable');
  return result.outputs;
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

/** The network's saved ids, once it is made, in a fixed order. */
function networkIds(): string[] {
  if (!network) return [];
  return [
    network.vpcId,
    ...network.publicSubnetIds,
    network.clusterArn,
    network.httpsListenerArn,
    network.albSecurityGroupId,
    ...(network.privateDnsNamespaceId ? [network.privateDnsNamespaceId] : []),
  ];
}

/** Re-saves a stored plan file, its run-to-run values made stable. */
function save(name: string, show: TofuShow) {
  writeFileSync(
    join(PLANS, `${name}.json`),
    `${JSON.stringify(normalisePlan(show, { motoUrl, known: networkIds() }), null, 2)}\n`,
  );
}

function aws<T>(Client: new (config: object) => T): T {
  return new Client({
    region: REGION,
    endpoint: motoUrl,
    credentials: CREDENTIAL,
  });
}

/**
 * One call of a JSON-protocol AWS API, unsigned: moto checks no signature
 * and reads the service from the credential scope. For SSM, which no
 * AWS client this repo depends on covers.
 */
async function awsJson(service: string, target: string, body: object) {
  const response = await fetch(motoUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': target,
      Authorization: `AWS4-HMAC-SHA256 Credential=moto/20260101/${REGION}/${service}/aws4_request, SignedHeaders=host, Signature=0`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${target}: ${await response.text()}`);
}

async function openPort22(serviceId: string = SERVICE) {
  const ec2 = aws(EC2Client);
  const groups = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        {
          Name: 'group-name',
          Values: [serviceSecurityGroupName(serviceId)],
        },
      ],
    }),
  );
  await ec2.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groups.SecurityGroups?.[0]?.GroupId,
      IpPermissions: [
        {
          IpProtocol: 'tcp',
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: '0.0.0.0/0' }],
        },
      ],
    }),
  );
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

  // The state as an install makes it: Cloudgate's migrations, then the
  // state login granted what `deploy/opentofu/state-login.sql` grants.
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

  // What the operator's setup template makes before any run.
  await aws(IAMClient).send(
    new CreatePolicyCommand({
      PolicyName: 'cloudgate-task-boundary',
      Path: '/cloudgate/',
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }],
      }),
    }),
  );

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

describe('the generated definitions, against moto', () => {
  it('plans a new Environment network', async () => {
    const show = shown(await runner.plan(networkRun()));

    expect(Object.values(actions(show)).every((a) => a === 'create')).toBe(
      true,
    );
    save('network-create', show);
  });

  it('plans a new web Service on the network stand-ins', async () => {
    const show = shown(
      await runner.plan(
        webRun({
          network: networkStandIns(REGION, ACCOUNT),
          tag: STAND_IN_IMAGE_TAG,
          values: { API_KEY, BIG_CERT },
        }),
      ),
    );

    expect(Object.values(actions(show)).every((a) => a === 'create')).toBe(
      true,
    );
    save('web-create', show);
  });

  it('applies the network, then the web Service on its ids', async () => {
    const started = Date.now();
    const outputs = await applied(runner.apply(networkRun()));
    const subnets = outputs[NETWORK_OUTPUTS.publicSubnetIds] as string[];
    network = {
      vpcId: outputs[NETWORK_OUTPUTS.vpcId] as string,
      publicSubnetIds: [subnets[0], subnets[1]],
      clusterArn: outputs[NETWORK_OUTPUTS.clusterArn] as string,
      httpsListenerArn: outputs[NETWORK_OUTPUTS.httpsListenerArn] as string,
      albSecurityGroupId: outputs[NETWORK_OUTPUTS.albSecurityGroupId] as string,
    };
    await applied(runner.apply(webRun({ network, tag: 'dep_1', values: {} })));
    console.log(`network and web applied in ${Date.now() - started} ms`);
  });

  it('plans no changes against its own state (the key property)', async () => {
    const networkPlan = shown(await runner.plan(networkRun()));
    const webPlan = shown(
      await runner.plan(webRun({ network, tag: 'dep_1', values: {} })),
    );

    expect(actions(networkPlan)).toEqual({});
    expect(actions(webPlan)).toEqual({});
  });

  it("plans a linked bucket as the task role's access, and an unlink as its removal", async () => {
    const linked = () =>
      webRun({ network, tag: 'dep_1', values: {}, buckets: [LINKED_BUCKET] });
    const show = shown(await runner.plan(linked()));

    expect(actions(show)).toEqual({ 'aws_iam_role_policy.buckets': 'create' });
    save('web-bucket-access', show);

    await applied(runner.apply(linked()));
    expect(actions(shown(await runner.plan(linked())))).toEqual({});

    // The role's access widened by hand in the IAM console: Drift,
    // which the Apply puts back to the linked bucket's objects alone.
    await aws(IAMClient).send(
      new PutRolePolicyCommand({
        RoleName: `cloudgate-${SERVICE}`,
        PolicyName: 'cloudgate-buckets',
        PolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
        }),
      }),
    );
    const widened = shown(await runner.plan(linked()));
    expect(actions(widened)).toEqual({
      'aws_iam_role_policy.buckets': 'update',
    });
    // The role reads its inline policies back too, so it drifts beside it.
    expect(drifted(widened)).toEqual(
      expect.arrayContaining(['aws_iam_role_policy.buckets']),
    );
    await applied(runner.apply(linked()));
    expect(actions(shown(await runner.plan(linked())))).toEqual({});

    const unlinked = () => webRun({ network, tag: 'dep_1', values: {} });
    expect(actions(shown(await runner.plan(unlinked())))).toEqual({
      'aws_iam_role_policy.buckets': 'delete',
    });
    await applied(runner.apply(unlinked()));
  });

  it('plans a new image as a task definition revision and nothing else', async () => {
    const show = shown(
      await runner.plan(webRun({ network, tag: 'dep_2', values: {} })),
    );

    expect(actions(show)).toEqual({
      'aws_ecs_service.service': 'update',
      'aws_ecs_task_definition.service': 'delete,create',
    });
    save('image-only-no-variables', show);
  });

  it('plans a new image and a changed variable', async () => {
    await applied(
      runner.apply(webRun({ network, tag: 'dep_1', values: { API_KEY } })),
    );
    const show = shown(
      await runner.plan(
        webRun({ network, tag: 'dep_2', values: { API_KEY: API_KEY_ROTATED } }),
      ),
    );

    expect(actions(show)).toEqual({
      'aws_ecs_service.service': 'update',
      'aws_ecs_task_definition.service': 'delete,create',
      'aws_ssm_parameter.variable["API_KEY"]': 'update',
    });
    save('image-only', show);
  });

  it('shows a change made by hand, and puts it back', async () => {
    await openPort22();
    await awsJson('ssm', 'AmazonSSM.PutParameter', {
      Name: `/cloudgate/${ENVIRONMENT}/${SERVICE}/API_KEY`,
      Value: API_KEY_BY_HAND,
      Type: 'SecureString',
      Overwrite: true,
    });
    const run = () => webRun({ network, tag: 'dep_1', values: { API_KEY } });
    const show = shown(await runner.plan(run()));

    expect(actions(show)).toEqual({
      'aws_security_group.service': 'update',
      'aws_ssm_parameter.variable["API_KEY"]': 'update',
    });
    expect(drifted(show)).toEqual(
      expect.arrayContaining([
        'aws_security_group.service',
        'aws_ssm_parameter.variable["API_KEY"]',
      ]),
    );
    save('drift-field', show);

    await applied(runner.apply(run()));
    expect(actions(shown(await runner.plan(run())))).toEqual({});
  });

  it('shows a hand change only a replace puts back', async () => {
    // A Standard parameter moved to the Advanced tier by hand: SSM never
    // moves one back down, so putting it back is a replace.
    await awsJson('ssm', 'AmazonSSM.PutParameter', {
      Name: `/cloudgate/${ENVIRONMENT}/${SERVICE}/API_KEY`,
      Value: API_KEY,
      Type: 'SecureString',
      Tier: 'Advanced',
      Overwrite: true,
    });
    const run = () => webRun({ network, tag: 'dep_1', values: { API_KEY } });
    const show = shown(await runner.plan(run()));

    expect(actions(show)).toEqual({
      'aws_ssm_parameter.variable["API_KEY"]': 'delete,create',
    });
    save('replace-drift', show);

    await applied(runner.apply(run()));
  });

  it('shows resources deleted by hand as made again, beside the noise of a refresh', async () => {
    await aws(ECSClient).send(
      new DeleteServiceCommand({
        cluster: network.clusterArn,
        service: ecsServiceName(CONFIG_NAME, SERVICE),
        force: true,
      }),
    );
    await aws(CloudWatchLogsClient).send(
      new DeleteLogGroupCommand({
        logGroupName: logGroupName(ENVIRONMENT, SERVICE),
      }),
    );
    await openPort22();
    const run = () => webRun({ network, tag: 'dep_1', values: { API_KEY } });
    const show = shown(await runner.plan(run()));

    expect(actions(show)).toMatchObject({
      'aws_cloudwatch_log_group.service': 'create',
      'aws_ecs_service.service': 'create',
      'aws_security_group.service': 'update',
    });
    save('drift-tags-noise', show);

    await applied(runner.apply(run()));
  });

  describe('a Worker: the same builder with routing none', () => {
    it('plans a new one on the network stand-ins with nothing of the load balancer', async () => {
      const show = shown(
        await runner.plan(
          workerRun({
            network: networkStandIns(REGION, ACCOUNT),
            tag: STAND_IN_IMAGE_TAG,
          }),
        ),
      );

      const planned = actions(show);
      expect(Object.values(planned).every((a) => a === 'create')).toBe(true);
      expect(Object.keys(planned).sort()).toEqual(
        [
          'aws_cloudwatch_log_group.service',
          'aws_ecr_lifecycle_policy.service',
          'aws_ecr_repository.service',
          'aws_ecs_service.service',
          'aws_ecs_task_definition.service',
          'aws_iam_role.task',
          'aws_security_group.service',
          'aws_ssm_parameter.variable["API_KEY"]',
        ].sort(),
      );
      save('worker-create', show);
    });

    it('applies on the network, then plans no changes against its own state', async () => {
      await applied(runner.apply(workerRun({ network, tag: 'dep_1' })));

      expect(
        actions(shown(await runner.plan(workerRun({ network, tag: 'dep_1' })))),
      ).toEqual({});
    });

    it('shows a port opened by hand as drift, and puts it back', async () => {
      await openPort22(WORKER.serviceId);
      const run = () => workerRun({ network, tag: 'dep_1' });
      const show = shown(await runner.plan(run()));

      expect(actions(show)).toEqual({ 'aws_security_group.service': 'update' });
      expect(drifted(show)).toEqual(
        expect.arrayContaining(['aws_security_group.service']),
      );
      save('worker-drift', show);

      await applied(runner.apply(run()));
      expect(actions(shown(await runner.plan(run())))).toEqual({});
    });

    it('destroys it, leaving the network to the web', async () => {
      await applied(runner.destroy(workerRun({ network, tag: 'dep_1' })));
    });
  });

  describe('a Private web service: the same builder with routing private DNS', () => {
    it('plans a new Environment network made with its namespace, for a first cloud Service that is a web-private', async () => {
      networkLinks = ['private-dns'];
      const show = shown(
        await runner.plan({
          ...networkRun(),
          stateId: 'state_network_2',
          definition: networkDefinition({
            cloudAccountId: CLOUD_ACCOUNT,
            account: ACCESS,
            region: REGION,
            environmentId: ENVIRONMENT,
            stateId: 'state_network_2',
            privateLinks: networkLinks,
          }),
        }),
      );

      const planned = actions(show);
      expect(Object.values(planned).every((a) => a === 'create')).toBe(true);
      expect(planned).toHaveProperty(
        ['aws_service_discovery_private_dns_namespace.network'],
        'create',
      );
      save('network-create-private-dns', show);
    });

    it("plans the made network's private DNS namespace as its one addition", async () => {
      const show = shown(await runner.plan(networkRun()));

      expect(actions(show)).toEqual({
        'aws_service_discovery_private_dns_namespace.network': 'create',
      });
      save('network-private-dns', show);
    });

    it('plans a new one on the stand-ins with its discovery service and nothing of the load balancer', async () => {
      const show = shown(
        await runner.plan(
          privateRun({
            network: {
              ...networkStandIns(REGION, ACCOUNT),
              privateDnsNamespaceId: PRIVATE_DNS_NAMESPACE_STAND_IN,
            },
            tag: STAND_IN_IMAGE_TAG,
          }),
        ),
      );

      const planned = actions(show);
      expect(Object.values(planned).every((a) => a === 'create')).toBe(true);
      expect(Object.keys(planned).sort()).toEqual(
        [
          'aws_cloudwatch_log_group.service',
          'aws_ecr_lifecycle_policy.service',
          'aws_ecr_repository.service',
          'aws_ecs_service.service',
          'aws_ecs_task_definition.service',
          'aws_iam_role.task',
          'aws_security_group.service',
          'aws_service_discovery_service.service',
        ].sort(),
      );
      save('web-private-create', show);
    });

    it('applies the namespace into the network state, then the Service on its id, and plans no changes against either', async () => {
      const outputs = await applied(runner.apply(networkRun()));
      network = {
        ...network,
        privateDnsNamespaceId: outputs[
          NETWORK_OUTPUTS.privateDnsNamespaceId
        ] as string,
      };
      expect(network.privateDnsNamespaceId).toMatch(/^ns-/);
      await applied(runner.apply(privateRun({ network, tag: 'dep_1' })));

      expect(actions(shown(await runner.plan(networkRun())))).toEqual({});
      expect(
        actions(
          shown(await runner.plan(privateRun({ network, tag: 'dep_1' }))),
        ),
      ).toEqual({});
    });

    it('shows a port opened by hand as drift, and puts it back', async () => {
      await openPort22(INTERNAL.serviceId);
      const run = () => privateRun({ network, tag: 'dep_1' });
      const show = shown(await runner.plan(run()));

      expect(actions(show)).toEqual({ 'aws_security_group.service': 'update' });
      expect(drifted(show)).toEqual(
        expect.arrayContaining(['aws_security_group.service']),
      );
      save('web-private-drift', show);

      await applied(runner.apply(run()));
      expect(actions(shown(await runner.plan(run())))).toEqual({});
    });

    it('replaces its discovery service and rolls the ECS service in place, rather than replacing it, on a change of the discovery service', async () => {
      // A field that forces the discovery service's replacement, as a
      // later change to its `dns_config` would, and its digest in the ECS
      // service's triggers as the definition writes it.
      const run = () => {
        const one = privateRun({ network, tag: 'dep_1' });
        const blocks = one.definition.resource as Record<
          string,
          Record<string, Record<string, unknown>>
        >;
        const { tags, ...body } = blocks.aws_service_discovery_service.service;
        const changed = {
          ...body,
          dns_config: {
            ...(body.dns_config as object),
            routing_policy: 'WEIGHTED',
          },
        };
        blocks.aws_service_discovery_service.service = { ...changed, tags };
        (
          blocks.aws_ecs_service.service.triggers as Record<string, string>
        ).discovery = discoveryDigest(changed);
        return one;
      };
      const show = shown(await runner.plan(run()));

      expect(actions(show)).toEqual({
        'aws_service_discovery_service.service': 'delete,create',
        'aws_ecs_service.service': 'update',
      });
      save('web-private-dns-replace', show);

      await applied(runner.apply(run()));
      expect(actions(shown(await runner.plan(run())))).toEqual({});
    });

    it('destroys it with its discovery service, leaving the namespace in the network', async () => {
      await applied(runner.destroy(privateRun({ network, tag: 'dep_1' })));

      expect(actions(shown(await runner.plan(networkRun())))).toEqual({});
    });
  });

  describe('a Cron service: a task definition and no ECS service', () => {
    it('plans a new one on the network stand-ins with no ECS service, scheduler or load balancer', async () => {
      const show = shown(
        await runner.plan(
          cronRun({
            network: networkStandIns(REGION, ACCOUNT),
            tag: STAND_IN_IMAGE_TAG,
          }),
        ),
      );

      const planned = actions(show);
      expect(Object.values(planned).every((a) => a === 'create')).toBe(true);
      expect(Object.keys(planned).sort()).toEqual(
        [
          'aws_cloudwatch_log_group.service',
          'aws_ecr_lifecycle_policy.service',
          'aws_ecr_repository.service',
          'aws_ecs_task_definition.service',
          'aws_iam_role.task',
          'aws_security_group.service',
          'aws_ssm_parameter.variable["API_KEY"]',
        ].sort(),
      );
      save('cron-create', show);
    });

    it('applies on the network, answering what a run starts with, then plans no changes against its own state', async () => {
      const outputs = await applied(
        runner.apply(cronRun({ network, tag: 'dep_1' })),
      );
      expect(outputs[CRON_OUTPUTS.taskDefinitionArn]).toMatch(
        /:task-definition\/cloudgate-svc_4:\d+$/,
      );
      expect(outputs[CRON_OUTPUTS.securityGroupId]).toMatch(/^sg-/);

      expect(
        actions(shown(await runner.plan(cronRun({ network, tag: 'dep_1' })))),
      ).toEqual({});
    });

    it('plans a new image as a task definition revision and nothing else', async () => {
      const show = shown(await runner.plan(cronRun({ network, tag: 'dep_2' })));

      expect(actions(show)).toEqual({
        'aws_ecs_task_definition.service': 'delete,create',
      });
      save('cron-new-revision', show);
    });

    it('plans a changed command as a task definition revision', async () => {
      const show = shown(
        await runner.plan(
          cronRun({ network, tag: 'dep_1', command: 'node dist/v2.js' }),
        ),
      );

      expect(actions(show)).toEqual({
        'aws_ecs_task_definition.service': 'delete,create',
      });
    });

    it('shows a port opened by hand as drift, and puts it back', async () => {
      await openPort22(CRON.serviceId);
      const run = () => cronRun({ network, tag: 'dep_1' });
      const show = shown(await runner.plan(run()));

      expect(actions(show)).toEqual({ 'aws_security_group.service': 'update' });
      save('cron-drift', show);

      await applied(runner.apply(run()));
      expect(actions(shown(await runner.plan(run())))).toEqual({});
    });

    it('destroys it', async () => {
      await applied(runner.destroy(cronRun({ network, tag: 'dep_1' })));
    });
  });

  // Its own block, so it runs after the Worker's: jest runs a block's own
  // tests before the blocks inside it, and the Worker needs the network.
  describe('the end', () => {
    it('destroys the web Service, then the network', async () => {
      await applied(
        runner.destroy(webRun({ network, tag: 'dep_1', values: { API_KEY } })),
      );
      await applied(runner.destroy(networkRun()));
    });
  });
});
