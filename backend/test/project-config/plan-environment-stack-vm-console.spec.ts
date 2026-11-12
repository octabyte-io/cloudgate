import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  ProjectConfig,
  SavedService,
  SavedStackVm,
} from '../../src/project-config';

/**
 * A console-managed Compose stack the console created in a Cloud
 * Environment (#1372, ADR-0070): its row is the console's, with its place
 * and no Server, and its Stack VM is made by the Environment's plan, sized
 * by its console setting. The plan never creates the stack itself: a
 * console-managed line with no Service is still refused (ADR-0065).
 */

const AWS: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-g',
  region: 'europe-west1',
};

const LISTED =
  'version: 1\nservices:\n  wiki:\n    kind: compose\n    managed: console\n';

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function plan(
  saved: SavedService[],
  extra: Partial<PlanInput> = {},
  text = LISTED,
): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved,
    deployTarget: AWS,
    cloud: 'aws',
    context: { previous: config(LISTED) },
    networks: [
      {
        cloudAccountId: 'ca-1',
        region: 'eu-west-1',
        environmentNetworkId: 'net-1',
        privateLinks: ['nat-gateway'],
      },
    ],
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

function stackVm(over: Partial<SavedStackVm> = {}): SavedStackVm {
  return {
    cloudAccountId: 'ca-1',
    region: 'eu-west-1',
    cloud: 'aws',
    made: false,
    machineType: 't3.small',
    dataDiskGb: 20,
    consoleSize: null,
    consoleDataDiskGb: null,
    sizeName: 'medium',
    snapshotDays: 7,
    pins: null,
    ...over,
  };
}

function wiki(vm: SavedStackVm | undefined): SavedService {
  return {
    serviceType: 'compose',
    serviceId: 'compose-wiki',
    name: 'wiki',
    configName: 'wiki',
    settings: {
      sourceType: 'raw',
      owner: null,
      repository: null,
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
    ...(vm ? { stackVm: vm } : {}),
  };
}

describe('planEnvironment, a console-made stack in a Cloud Environment', () => {
  it('makes its Stack VM for the row the console wrote, reading the cloud', () => {
    const { steps } = planned([wiki(stackVm())]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: 'create',
      configName: 'wiki',
      kind: 'compose',
      placement: AWS,
      fields: [],
      cloudRead: { status: 'reading' },
      stackVm: {
        consoleStackId: 'compose-wiki',
        region: 'eu-west-1',
        dataDiskGb: 20,
      },
    });
  });

  it('starts at medium when no size was set in the console', () => {
    const [step] = planned([wiki(stackVm())]).steps;
    expect(step.action === 'create' && step.stackVm?.size).toEqual({
      name: 'medium',
      from: 'default',
      machineType: 't3.small',
      machine: '2 vCPU, 2 GB',
    });
  });

  it('takes its size from its console setting, and says so', () => {
    const [step] = planned([wiki(stackVm({ consoleSize: 'large' }))]).steps;
    if (step.action !== 'create' || !step.stackVm) throw new Error('no create');
    expect(step.stackVm.size).toEqual({
      name: 'large',
      from: 'console',
      machineType: 't3.medium',
      machine: '2 vCPU, 4 GB',
    });
    expect(step.stackVm.lines[0]).toBe(
      'wiki Stack VM: large, set in the console → t3.medium (2 vCPU, 4 GB) in eu-west-1',
    );
  });

  it('starts with a data disk grown in the console, and prices it', () => {
    const [step] = planned([wiki(stackVm({ consoleDataDiskGb: 50 }))]).steps;
    if (step.action !== 'create' || !step.stackVm) throw new Error('no create');
    expect(step.stackVm.dataDiskGb).toBe(50);
    expect(step.stackVm.lines[2]).toMatch(/^wiki Stack VM data disk: 50 GB/);
    expect(step.stackVm.lines[1]).toMatch(/50 GB data disk/);
  });

  it('makes it on Google Cloud too, on its own cloud', () => {
    const [step] = planned(
      [
        wiki(
          stackVm({
            cloudAccountId: 'ca-g',
            region: 'europe-west1',
            cloud: 'gcp',
            machineType: 'e2-small',
          }),
        ),
      ],
      {
        deployTarget: GOOGLE,
        cloud: 'gcp',
        networks: [
          {
            cloudAccountId: 'ca-g',
            region: 'europe-west1',
            environmentNetworkId: 'net-g',
            privateLinks: ['cloud-nat'],
          },
        ],
      },
    ).steps;
    expect(step.action === 'create' && step.stackVm?.size.machineType).toBe(
      'e2-small',
    );
  });

  it('adds the NAT gateway to the network with the first Stack VM', () => {
    const outcome = planned([wiki(stackVm())], {
      networks: [
        {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          environmentNetworkId: 'net-1',
        },
      ],
    });
    expect(outcome.steps.map((step) => step.action)).toEqual([
      'network-change',
      'create',
    ]);
  });

  it('plans nothing for one whose Stack VM is made', () => {
    expect(planned([wiki(stackVm({ made: true }))]).steps).toEqual([]);
  });

  it('refuses where the Deploy target has moved from its place, which never moves', () => {
    const outcome = plan([wiki(stackVm())], {
      deployTarget: { kind: 'server', serverId: 'srv-1' },
      cloud: undefined,
      networks: [],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toHaveLength(1);
    expect(outcome.refusals[0].at).toBe('wiki');
    expect(outcome.refusals[0].message).toMatch(
      /^wiki: its Stack VM is still to be made in eu-west-1/,
    );
  });

  it('keeps a console-made stack on a Server in its place: nothing planned', () => {
    // A network with no NAT: with no Stack VM left, a NAT would go (#1367).
    expect(
      planned([{ ...wiki(undefined), serverId: 'srv-1' }], {
        networks: [
          {
            cloudAccountId: 'ca-1',
            region: 'eu-west-1',
            environmentNetworkId: 'net-1',
          },
        ],
      }).steps,
    ).toEqual([]);
  });

  it('refuses its Stack VM in a Cloud account whose role predates Stack VMs (#1366)', () => {
    const outcome = plan([wiki(stackVm())], {
      cloudAccount: { name: 'Production AWS', policyVersion: 3 },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toHaveLength(1);
    expect(outcome.refusals[0].at).toBe('wiki.kind');
    expect(outcome.refusals[0].message).toMatch(
      /^wiki: a Stack VM cannot be made in Cloud account Production AWS, whose role was last checked at policy version 3/,
    );
  });

  it('still never creates a console-managed line with no Service', () => {
    const outcome = plan([], { context: { previous: null } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals[0].message).toMatch(
      /^wiki is listed with managed: console, but this Environment has no Service with that Config name/,
    );
  });

  it('makes it on the plan that first lists the line too', () => {
    const outcome = planned([wiki(stackVm())], { context: { previous: null } });
    expect(outcome.steps.map((step) => step.action)).toEqual(['create']);
  });
});
