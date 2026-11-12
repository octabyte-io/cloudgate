import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  ProjectConfig,
  SavedService,
} from '../../src/project-config';

/**
 * A `kind: compose` entry in an AWS Environment (ADR-0070, #1359): its
 * create makes the stack's own Stack VM, named on its plan lines with its
 * machine type, region and monthly price.
 */

const AWS: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function plan(
  text: string,
  saved: SavedService[] = [],
  extra: Partial<PlanInput> = {},
): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved,
    deployTarget: AWS,
    cloud: 'aws',
    context: { previous: null },
    networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
    ...extra,
  });
}

function planned(...args: Parameters<typeof plan>) {
  const outcome = plan(...args);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

function refusals(...args: Parameters<typeof plan>) {
  const outcome = plan(...args);
  if (outcome.ok) throw new Error('planned, but a refusal was expected');
  return outcome.refusals;
}

function analytics(...lines: string[]): string {
  return `version: 1\nservices:\n  analytics:\n    kind: compose\n    source:\n      github: acme/analytics\n${lines.map((line) => `    ${line}\n`).join('')}`;
}

function stackVmOf(outcome: ReturnType<typeof planned>) {
  const step = outcome.steps.find((one) => one.action === 'create');
  if (step?.action !== 'create' || !step.stackVm) {
    throw new Error('no Stack VM create was planned');
  }
  return step.stackVm;
}

/** A stack made on a Server before Stack VMs, in what is now a Cloud Environment. */
const ON_SERVER: SavedService = {
  serviceType: 'compose',
  serviceId: 'compose-analytics',
  name: 'analytics',
  configName: 'analytics',
  serverId: 'srv-1',
  settings: {
    sourceType: 'github',
    owner: 'acme',
    repository: 'analytics',
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
};

describe('planEnvironment, a compose entry in an AWS Environment', () => {
  it('creates the stack with its Stack VM, reading AWS, in place of a refusal', () => {
    const outcome = planned(analytics());

    expect(outcome.steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'analytics',
        kind: 'compose',
        placement: AWS,
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('starts a stack with no size at medium, on t3.small, and prices it in its region', () => {
    expect(stackVmOf(planned(analytics()))).toEqual({
      size: {
        name: 'medium',
        from: 'default',
        machineType: 't3.small',
        machine: '2 vCPU, 2 GB',
      },
      region: 'eu-west-1',
      dataDiskGb: 20,
      snapshotDays: 7,
      monthly: {
        machineUsd: 16.64,
        diskUsd: 1.76,
        snapshotsUsd: 1,
        totalUsd: 19.4,
      },
      lines: [
        'analytics Stack VM: no size, starts at medium → t3.small (2 vCPU, 2 GB) in eu-west-1',
        'analytics Stack VM cost: about $19.40 a month (machine $16.64, 20 GB data disk $1.76, daily snapshots about $1.00)',
        'analytics Stack VM data disk: 20 GB for its volumes, snapshotted daily, each snapshot kept 7 days',
      ],
    });
  });

  it.each([
    ['xsmall', 't3.micro', '2 vCPU, 1 GB'],
    ['small', 't3.micro', '2 vCPU, 1 GB'],
    ['large', 't3.medium', '2 vCPU, 4 GB'],
    ['xlarge', 't3.xlarge', '4 vCPU, 16 GB'],
    ['2xlarge', 't3.2xlarge', '8 vCPU, 32 GB'],
  ])(
    'puts size %s on the smallest machine type at least as large in CPU and memory, %s',
    (size, machineType, machine) => {
      const vm = stackVmOf(planned(analytics(`size: ${size}`)));
      expect(vm.size).toEqual({
        name: size,
        from: 'entry',
        machineType,
        machine,
      });
      expect(vm.lines[0]).toBe(
        `analytics Stack VM: ${size} → ${machineType} (${machine}) in eu-west-1`,
      );
    },
  );

  it('refuses a size above the largest machine type, naming the entry', () => {
    expect(
      refusals(analytics('size:', '  cpu: 16', '  memory: 64 GB')),
    ).toEqual([
      {
        at: 'analytics.size',
        message: expect.stringMatching(
          /^analytics: size 16 CPU \/ 64 GB is above the largest machine type Cloudgate chooses, t3\.2xlarge/,
        ) as string,
      },
    ]);
  });

  it('starts at a Template minimum size passed to its step, when the entry has none', () => {
    const vm = stackVmOf(
      planned(analytics(), [], {
        stackVmStartingSizes: { analytics: 'large' },
      }),
    );
    expect(vm.size).toEqual({
      name: 'large',
      from: 'template',
      machineType: 't3.medium',
      machine: '2 vCPU, 4 GB',
    });
    expect(vm.lines[0]).toBe(
      "analytics Stack VM: the template's minimum, large → t3.medium (2 vCPU, 4 GB) in eu-west-1",
    );
  });

  it("takes the entry's own size over a Template minimum", () => {
    const vm = stackVmOf(
      planned(analytics('size: xlarge'), [], {
        stackVmStartingSizes: { analytics: 'large' },
      }),
    );
    expect(vm.size.machineType).toBe('t3.xlarge');
  });

  it('lets native.aws set the machine type, which wins over the size', () => {
    const vm = stackVmOf(
      planned(
        analytics(
          'size: small',
          'native:',
          '  aws:',
          '    "aws_instance.stack_vm":',
          '      instance_type: m7i.large',
        ),
      ),
    );
    expect(vm.size).toEqual({
      name: 'small',
      from: 'native',
      machineType: 'm7i.large',
      machine: '2 vCPU, 8 GB',
    });
    expect(vm.native).toEqual({
      'aws_instance.stack_vm': { instance_type: 'm7i.large' },
    });
    expect(vm.lines[0]).toBe(
      'analytics Stack VM: small → m7i.large (2 vCPU, 8 GB), set by native, in eu-west-1',
    );
    expect(vm.monthly?.machineUsd).toBe(81.03);
  });

  it('still refuses native.docker on a compose entry', () => {
    expect(
      refusals(analytics('native:', '  docker:', '    labels:', '      a: b')),
    ).toEqual([
      {
        at: 'analytics.native.docker',
        message: expect.stringMatching(
          /^analytics\.native\.docker: refused - a Compose stack's container settings are its compose file's/,
        ) as string,
      },
    ]);
  });

  it('refuses a native.aws address a Stack VM does not make', () => {
    const [refusal] = refusals(
      analytics(
        'native:',
        '  aws:',
        '    "aws_ecs_service.service":',
        '      desired_count: 2',
      ),
    );
    expect(refusal.message).toMatch(
      /a compose on AWS makes .*aws_instance\.stack_vm.*, not aws_ecs_service\.service/,
    );
  });

  it('says a region missing from the rate table has no price, and still plans', () => {
    const vm = stackVmOf(
      planned(analytics(), [], {
        deployTarget: { ...AWS, region: 'af-south-1' },
        networks: [{ cloudAccountId: 'ca-1', region: 'af-south-1' }],
      }),
    );
    expect(vm.monthly).toBeNull();
    expect(vm.lines[1]).toBe(
      "analytics Stack VM cost: Cloudgate's rate table has no price for af-south-1; see AWS's EC2 and EBS pricing",
    );
  });

  it('refuses type: stack in a Cloud Environment, naming the entry', () => {
    expect(refusals(analytics('type: stack'))).toEqual([
      {
        at: 'analytics.type',
        message:
          'analytics.type: stack (Swarm) cannot run in a Cloud account; a Stack VM runs docker-compose only. Remove type, or set it to docker-compose',
      },
    ]);
  });

  it('makes the Environment network first where there is none', () => {
    const outcome = planned(analytics(), [], { networks: [] });
    expect(outcome.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
  });

  /**
   * A Stack VM has no public address, so its way out (apt, image pulls,
   * Session Manager) is a NAT gateway in its Environment network, which
   * the first Stack VM adds (the owner's decision amending ADR-0070).
   */
  describe("the Environment network's NAT gateway", () => {
    const made = {
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      environmentNetworkId: 'net-1',
    };

    it('is made with the network the first Stack VM needs', () => {
      const [network] = planned(analytics(), [], { networks: [] }).steps;
      expect(network).toEqual({
        action: 'network-create',
        cloudAccountId: 'ca-1',
        region: 'eu-west-1',
        privateLinks: ['nat-gateway'],
        cloudRead: { status: 'reading' },
      });
    });

    it('is added to a made network by the first Stack VM, before it', () => {
      const outcome = planned(analytics(), [], { networks: [made] });
      expect(outcome.steps.map((step) => step.action)).toEqual([
        'network-change',
        'create',
      ]);
      expect(outcome.steps[0]).toMatchObject({
        environmentNetworkId: 'net-1',
        privateLinks: ['nat-gateway'],
      });
    });

    it('is not added again for a second Stack VM', () => {
      const outcome = planned(analytics(), [], {
        networks: [{ ...made, privateLinks: ['nat-gateway'] }],
      });
      expect(outcome.steps.map((step) => step.action)).toEqual(['create']);
    });

    it('is never made for an Environment with no Stack VM, which keeps its idle cost', () => {
      const [network] = planned(
        'version: 1\nservices:\n  api:\n    kind: web\n    source:\n      image: nginx:1.27\n',
        [],
        { networks: [] },
      ).steps;
      expect(network.action === 'network-create' && network.privateLinks).toBe(
        undefined,
      );
    });
  });

  it('keeps a stack already on a Server in its place: no line moves it', () => {
    const outcome = planned(analytics('file: compose.yml'), [ON_SERVER]);
    expect(outcome.steps).toEqual([
      expect.objectContaining({ action: 'change', configName: 'analytics' }),
    ]);
    const [change] = outcome.steps;
    expect(change.action === 'change' && 'stackVm' in change).toBe(false);
  });

  it('still refuses other console-managed kinds in a Cloud Environment', () => {
    const [refusal] = refusals(
      `version: 1\nservices:\n  docs:\n    kind: mongo\n    managed: console\n`,
    );
    expect(refusal.message).toMatch(/^docs is listed with managed: console/);
  });
});

/**
 * A Cloud account whose role predates Stack VMs (#1366): a plan that
 * would make a Stack VM there is refused, naming what the role lacks and
 * the fix, rather than make one Cloudgate could never reach.
 */
describe('planEnvironment, a Stack VM in a Cloud account with the Stack VM gap', () => {
  const at = (policyVersion: number): Partial<PlanInput> => ({
    cloudAccount: { name: 'Production AWS', policyVersion },
  });

  it.each([2, 3])(
    'refuses the create in an account checked at version %i, naming what is missing and the fix',
    (version) => {
      const [refusal, ...more] = refusals(
        analytics('file: compose.yml'),
        [],
        at(version),
      );
      expect(more).toEqual([]);
      expect(refusal.at).toBe('analytics.kind');
      expect(refusal.message).toMatch(
        new RegExp(
          `^analytics: a Stack VM cannot be made in Cloud account Production AWS, whose role was last checked at policy version ${version}: it lacks the Stack VM permissions \\(Session Manager sessions .*\\): ssm:StartSession, .*ec2:RunInstances, .*\\. Update the role from the Cloud account's new setup template, which adds them as the managed policy cloudgate-deploy-stack-vm-ca-1, then Check now, and plan again$`,
        ),
      );
    },
  );

  it.each([4, 5])(
    'plans the create in an account checked at version %i',
    (version) => {
      stackVmOf(planned(analytics('file: compose.yml'), [], at(version)));
    },
  );

  it('keeps a stack already on a Server, which makes no Stack VM', () => {
    expect(
      planned(analytics('file: compose.yml'), [ON_SERVER], at(2)).steps,
    ).toEqual([
      expect.objectContaining({ action: 'change', configName: 'analytics' }),
    ]);
  });
});

describe('planEnvironment, a compose entry with a size on a Server', () => {
  it('plans the stack as before: a size only picks a Stack VM', () => {
    const outcome = planned(analytics('size: large'), [], {
      deployTarget: { kind: 'server', serverId: 'srv-1' },
      cloud: undefined,
      networks: [],
    });
    const [step] = outcome.steps;
    expect(step.action === 'create' && step.stackVm).toBeUndefined();
  });
});
