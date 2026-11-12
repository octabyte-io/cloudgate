import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CreateSnapshotCommand,
  CreateSubnetCommand,
  CreateVpcCommand,
  DescribeImagesCommand,
  DescribeSnapshotsCommand,
  EC2Client,
  ModifyVolumeCommand,
} from '@aws-sdk/client-ec2';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

import {
  dailySnapshotsOf,
  deleteVolumeSnapshot,
  takeVolumeSnapshot,
  volumeSnapshot,
} from '../../../src/cloud-accounts/aws/aws-cloud.adapter';
import { destroyDefinition } from '../../../src/cloud-accounts/aws/definitions/destroy-definition';
import {
  NETWORK_ADDRESS_RANGE,
  NETWORK_OUTPUTS,
  networkDefinition,
} from '../../../src/cloud-accounts/aws/definitions/network-definition';
import {
  DEFAULT_CERTIFICATE_VARIABLES,
  makeDefaultCertificate,
} from '../../../src/cloud-accounts/definitions/default-certificate';
import type { DatabaseNetworkIds } from '../../../src/cloud-accounts/aws/definitions/postgres-definition';
import {
  STACK_VM_DOMAIN_ADDRESSES,
  STACK_VM_INSTANCE_ADDRESS,
  STACK_VM_OUTPUTS,
  stackVmDefinition,
} from '../../../src/cloud-accounts/aws/definitions/stack-vm-definition';
import type {
  StackVmDomain,
  StackVmLoadBalancer,
} from '../../../src/cloud-accounts/aws/definitions/stack-vm-definition';
import { stackVmPinsOn } from '../../../src/cloud-accounts/definitions/stack-vm-pins';
import type { StackVmPins } from '../../../src/cloud-accounts/definitions/stack-vm-pins';
import { dataDiskRefusal } from '../../../src/cloud-accounts/definitions/stack-vm-written';
import { TofuRunner } from '../../../src/cloud-accounts/tofu/tofu-runner';
import type {
  TofuApplyOutcome,
  TofuPlanOutcome,
  TofuShow,
} from '../../../src/cloud-accounts/cloud.port';
import { closeMotoGaps } from './moto-gaps';
import { normalisePlan } from './normalise-plan';

/**
 * A Compose stack's **Stack VM** on AWS (ADR-0070, #1359), its generated
 * definition run by the real pinned OpenTofu and AWS provider, through the
 * real runner, against moto, as `database-lane.moto-spec.ts` runs a
 * postgres's.
 *
 * It is planned and made — the instance, its role and instance profile,
 * its security group, its data disk and attachment, and the snapshot
 * policy with its role — then plans no changes against its own state (the
 * key property), plans a new machine type as a change of the instance
 * alone, grows its data disk in place (#1368), changes nothing when
 * Cloudgate's pins move until a "replace VM" is approved, replaces the
 * Stack VM with `-replace` keeping its data disk, refuses a plan that
 * would shrink a disk grown by hand, shows a data disk grown by hand as
 * Drift, and is deleted as its stack's Delete does it (#1367): a final
 * snapshot of the data disk kept, the state destroyed with the
 * destroy-only definition, and the snapshot policy's daily snapshots
 * deleted.
 *
 * The image: moto 5.2.3 has no Canonical public parameter, so the first
 * create's read of `/aws/service/canonical/ubuntu/...` cannot run here
 * (`MOTO_MISSING`); the lane plans with an image moto has, as a Stack VM
 * whose image is recorded does.
 *
 * What moto cannot stand in for, this never claims: the VM booting,
 * cloud-init installing Docker, the data disk mounting, Session Manager
 * reaching it, EC2's automatic recovery and a snapshot taken by Data
 * Lifecycle Manager. Those are the walk by hand's.
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
const APP_SECRET = 'moto-lane-app-encryption-secret';
const STATE_PASSWORD = 'moto-lane-state-login';
const CREDENTIAL = { accessKeyId: 'moto', secretAccessKey: 'moto' };

const STACK = {
  configName: 'analytics',
  serviceId: 'svc_stack_1',
  state: 'st_stack_1',
};

const ACCOUNT_ACCESS = {
  awsAccountId: ACCOUNT,
  deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-deploy`,
  externalId: 'moto-lane-external-id',
  cloudAccountId: 'ca_1',
};

/**
 * Every AWS service the definition, the Environment network its Domains
 * need, and the hand changes reach.
 */
const ENDPOINTS = [
  'acm',
  'dlm',
  'ec2',
  'ecs',
  'elbv2',
  'iam',
  'logs',
  'route53',
  'servicediscovery',
  'ssm',
  'sts',
];

let postgres: StartedPostgreSqlContainer;
let moto: StartedTestContainer;
let motoUrl: string;
let runner: TofuRunner;
let network: DatabaseNetworkIds;
let imageId: string;
/** The zone its first apply recorded, which a made Stack VM keeps. */
let zone: string | null = null;
const log: string[] = [];

/**
 * The definition as moto can make it (`MOTO_MISSING`): without its
 * snapshot policy, which moto 5.2.3 never finishes making, and without
 * the instance's `associate_public_ip_address`, which moto never honours
 * and which forces a replace on every plan after, and its
 * `maintenance_options`, which moto keeps none of, so an apply after the
 * first would wait forever changing them.
 */
function asMotoMakesIt(definition: Record<string, unknown>) {
  const copy = structuredClone(definition) as {
    resource: Record<string, Record<string, Record<string, unknown>>>;
  };
  delete copy.resource.aws_dlm_lifecycle_policy;
  delete copy.resource.aws_instance.stack_vm.associate_public_ip_address;
  delete copy.resource.aws_instance.stack_vm.maintenance_options;
  return copy;
}

function stackVmRun(
  options: {
    machineType?: string;
    dataDiskGb?: number;
    pins?: StackVmPins;
    replace?: boolean;
    whole?: boolean;
    domains?: readonly StackVmDomain[];
    loadBalancer?: StackVmLoadBalancer;
    targets?: readonly string[];
  } = {},
) {
  const generated = stackVmDefinition({
    configName: STACK.configName,
    serviceId: STACK.serviceId,
    account: ACCOUNT_ACCESS,
    region: REGION,
    environmentId: 'env_1',
    stateId: STACK.state,
    network,
    machineType: options.machineType ?? 't3.small',
    dataDiskGb: options.dataDiskGb ?? 20,
    snapshotDays: 7,
    imageId,
    sshPublicKey: null,
    zone,
    pins: options.pins ?? stackVmPinsOn('aws'),
    ...(options.domains
      ? { domains: options.domains, loadBalancer: options.loadBalancer }
      : {}),
  });
  return {
    stateId: STACK.state,
    credential: CREDENTIAL,
    definition: options.whole
      ? generated.definition
      : asMotoMakesIt(generated.definition),
    ...(options.replace ? { replaces: [STACK_VM_INSTANCE_ADDRESS] } : {}),
    ...(options.targets ? { targets: [...options.targets] } : {}),
    onLine: (line: string) => log.push(line),
  };
}

const NETWORK_STATE = 'st_network_1';

/** The Environment network, whose load balancer a Stack VM's Domains are rules on. */
function networkRun() {
  const certificate = makeDefaultCertificate();
  return {
    stateId: NETWORK_STATE,
    credential: CREDENTIAL,
    definition: networkDefinition({
      cloudAccountId: ACCOUNT_ACCESS.cloudAccountId,
      account: ACCOUNT_ACCESS,
      region: REGION,
      environmentId: 'env_1',
      stateId: NETWORK_STATE,
    }),
    variables: {
      [DEFAULT_CERTIFICATE_VARIABLES.certificate]: certificate.certificatePem,
      [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: certificate.privateKeyPem,
    },
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

interface Change {
  address: string;
  change: {
    actions: string[];
    replace_paths?: unknown[][];
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
}

/** Each resource's actions, `no-op`s left out. */
function actions(show: TofuShow): Record<string, string> {
  const changes = (show.resource_changes ?? []) as Change[];
  return Object.fromEntries(
    changes
      .filter((c) => c.change.actions.join() !== 'no-op')
      .map((c) => [c.address, actionText(c)]),
  );
}

/** `delete,create` with what forces the replace, so a failure says why. */
function actionText(c: Change): string {
  const done = c.change.actions.join();
  const paths = (c.change.replace_paths ?? []).map((p) => p.join('.'));
  if (paths.length > 0 && done === 'delete,create') {
    return `${done} (${paths.join(', ')})`;
  }
  if (done !== 'update') return done;
  const { before, after } = c.change;
  const moved = Object.keys(after ?? {}).filter(
    (key) =>
      JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]) &&
      key !== 'tags_all',
  );
  return `${done} (${moved.join(', ')})`;
}

function drifted(show: TofuShow): string[] {
  return ((show.resource_drift ?? []) as Change[]).map((c) => c.address);
}

/** Re-saves a stored plan file, its run-to-run values made stable. */
function save(name: string, show: TofuShow, more: string[] = []) {
  const known = [network.vpcId, ...network.privateSubnetIds, imageId, ...more];
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
      // The Stack VM's roles attach AWS managed policies (Session Manager's
      // and Data Lifecycle Manager's), which moto loads only when asked.
      .withEnvironment({ MOTO_IAM_LOAD_MANAGED_POLICIES: 'true' })
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
  // An image moto has: the one a Stack VM's recorded image stands for.
  const images = await aws(EC2Client).send(new DescribeImagesCommand({}));
  imageId = images.Images!.find(
    (one) => one.Architecture === 'x86_64',
  )!.ImageId!;

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

describe("a Stack VM's generated definition, against moto", () => {
  it('plans the Stack VM, its identity, its security group, its data disk and its snapshot policy', async () => {
    const show = shown(await runner.plan(stackVmRun({ whole: true })));

    expect(actions(show)).toEqual({
      'aws_dlm_lifecycle_policy.snapshots': 'create',
      'aws_ebs_volume.data': 'create',
      'aws_iam_instance_profile.stack_vm': 'create',
      'aws_iam_role.snapshots': 'create',
      'aws_iam_role.stack_vm': 'create',
      'aws_iam_role_policy_attachment.session_manager': 'create',
      'aws_iam_role_policy_attachment.snapshots': 'create',
      'aws_instance.stack_vm': 'create',
      'aws_security_group.stack_vm': 'create',
      'aws_volume_attachment.data': 'create',
    });
    save('stack-vm-create', show);
  });

  it('applies it, then plans no changes against its own state (the key property)', async () => {
    const made = await runner.apply(stackVmRun());
    shown(made);
    expect(made.ok && made.outputs?.[STACK_VM_OUTPUTS.imageId]).toBe(imageId);
    expect(made.ok && made.outputs?.[STACK_VM_OUTPUTS.zone]).toBe(`${REGION}a`);
    zone = `${REGION}a`;

    // Written as a made Stack VM is: with the zone it recorded.
    expect(actions(shown(await runner.plan(stackVmRun())))).toEqual({});
  });

  it("changes nothing when Cloudgate's pins move, until a replace is approved (#1368)", async () => {
    const moved = { ...stackVmPinsOn('aws'), dockerEngine: 'newer' };
    expect(
      actions(shown(await runner.plan(stackVmRun({ pins: moved })))),
    ).toEqual({});
  });

  it('plans a new machine type as a change of the Stack VM alone', async () => {
    const show = shown(
      await runner.plan(stackVmRun({ machineType: 't3.medium' })),
    );

    expect(actions(show)).toEqual({
      'aws_instance.stack_vm': 'update (instance_type)',
    });
    save('stack-vm-resize', show);
  });

  it('grows its data disk in place, with no restart (#1368)', async () => {
    const show = shown(await runner.plan(stackVmRun({ dataDiskGb: 40 })));
    expect(actions(show)).toEqual({ 'aws_ebs_volume.data': 'update (size)' });
    save('stack-vm-grow', show);

    shown(await runner.apply(stackVmRun({ dataDiskGb: 40 })));
    expect(
      actions(shown(await runner.plan(stackVmRun({ dataDiskGb: 40 })))),
    ).toEqual({});
  });

  it('replaces the Stack VM on an approved "replace VM", keeping its data disk (#1368)', async () => {
    const moved = { ...stackVmPinsOn('aws'), dockerEngine: 'newer' };
    const run = stackVmRun({ dataDiskGb: 40, pins: moved, replace: true });
    const show = shown(await runner.plan(run));
    expect(actions(show)).toEqual({
      'aws_instance.stack_vm': 'delete,create',
      // Moved to the new Stack VM; the data disk itself stays as it is.
      'aws_volume_attachment.data': 'delete,create (instance_id)',
    });
    save('stack-vm-replace', show);

    const before = shown(await runner.plan(stackVmRun({ dataDiskGb: 40 })));
    const replaced = await runner.apply(run);
    shown(replaced);
    const after = shown(
      await runner.plan(stackVmRun({ dataDiskGb: 40, pins: moved })),
    );
    expect(actions(after)).toEqual({});
    expect(madeVolumeId(after)).toBe(madeVolumeId(before));
  });

  it('refuses a plan that would shrink a data disk grown by hand (#1368)', async () => {
    const plan = shown(await runner.plan(stackVmRun({ dataDiskGb: 40 })));
    const volume = madeVolumeId(plan);
    await aws(EC2Client).send(
      new ModifyVolumeCommand({ VolumeId: volume, Size: 60 }),
    );

    const show = shown(await runner.plan(stackVmRun({ dataDiskGb: 40 })));
    expect(drifted(show)).toContain('aws_ebs_volume.data');
    expect(actions(show)).toEqual({ 'aws_ebs_volume.data': 'update (size)' });
    expect(dataDiskRefusal('analytics', show, 'aws_ebs_volume')).toBe(
      "analytics's Stack VM data disk is 60 GB in its cloud, larger than the 40 GB Cloudgate records, and a data disk never shrinks. Grow it to 60 GB on the stack's page, then Check for changes",
    );
    save('stack-vm-disk-grown-by-hand', show);
    // Its owner grows it to what it is: nothing left to change.
    expect(
      actions(shown(await runner.plan(stackVmRun({ dataDiskGb: 60 })))),
    ).toEqual({});
  });

  it('shows a data disk grown by hand as Drift', async () => {
    const plan = shown(await runner.plan(stackVmRun({ dataDiskGb: 60 })));
    const volume = madeVolumeId(plan);
    await aws(EC2Client).send(
      new ModifyVolumeCommand({ VolumeId: volume, Size: 70 }),
    );

    const show = shown(await runner.plan(stackVmRun({ dataDiskGb: 60 })));
    expect(drifted(show)).toContain('aws_ebs_volume.data');
    // Would put back the size Cloudgate wrote: AWS refuses shrinking a
    // disk at Apply, which is why a read refuses it and a disk only grows,
    // from the stack page.
    expect(actions(show)).toEqual({ 'aws_ebs_volume.data': 'update (size)' });
  });

  /**
   * The stack's Delete (#1367), as `StackVmDeletes` runs it on AWS: the
   * final snapshot of the data disk through the adapter's own calls, the
   * destroy-only definition every cloud Delete destroys with, then Data
   * Lifecycle Manager's snapshots of the disk, which are in no state. A
   * snapshot of the disk taken by hand is left, and so is the final one.
   */
  describe("the stack's Delete", () => {
    let volumeId: string;
    let finalSnapshot: string;
    let byHand: string;
    let daily: string;

    it('takes the final snapshot of the data disk, tagged, before anything goes', async () => {
      volumeId = madeVolumeId(shown(await runner.plan(stackVmRun())));
      const ec2 = aws(EC2Client);
      const taken = await takeVolumeSnapshot(ec2, {
        volumeId,
        name: 'acme-production-analytics-final-2026-11-10',
        description: "Cloudgate: the final snapshot of analytics's data disk",
        tags: {
          'cloudgate:cloud-account': ACCOUNT_ACCESS.cloudAccountId,
          'cloudgate:environment': 'env_1',
          'cloudgate:final-snapshot-of': STACK.configName,
        },
      });
      expect(taken?.snapshotId).toMatch(/^snap-/);
      finalSnapshot = taken!.snapshotId;
      // moto finishes a snapshot at once; EBS takes its time.
      expect(await volumeSnapshot(ec2, finalSnapshot)).toEqual(
        expect.objectContaining({ state: 'completed' }),
      );

      // What the snapshot policy took (moto never runs one, so made as DLM
      // describes its own), and one an operator took by hand.
      daily = (
        await ec2.send(
          new CreateSnapshotCommand({
            VolumeId: volumeId,
            Description:
              'Created for policy: policy-0a1b2c3d4e schedule: daily',
          }),
        )
      ).SnapshotId!;
      byHand = (
        await ec2.send(
          new CreateSnapshotCommand({
            VolumeId: volumeId,
            Description: 'before the upgrade',
          }),
        )
      ).SnapshotId!;
      expect(await dailySnapshotsOf(ec2, volumeId)).toEqual([daily]);
    });

    it('destroys everything in its state with the destroy-only definition, which leaves it empty', async () => {
      const gone = await runner.destroy({
        ...stackVmRun(),
        definition: destroyDefinition(ACCOUNT_ACCESS, REGION, {
          cloudAccountId: ACCOUNT_ACCESS.cloudAccountId,
          environmentId: 'env_1',
          stateId: STACK.state,
        }),
      });
      shown(gone);

      expect(actions(shown(await runner.plan(stackVmRun())))).toEqual(
        expect.objectContaining({ 'aws_instance.stack_vm': 'create' }),
      );
    });

    it("deletes the policy's daily snapshots, and keeps the final one and one taken by hand", async () => {
      const ec2 = aws(EC2Client);
      for (const snapshotId of await dailySnapshotsOf(ec2, volumeId)) {
        await deleteVolumeSnapshot(ec2, snapshotId);
      }
      // One already gone is gone: a Retry deletes nothing twice.
      await deleteVolumeSnapshot(ec2, daily);

      const left = await ec2.send(
        new DescribeSnapshotsCommand({
          OwnerIds: ['self'],
          Filters: [{ Name: 'volume-id', Values: [volumeId] }],
        }),
      );
      expect(
        (left.Snapshots ?? []).map((one) => one.SnapshotId).sort(),
      ).toEqual([finalSnapshot, byHand].sort());
      expect(await volumeSnapshot(ec2, daily)).toBeNull();
    });
  });
});

/** The data disk's id, as the state holds it. */
function madeVolumeId(show: TofuShow): string {
  return (
    show.prior_state as {
      values: {
        root_module: {
          resources: { address: string; values: { id: string } }[];
        };
      };
    }
  ).values.root_module.resources.find(
    (one) => one.address === 'aws_ebs_volume.data',
  )!.values.id;
}
describe("a Stack VM's Domains, on the Environment network's load balancer (#1371)", () => {
  let loadBalancer: StackVmLoadBalancer;
  const first: StackVmDomain = {
    domainId: 'dom_app',
    host: 'app.example.com',
    path: '/',
    attempt: 1,
    attach: false,
    port: 3000,
  };
  const second: StackVmDomain = {
    domainId: 'dom_admin',
    host: 'admin.example.com',
    path: '/',
    attempt: 1,
    attach: false,
    port: 8080,
  };
  /**
   * A Domain run, as moto can apply it: its target groups' attachments
   * depend on the Stack VM, so `-target` reaches the instance, and moto
   * keeps no maintenance options (`MOTO_GAPS`), so the instance would be
   * modified on every run and moto never finishes that. AWS keeps them, and
   * the instance is no change there.
   */
  const domainRun = (domains: readonly StackVmDomain[]) => {
    const run = stackVmRun({
      domains,
      loadBalancer,
      targets: STACK_VM_DOMAIN_ADDRESSES,
    });
    const definition = run.definition as {
      resource: Record<string, Record<string, Record<string, unknown>>>;
    };
    delete definition.resource.aws_instance.stack_vm.maintenance_options;
    return run;
  };

  beforeAll(async () => {
    const made = await runner.apply(networkRun());
    if (!made.ok) throw new Error(made.message);
    const outputs = made.outputs ?? {};
    const subnets = outputs[NETWORK_OUTPUTS.privateSubnetIds] as string[];
    network = {
      vpcId: outputs[NETWORK_OUTPUTS.vpcId] as string,
      privateSubnetIds: [subnets[0], subnets[1]],
    };
    loadBalancer = {
      httpsListenerArn: outputs[NETWORK_OUTPUTS.httpsListenerArn] as string,
      albSecurityGroupId: outputs[NETWORK_OUTPUTS.albSecurityGroupId] as string,
    };
    // A new Stack VM in this network: none recorded yet (the first one's
    // zone went with its Delete).
    zone = null;
    shown(await runner.apply(stackVmRun()));
  }, 600_000);

  it("applies a Domain's run: its certificate, its rule, its port's target group with the Stack VM in it, and the port opened to the load balancer", async () => {
    const show = shown(await runner.plan(domainRun([first])));
    expect(actions(show)).toEqual({
      'aws_acm_certificate.domain["dom_app-1"]': 'create',
      'aws_lb_listener_rule.domain["dom_app"]': 'create',
      'aws_lb_target_group.stack_vm["3000"]': 'create',
      'aws_lb_target_group_attachment.stack_vm["3000"]': 'create',
      'aws_security_group.stack_vm': 'update (ingress)',
    });
    shown(await runner.apply(domainRun([first])));
    expect(actions(shown(await runner.plan(domainRun([first]))))).toEqual({});
  });

  it('plans a second Domain on another port as its own target group and rule, and the port opened', async () => {
    const show = shown(await runner.plan(domainRun([first, second])));
    expect(actions(show)).toEqual({
      'aws_acm_certificate.domain["dom_admin-1"]': 'create',
      'aws_lb_listener_rule.domain["dom_admin"]': 'create',
      'aws_lb_target_group.stack_vm["8080"]': 'create',
      'aws_lb_target_group_attachment.stack_vm["8080"]': 'create',
      'aws_security_group.stack_vm': 'update (ingress)',
    });
    save('stack-vm-domain-add', show, [
      loadBalancer.httpsListenerArn,
      loadBalancer.albSecurityGroupId,
    ]);
  });

  it('plans the last Domain removed as its rule, certificate and target group destroyed, and the port closed', async () => {
    const show = shown(await runner.plan(domainRun([])));
    expect(actions(show)).toEqual({
      'aws_acm_certificate.domain["dom_app-1"]': 'delete',
      'aws_lb_listener_rule.domain["dom_app"]': 'delete',
      'aws_lb_target_group.stack_vm["3000"]': 'delete',
      'aws_lb_target_group_attachment.stack_vm["3000"]': 'delete',
      'aws_security_group.stack_vm': 'update (ingress)',
    });
    save('stack-vm-domain-remove', show, [
      loadBalancer.httpsListenerArn,
      loadBalancer.albSecurityGroupId,
    ]);
  });

  it('destroys the stack with its load balancer pieces, then the network', async () => {
    shown(await runner.destroy(stackVmRun({ domains: [first], loadBalancer })));
    shown(await runner.destroy(networkRun()));
  });
});
