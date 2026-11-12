import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  PlanStep,
  ProjectConfig,
  SavedService,
  SavedStackVm,
} from '../../src/project-config';
import { stackVmPinsOn } from '../../src/cloud-accounts/definitions/stack-vm-pins';
import type { CloudKind } from '../../src/cloud-accounts/cloud-account.schema';

/**
 * A Compose stack already on its Stack VM (ADR-0070, #1368): a size or
 * machine-type change is a change line that says it restarts the Stack VM
 * with its old and new prices; a data disk only grows; and once
 * Cloudgate's pins move, a "replace VM" line keeps the data disk. On AWS
 * and on Google Cloud alike, each read from its cloud before it applies.
 */

const PLACES: Record<
  CloudKind,
  { target: DeployTarget; machine: string; region: string }
> = {
  aws: {
    target: { kind: 'cloud', cloudAccountId: 'ca-1', region: 'eu-west-1' },
    machine: 't3.small',
    region: 'eu-west-1',
  },
  gcp: {
    target: { kind: 'cloud', cloudAccountId: 'ca-1', region: 'europe-west1' },
    machine: 'e2-small',
    region: 'europe-west1',
  },
};

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function analytics(...lines: string[]): string {
  return `version: 1\nservices:\n  analytics:\n    kind: compose\n    source:\n      github: acme/analytics\n${lines.map((line) => `    ${line}\n`).join('')}`;
}

const CONSOLE = `version: 1\nservices:\n  analytics:\n    kind: compose\n    managed: console\n`;

/** A stack made on its Stack VM at `medium`, with the pins Cloudgate has now. */
function onStackVm(
  cloud: CloudKind,
  stackVm: Partial<SavedStackVm> = {},
): SavedService {
  return {
    serviceType: 'compose',
    serviceId: 'compose-analytics',
    name: 'analytics',
    configName: 'analytics',
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
    stackVm: {
      cloudAccountId: 'ca-1',
      region: PLACES[cloud].region,
      cloud,
      made: true,
      consoleSize: null,
      consoleDataDiskGb: null,
      machineType: PLACES[cloud].machine,
      sizeName: 'medium',
      dataDiskGb: 20,
      snapshotDays: 7,
      pins: stackVmPinsOn(cloud),
      ...stackVm,
    },
  };
}

function plan(
  cloud: CloudKind,
  text: string,
  saved: SavedService[],
  extra: Partial<PlanInput> = {},
): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved,
    deployTarget: PLACES[cloud].target,
    cloud,
    context: { previous: null },
    networks: [
      {
        cloudAccountId: 'ca-1',
        region: PLACES[cloud].region,
        environmentNetworkId: 'net-1',
        privateLinks: cloud === 'gcp' ? ['cloud-nat'] : ['nat-gateway'],
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

function changeOf(outcome: ReturnType<typeof planned>) {
  const step = outcome.steps.find(
    (one): one is Extract<PlanStep, { action: 'change' }> =>
      one.action === 'change' && one.configName === 'analytics',
  );
  if (!step?.stackVm) throw new Error('no Stack VM change was planned');
  return step;
}

/** Docker and compose as a Stack VM made before Cloudgate's pins moved has them. */
const OLD_PINS = {
  image: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260101',
  dockerEngine: '5:28.0.0-1~ubuntu.24.04~noble',
  composePlugin: '2.30.0-1~ubuntu.24.04~noble',
};

describe('planEnvironment, a Compose stack on its Stack VM', () => {
  describe('on AWS', () => {
    it('plans nothing when its size, disk and pins are as made', () => {
      expect(
        planned('aws', analytics('size: medium'), [onStackVm('aws')]).steps,
      ).toEqual([]);
    });

    it('keeps the machine it was made on when its entry names no size', () => {
      expect(
        planned('aws', analytics(), [
          onStackVm('aws', { machineType: 't3.large', sizeName: 'xlarge' }),
        ]).steps,
      ).toEqual([]);
    });

    it('resizes it on a change line that says it restarts the Stack VM, with its old and new prices, read from AWS', () => {
      const step = changeOf(
        planned('aws', analytics('size: large'), [onStackVm('aws')]),
      );

      expect(step).toMatchObject({
        action: 'change',
        kind: 'compose',
        serviceType: 'compose',
        serviceId: 'compose-analytics',
        fields: [{ field: 'size', from: 'medium', to: 'large' }],
        cloudRead: { status: 'reading' },
      });
      expect(step.stackVm).toMatchObject({
        machineType: 't3.medium',
        sizeName: 'large',
        dataDiskGb: 20,
        resize: {
          from: { machineType: 't3.small' },
          to: { machineType: 't3.medium' },
        },
      });
      expect(step.stackVm?.lines).toEqual([
        'analytics Stack VM: t3.small (2 vCPU, 2 GB) → t3.medium (2 vCPU, 4 GB), restarts the Stack VM',
        'analytics Stack VM cost: about $19.40 → about $36.05 a month',
      ]);
    });

    it('resizes it to the machine type its native.aws sets, which wins over the size', () => {
      const step = changeOf(
        planned(
          'aws',
          analytics(
            'size: medium',
            'native:',
            '  aws:',
            '    aws_instance.stack_vm:',
            '      instance_type: m7i.large',
          ),
          [onStackVm('aws')],
        ),
      );

      expect(step.stackVm).toMatchObject({
        machineType: 'm7i.large',
        native: { 'aws_instance.stack_vm': { instance_type: 'm7i.large' } },
      });
      expect(step.stackVm?.lines[0]).toBe(
        'analytics Stack VM: t3.small (2 vCPU, 2 GB) → m7i.large (2 vCPU, 8 GB), set by native, restarts the Stack VM',
      );
    });

    it('grows its data disk in place, with no restart, priced', () => {
      const step = changeOf(
        planned('aws', analytics('size: medium'), [
          onStackVm('aws', { consoleDataDiskGb: 40 }),
        ]),
      );

      expect(step.stackVm).toMatchObject({
        machineType: 't3.small',
        dataDiskGb: 40,
        grow: { fromGb: 20, toGb: 40 },
      });
      expect(step.stackVm?.resize).toBeUndefined();
      expect(step.stackVm?.lines).toEqual([
        'analytics Stack VM data disk: 20 GB → 40 GB, grown in place with no restart; a data disk never shrinks',
        'analytics Stack VM cost: about $19.40 → about $22.16 a month',
      ]);
    });

    it('refuses a data disk smaller than it is, naming the stack', () => {
      expect(
        refusals('aws', analytics(), [
          onStackVm('aws', { dataDiskGb: 40, consoleDataDiskGb: 30 }),
        ]),
      ).toEqual([
        {
          at: 'analytics',
          message:
            'analytics: its Stack VM data disk is 40 GB, and a data disk only grows; 30 GB is refused',
        },
      ]);
    });

    it('offers a "replace VM" line once Cloudgate\'s pins have moved, keeping the data disk', () => {
      const step = changeOf(
        planned('aws', analytics('size: medium'), [
          onStackVm('aws', { pins: OLD_PINS }),
        ]),
      );

      expect(step.fields).toEqual([]);
      expect(step.cloudRead).toEqual({ status: 'reading' });
      expect(step.stackVm?.replace).toEqual({
        from: OLD_PINS,
        to: stackVmPinsOn('aws'),
      });
      expect(step.stackVm?.lines).toEqual([
        `analytics Stack VM: replace VM, from Cloudgate's new pins: image ${OLD_PINS.image} → ${stackVmPinsOn('aws').image}, Docker 5:28.0.0-1~ubuntu.24.04~noble → ${stackVmPinsOn('aws').dockerEngine}, compose 2.30.0-1~ubuntu.24.04~noble → ${stackVmPinsOn('aws').composePlugin}`,
        'analytics Stack VM data disk: kept, with its volumes; the stack is down while the new Stack VM boots',
      ]);
    });

    it('offers no "replace VM" line on a Stack VM not made yet', () => {
      expect(
        planned('aws', analytics('size: medium'), [
          onStackVm('aws', { made: false, pins: null }),
        ]).steps,
      ).toEqual([]);
    });

    it('resizes and replaces in one line set when both are asked', () => {
      const step = changeOf(
        planned('aws', analytics('size: large'), [
          onStackVm('aws', { pins: OLD_PINS }),
        ]),
      );
      expect(step.stackVm).toMatchObject({
        machineType: 't3.medium',
        resize: { to: { machineType: 't3.medium' } },
        replace: { to: stackVmPinsOn('aws') },
      });
    });

    it('resizes a console-managed stack to the size its console asks for', () => {
      const step = changeOf(
        planned('aws', CONSOLE, [onStackVm('aws', { consoleSize: 'large' })]),
      );
      expect(step.fields).toEqual([]);
      expect(step.stackVm).toMatchObject({
        machineType: 't3.medium',
        sizeName: 'large',
      });
    });

    it("replaces a console-managed stack's Stack VM once the pins move", () => {
      const step = changeOf(
        planned('aws', CONSOLE, [onStackVm('aws', { pins: OLD_PINS })]),
      );
      expect(step.stackVm?.replace?.to).toEqual(stackVmPinsOn('aws'));
    });

    it('reads it for Drift on "Check for changes", changing nothing', () => {
      const step = changeOf(
        planned('aws', analytics('size: medium'), [onStackVm('aws')], {
          cloudReads: { everything: true, services: [] },
        }),
      );
      expect(step.fields).toEqual([]);
      expect(step.stackVm).toMatchObject({
        machineType: 't3.small',
        dataDiskGb: 20,
      });
      expect(step.stackVm?.lines).toEqual([]);
    });
  });

  describe('on Google Cloud', () => {
    it('resizes it on a change line that says it restarts the Stack VM, with its old and new prices', () => {
      const step = changeOf(
        planned('gcp', analytics('size: xlarge'), [onStackVm('gcp')]),
      );
      expect(step.cloudRead).toEqual({ status: 'reading' });
      expect(step.stackVm?.lines).toEqual([
        'analytics Stack VM: e2-small (2 vCPU, 2 GB) → e2-standard-4 (4 vCPU, 16 GB), restarts the Stack VM',
        'analytics Stack VM cost: about $16.65 → about $110.81 a month',
      ]);
    });

    it('grows its data disk, and refuses one smaller', () => {
      const grown = changeOf(
        planned('gcp', analytics(), [
          onStackVm('gcp', { consoleDataDiskGb: 50 }),
        ]),
      );
      expect(grown.stackVm).toMatchObject({
        dataDiskGb: 50,
        grow: { fromGb: 20, toGb: 50 },
      });
      expect(
        refusals('gcp', analytics(), [
          onStackVm('gcp', { dataDiskGb: 50, consoleDataDiskGb: 20 }),
        ])[0].message,
      ).toBe(
        'analytics: its Stack VM data disk is 50 GB, and a data disk only grows; 20 GB is refused',
      );
    });

    it('offers a "replace VM" line once Cloudgate\'s pins have moved', () => {
      const step = changeOf(
        planned('gcp', analytics(), [
          onStackVm('gcp', {
            pins: {
              ...stackVmPinsOn('gcp'),
              dockerEngine: OLD_PINS.dockerEngine,
            },
          }),
        ]),
      );
      expect(step.stackVm?.lines[0]).toBe(
        `analytics Stack VM: replace VM, from Cloudgate's new pins: Docker 5:28.0.0-1~ubuntu.24.04~noble → ${stackVmPinsOn('gcp').dockerEngine}`,
      );
    });
  });
});
