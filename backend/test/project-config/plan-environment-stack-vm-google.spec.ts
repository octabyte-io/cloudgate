import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  ProjectConfig,
} from '../../src/project-config';

/**
 * A `kind: compose` entry in a Google Cloud Environment (ADR-0070, #1362):
 * its create makes the stack's own Stack VM on Compute Engine, named on
 * its plan lines with its machine type, region and monthly price, as on
 * AWS (#1359).
 */

const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'europe-west1',
};

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function plan(text: string, extra: Partial<PlanInput> = {}): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved: [],
    deployTarget: GOOGLE,
    cloud: 'gcp',
    context: { previous: null },
    networks: [
      {
        cloudAccountId: 'ca-1',
        region: 'europe-west1',
        environmentNetworkId: 'net-1',
        privateLinks: ['cloud-nat'],
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

/**
 * A Google Cloud account whose role predates Stack VMs (#1366): a plan
 * that would make a Stack VM there is refused, naming what the role lacks
 * and the fix.
 */
describe('planEnvironment, a Stack VM in a Google Cloud account with the Stack VM gap', () => {
  const at = (policyVersion: number): Partial<PlanInput> => ({
    cloudAccount: { name: 'Production Google', policyVersion },
  });

  it.each([5, 6])(
    'refuses the create in an account checked at role version %i, naming what is missing and the fix',
    (version) => {
      const [refusal, ...more] = refusals(analytics(), at(version));
      expect(more).toEqual([]);
      expect(refusal.message).toMatch(
        new RegExp(
          `^analytics: a Stack VM cannot be made in Cloud account Production Google, whose role was last checked at role version ${version}: it lacks the Stack VM permissions \\(IAP tunnelling .*\\): compute\\.instances\\.create, .*iap\\.tunnelInstances\\.accessViaIAP, iap\\.googleapis\\.com\\. Run the Cloud account's new setup script in Cloud Shell, which updates the role and turns on IAP's API, then Check now, and plan again$`,
        ),
      );
    },
  );

  it.each([7, 8])(
    'plans the create in an account checked at role version %i',
    (version) => {
      stackVmOf(planned(analytics(), at(version)));
    },
  );
});

describe('planEnvironment, a compose entry in a Google Cloud Environment', () => {
  it('creates the stack with its Stack VM, reading Google Cloud, in place of a refusal', () => {
    expect(planned(analytics()).steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'analytics',
        kind: 'compose',
        placement: GOOGLE,
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('starts a stack with no size at medium, on e2-small, and prices it in its region', () => {
    expect(stackVmOf(planned(analytics()))).toEqual({
      size: {
        name: 'medium',
        from: 'default',
        machineType: 'e2-small',
        machine: '2 vCPU, 2 GB',
      },
      region: 'europe-west1',
      dataDiskGb: 20,
      snapshotDays: 7,
      monthly: {
        machineUsd: 13.45,
        diskUsd: 2.2,
        snapshotsUsd: 1,
        totalUsd: 16.65,
      },
      lines: [
        'analytics Stack VM: no size, starts at medium → e2-small (2 vCPU, 2 GB) in europe-west1',
        'analytics Stack VM cost: about $16.65 a month (machine $13.45, 20 GB data disk $2.20, daily snapshots about $1.00)',
        'analytics Stack VM data disk: 20 GB for its volumes, snapshotted daily, each snapshot kept 7 days',
      ],
    });
  });

  it.each([
    ['xsmall', 'e2-micro', '2 vCPU, 1 GB'],
    ['small', 'e2-micro', '2 vCPU, 1 GB'],
    ['large', 'e2-medium', '2 vCPU, 4 GB'],
    ['xlarge', 'e2-standard-4', '4 vCPU, 16 GB'],
    ['2xlarge', 'e2-standard-8', '8 vCPU, 32 GB'],
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
        `analytics Stack VM: ${size} → ${machineType} (${machine}) in europe-west1`,
      );
    },
  );

  it('puts a custom size of 3 CPU and 4 GB on e2-standard-4', () => {
    const vm = stackVmOf(
      planned(analytics('size:', '  cpu: 3', '  memory: 4 GB')),
    );
    expect(vm.size.machineType).toBe('e2-standard-4');
  });

  it('refuses a size above the largest machine type, naming the entry', () => {
    expect(
      refusals(analytics('size:', '  cpu: 16', '  memory: 64 GB')),
    ).toEqual([
      {
        at: 'analytics.size',
        message: expect.stringMatching(
          /^analytics: size 16 CPU \/ 64 GB is above the largest machine type Cloudgate chooses, e2-standard-8/,
        ) as string,
      },
    ]);
  });

  it('lets native.gcp set the machine type, which wins over the size', () => {
    const vm = stackVmOf(
      planned(
        analytics(
          'size: small',
          'native:',
          '  gcp:',
          '    "google_compute_instance.stack_vm":',
          '      machine_type: n2-standard-2',
        ),
      ),
    );
    expect(vm.size).toEqual({
      name: 'small',
      from: 'native',
      machineType: 'n2-standard-2',
      machine: '2 vCPU, 8 GB',
    });
    expect(vm.nativeGcp).toEqual({
      'google_compute_instance.stack_vm': { machine_type: 'n2-standard-2' },
    });
    expect(vm.native).toBeUndefined();
    expect(vm.lines[0]).toBe(
      'analytics Stack VM: small → n2-standard-2 (2 vCPU, 8 GB), set by native, in europe-west1',
    );
    expect(vm.monthly?.machineUsd).toBe(77.99);
  });

  it('names a native machine type the list does not know alone, with no price', () => {
    const vm = stackVmOf(
      planned(
        analytics(
          'native:',
          '  gcp:',
          '    "google_compute_instance.stack_vm":',
          '      machine_type: c3-standard-4',
        ),
      ),
    );
    expect(vm.size.machine).toBeNull();
    expect(vm.monthly).toBeNull();
    expect(vm.lines[1]).toBe(
      "analytics Stack VM cost: Cloudgate's rate table has no price for c3-standard-4 in europe-west1; see Google Cloud's Compute Engine pricing",
    );
  });

  it('refuses a native.gcp setting a Stack VM locks, naming it', () => {
    const [refusal] = refusals(
      analytics(
        'native:',
        '  gcp:',
        '    "google_compute_instance.stack_vm":',
        '      can_ip_forward: true',
      ),
    );
    expect(refusal.message).toMatch(/can_ip_forward/);
  });

  it('refuses a native.gcp address a Stack VM does not make', () => {
    const [refusal] = refusals(
      analytics(
        'native:',
        '  gcp:',
        '    "google_cloud_run_v2_service.service":',
        '      deletion_protection: true',
      ),
    );
    expect(refusal.message).toMatch(/google_compute_instance\.stack_vm/);
  });

  it('says a region missing from the rate table has no price, and still plans', () => {
    const vm = stackVmOf(
      planned(analytics(), {
        deployTarget: { ...GOOGLE, region: 'me-central2' },
        networks: [{ cloudAccountId: 'ca-1', region: 'me-central2' }],
      }),
    );
    expect(vm.monthly).toBeNull();
    expect(vm.lines[1]).toBe(
      "analytics Stack VM cost: Cloudgate's rate table has no price for me-central2; see Google Cloud's Compute Engine pricing",
    );
  });

  it('refuses type: stack in a Google Cloud Environment, naming the entry', () => {
    expect(refusals(analytics('type: stack'))).toEqual([
      expect.objectContaining({ at: 'analytics.type' }),
    ]);
  });

  /**
   * A Stack VM has no external IP, so its way out (apt, Docker's packages,
   * image pulls) is Cloud NAT on a Cloud Router in its Environment network,
   * which the first Stack VM adds (the owner's decision amending ADR-0070).
   */
  describe("the Environment network's Cloud NAT", () => {
    const made = {
      cloudAccountId: 'ca-1',
      region: 'europe-west1',
      environmentNetworkId: 'net-1',
    };

    it('is made with the network the first Stack VM needs', () => {
      const [network] = planned(analytics(), { networks: [] }).steps;
      expect(network).toEqual({
        action: 'network-create',
        cloudAccountId: 'ca-1',
        region: 'europe-west1',
        privateLinks: ['cloud-nat'],
        cloudRead: { status: 'reading' },
      });
    });

    it('is added to a made network by the first Stack VM, before it', () => {
      const outcome = planned(analytics(), { networks: [made] });
      expect(outcome.steps.map((step) => step.action)).toEqual([
        'network-change',
        'create',
      ]);
      expect(outcome.steps[0]).toMatchObject({
        environmentNetworkId: 'net-1',
        privateLinks: ['cloud-nat'],
      });
    });

    it('is not added again for a second Stack VM', () => {
      expect(planned(analytics()).steps.map((step) => step.action)).toEqual([
        'create',
      ]);
    });

    it('is never made for an Environment with no Stack VM', () => {
      const [network] = planned(
        'version: 1\nservices:\n  api:\n    kind: web\n    source:\n      image: nginx:1.27\n',
        { networks: [] },
      ).steps;
      expect(network.action === 'network-create' && network.privateLinks).toBe(
        undefined,
      );
    });
  });
});
