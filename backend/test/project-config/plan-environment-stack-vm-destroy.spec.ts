import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  PlanStep,
  SavedService,
} from '../../src/project-config';
import type { CloudKind } from '../../src/cloud-accounts/cloud-account.schema';

/**
 * Deleting a Compose stack that runs on a Stack VM (ADR-0070 "Delete",
 * #1367): its destroy line says what goes and what is kept — a named final
 * snapshot of its data disk, priced, unless "also delete its data" is
 * ticked — and once the Environment has no Stack VM left, the next plan
 * takes the NAT the first one added off its network.
 */

const PLACES: Record<
  CloudKind,
  { target: DeployTarget; nat: 'nat-gateway' | 'cloud-nat'; region: string }
> = {
  aws: {
    target: { kind: 'cloud', cloudAccountId: 'ca-1', region: 'eu-west-1' },
    nat: 'nat-gateway',
    region: 'eu-west-1',
  },
  gcp: {
    target: { kind: 'cloud', cloudAccountId: 'ca-1', region: 'europe-west1' },
    nat: 'cloud-nat',
    region: 'europe-west1',
  },
};

const EMPTY = 'version: 1\nservices: {}\n';
const API =
  'version: 1\nservices:\n  api:\n    kind: web\n    source:\n      image: nginx:1.27\n';
const ANALYTICS =
  'version: 1\nservices:\n  analytics:\n    kind: compose\n    source:\n      github: acme/analytics\n';

/** A stack on its own Stack VM in the cloud's region, as Cloudgate saved it. */
function onStackVm(
  cloud: CloudKind,
  overrides: { configName?: string; region?: string; dataDiskGb?: number } = {},
): SavedService {
  const configName = overrides.configName ?? 'analytics';
  return {
    serviceType: 'compose',
    serviceId: `compose-${configName}`,
    name: configName,
    configName,
    settings: {
      sourceType: 'github',
      owner: 'acme',
      repository: configName,
      gitlabOwner: null,
      gitlabRepository: null,
      gitlabPathNamespace: null,
      giteaOwner: null,
      giteaRepository: null,
      bitbucketOwner: null,
      bitbucketRepository: null,
      customGitUrl: null,
      composePath: './docker-compose.yml',
      composeType: 'docker-compose',
    },
    variables: { env: [] },
    stackVm: {
      cloudAccountId: 'ca-1',
      region: overrides.region ?? PLACES[cloud].region,
      cloud,
      made: true,
      machineType: cloud === 'aws' ? 't3.small' : 'e2-small',
      sizeName: 'medium',
      dataDiskGb: overrides.dataDiskGb ?? 20,
      consoleSize: null,
      consoleDataDiskGb: null,
      snapshotDays: 7,
      pins: null,
    },
  };
}

/** The config in effect listed every saved stack, so an unlisted one is destroyed. */
function previousOf(saved: readonly SavedService[]): PlanInput['context'] {
  return {
    previous: {
      services: Object.fromEntries(
        saved.map((one) => [
          one.configName,
          { kind: 'compose', managed: false as const },
        ]),
      ),
    },
  };
}

function plan(
  cloud: CloudKind,
  text: string,
  saved: SavedService[],
  extra: Partial<PlanInput> = {},
): PlanOutcome {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return planEnvironment({
    config: result.config,
    saved,
    deployTarget: PLACES[cloud].target,
    cloud,
    context: previousOf(saved),
    networks: [
      {
        cloudAccountId: 'ca-1',
        region: PLACES[cloud].region,
        environmentNetworkId: 'net-1',
        privateLinks: [PLACES[cloud].nat],
      },
    ],
    ...extra,
  });
}

function planned(...args: Parameters<typeof plan>): readonly PlanStep[] {
  const outcome = plan(...args);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome.steps;
}

function destroyOf(steps: readonly PlanStep[]) {
  const step = steps.find((one) => one.action === 'destroy');
  if (step?.action !== 'destroy') throw new Error('no destroy was planned');
  return step;
}

describe('planEnvironment, deleting a stack on a Stack VM on AWS', () => {
  it('says the Stack VM goes with everything in its state, and its data disk is kept as a priced final snapshot', () => {
    const step = destroyOf(planned('aws', EMPTY, [onStackVm('aws')]));

    expect(step).toMatchObject({
      configName: 'analytics',
      kind: 'compose',
      serviceType: 'compose',
      serviceId: 'compose-analytics',
    });
    expect(step.stackVm).toEqual({
      cloud: 'aws',
      region: 'eu-west-1',
      dataDiskGb: 20,
      finalSnapshotMonthlyUsd: 1,
      lines: [
        'analytics Stack VM goes from eu-west-1 with everything in its Infrastructure state: the EC2 instance, its load balancer rules and target group, its security group, its IAM role and instance profile, and its Data Lifecycle Manager policy with its daily snapshots',
        'analytics data disk (20 GB, its volumes): kept as a final snapshot, about $1.00 a month until you delete it in AWS, unless "also delete its data" is ticked; then nothing of it is kept',
      ],
    });
  });

  it('prices the final snapshot by the data disk as it has grown', () => {
    const step = destroyOf(
      planned('aws', EMPTY, [onStackVm('aws', { dataDiskGb: 100 })]),
    );
    expect(step.stackVm?.finalSnapshotMonthlyUsd).toBe(5);
  });

  it('says a region missing from the rate table has no snapshot price, and still plans', () => {
    const step = destroyOf(
      planned('aws', EMPTY, [onStackVm('aws', { region: 'sa-east-1' })], {
        networks: [],
      }),
    );
    expect(step.stackVm?.finalSnapshotMonthlyUsd).toBeNull();
    expect(step.stackVm?.lines[1]).toBe(
      `analytics data disk (20 GB, its volumes): kept as a final snapshot unless "also delete its data" is ticked; Cloudgate's rate table has no snapshot price for sa-east-1, see AWS's EC2 and EBS pricing`,
    );
  });

  it('has no Stack VM payload on a stack on a Server, whose Delete is as before', () => {
    const saved = { ...onStackVm('aws'), serverId: 'srv-1' };
    delete (saved as { stackVm?: unknown }).stackVm;
    const step = destroyOf(planned('aws', EMPTY, [saved]));
    expect(step.stackVm).toBeUndefined();
  });
});

describe('planEnvironment, deleting a stack on a Stack VM on Google Cloud', () => {
  it('says the Stack VM goes with everything in its state, and its data disk is kept as a priced final snapshot', () => {
    const step = destroyOf(planned('gcp', EMPTY, [onStackVm('gcp')]));

    expect(step.stackVm).toEqual({
      cloud: 'gcp',
      region: 'europe-west1',
      dataDiskGb: 20,
      finalSnapshotMonthlyUsd: 1,
      lines: [
        'analytics Stack VM goes from europe-west1 with everything in its Infrastructure state: the Compute Engine instance, its load balancer backend, its firewall rules, its service account, and its snapshot schedule with its daily snapshots',
        'analytics data disk (20 GB, its volumes): kept as a final snapshot, about $1.00 a month until you delete it in Google Cloud, unless "also delete its data" is ticked; then nothing of it is kept',
      ],
    });
  });
});

describe.each(['aws', 'gcp'] as const)(
  "the Environment network's NAT once no Stack VM is left (%s)",
  (cloud) => {
    const { nat } = PLACES[cloud];

    it('stays while the plan destroys the last Stack VM: it goes by the plan after, once the stack is gone', () => {
      const steps = planned(cloud, EMPTY, [onStackVm(cloud)]);
      expect(steps.map((step) => step.action)).toEqual(['destroy']);
    });

    it('is taken off the network by a plan once the Environment has no Stack VM', () => {
      const steps = planned(cloud, API, [], {
        context: { previous: null },
      });
      expect(steps[0]).toEqual({
        action: 'network-change',
        environmentNetworkId: 'net-1',
        cloudAccountId: 'ca-1',
        region: PLACES[cloud].region,
        removedLinks: [nat],
        cloudRead: { status: 'reading' },
      });
    });

    it('is taken off even when the plan changes nothing else', () => {
      const steps = planned(cloud, EMPTY, [], { context: { previous: null } });
      expect(steps.map((step) => step.action)).toEqual(['network-change']);
    });

    it('stays while another Stack VM runs in the Environment', () => {
      const steps = planned(cloud, EMPTY, [
        onStackVm(cloud),
        onStackVm(cloud, { configName: 'reports' }),
      ]);
      expect(steps.map((step) => step.action)).toEqual(['destroy', 'destroy']);

      const kept = planned(
        cloud,
        'version: 1\nservices:\n  reports:\n    kind: compose\n    source:\n      github: acme/reports\n',
        [onStackVm(cloud, { configName: 'reports' })],
        { context: { previous: null } },
      );
      expect(kept.some((step) => step.action === 'network-change')).toBe(false);
    });

    it('stays when the plan creates a Stack VM', () => {
      const steps = planned(cloud, ANALYTICS, [], {
        context: { previous: null },
      });
      expect(steps.map((step) => step.action)).toEqual(['create']);
    });

    it('is not touched on a network that holds no NAT', () => {
      const steps = planned(cloud, API, [], {
        context: { previous: null },
        networks: [
          {
            cloudAccountId: 'ca-1',
            region: PLACES[cloud].region,
            environmentNetworkId: 'net-1',
          },
        ],
      });
      expect(steps.map((step) => step.action)).toEqual(['create']);
    });

    it('is left to the network’s own removal when the network goes', () => {
      const steps = planned(cloud, EMPTY, [], {
        context: { previous: null },
        deployTarget: { kind: 'server', serverId: 'srv-1' },
        removableNetworks: [
          {
            environmentNetworkId: 'net-1',
            cloudAccountId: 'ca-1',
            region: PLACES[cloud].region,
            dnsRecordsLeft: [],
          },
        ],
      });
      expect(steps.map((step) => step.action)).toEqual(['network-remove']);
    });

    it('keeps the network itself while a Stack VM is in it', () => {
      const steps = planned(
        cloud,
        'version: 1\nservices:\n  analytics:\n    kind: compose\n    source:\n      github: acme/analytics\n',
        [onStackVm(cloud)],
        {
          context: { previous: null },
          deployTarget: { kind: 'server', serverId: 'srv-1' },
          removableNetworks: [
            {
              environmentNetworkId: 'net-1',
              cloudAccountId: 'ca-1',
              region: PLACES[cloud].region,
              dnsRecordsLeft: [],
            },
          ],
        },
      );
      expect(steps.some((step) => step.action === 'network-remove')).toBe(
        false,
      );
    });
  },
);
