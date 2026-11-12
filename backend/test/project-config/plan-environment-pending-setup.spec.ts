import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PendingSetupInput,
  PlanInput,
  PlanOutcome,
  PlanStep,
} from '../../src/project-config';

/**
 * A Template's own-kind parts planned from their Pending setup (ADR-0064,
 * ADR-0065): a create shows how each value is made and never a value, and
 * matches the setup strictly by Config name and kind.
 */

const PLATFORM: DeployTarget = { kind: 'platform-host' };

const GHOST = `version: 1
services:
  ghost-app:
    kind: web
    port: 2368
    source: { image: "ghost:5.96" }
    env:
      - ADMIN_EMAIL
      - SESSION_SECRET
      - TZ
      - DATABASE_URL: ghost-db.url
    build_args: [SESSION_SECRET]
  ghost-db:
    kind: postgres
    env: [POSTGRES_INITDB_ARGS]
`;

const SETUP: PendingSetupInput = {
  pendingSetupId: 'ps-1',
  templateId: 'ghost',
  templateName: 'Ghost',
  setupName: 'ghost',
  parts: [
    {
      configName: 'ghost-app',
      kind: 'web',
      made: {
        ADMIN_EMAIL: 'asked',
        SESSION_SECRET: 'generated (base64, 32 bytes)',
      },
    },
    {
      configName: 'ghost-db',
      kind: 'postgres',
      made: { POSTGRES_INITDB_ARGS: 'fixed' },
    },
  ],
};

function plan(
  text: string,
  pendingSetups: readonly PendingSetupInput[],
  more: Partial<PlanInput> = {},
): PlanOutcome {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  return planEnvironment({
    config: parsed.config,
    saved: [],
    deployTarget: PLATFORM,
    context: { previous: null },
    pendingSetups,
    ...more,
  });
}

function refusals(outcome: PlanOutcome): string[] {
  if (outcome.ok) throw new Error('planned, not refused');
  return outcome.refusals.map((refusal) => refusal.message);
}

type Create = Extract<PlanStep, { action: 'create' }>;

function creates(outcome: PlanOutcome): Create[] {
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((r) => r.message).join('; '));
  }
  return outcome.steps.filter(
    (step): step is Create => step.action === 'create',
  );
}

describe('planEnvironment', () => {
  describe('own-kind parts of a Pending setup', () => {
    it('shows each create from its template, with how each value is made in every list that lists it', () => {
      const made = creates(plan(GHOST, [SETUP]));
      const app = made.find((step) => step.configName === 'ghost-app');
      const db = made.find((step) => step.configName === 'ghost-db');

      expect(app?.template).toEqual({
        pendingSetupId: 'ps-1',
        templateId: 'ghost',
        templateName: 'Ghost',
        setupName: 'ghost',
        values: [
          { list: 'env', variable: 'ADMIN_EMAIL', made: 'asked' },
          {
            list: 'env',
            variable: 'SESSION_SECRET',
            made: 'generated (base64, 32 bytes)',
          },
          {
            list: 'build_args',
            variable: 'SESSION_SECRET',
            made: 'generated (base64, 32 bytes)',
          },
        ],
      });
      expect(db?.template?.values).toEqual([
        { list: 'env', variable: 'POSTGRES_INITDB_ARGS', made: 'fixed' },
      ]);
    });

    it('carries no value anywhere in the plan', () => {
      const outcome = plan(GHOST, [SETUP]);

      // The input holds none to leak; the plan names rules only.
      expect(JSON.stringify(outcome)).not.toMatch(/"value"/);
    });

    it('notes only the variables the setup gives no value', () => {
      const outcome = plan(GHOST, [SETUP]);

      expect(outcome.ok && outcome.notes).toEqual([
        expect.objectContaining({
          kind: 'variable-without-value',
          configName: 'ghost-app',
          list: 'env',
          variable: 'TZ',
        }),
      ]);
    });

    it('matches strictly by Config name and kind: a renamed or re-kinded entry gets nothing', () => {
      const renamed = GHOST.replace(/ghost-app/g, 'blog-app')
        .replace('kind: postgres', 'kind: redis\n    version: "7"')
        .replace('    env: [POSTGRES_INITDB_ARGS]\n', '');
      const outcome = plan(renamed, [SETUP]);

      for (const step of creates(outcome)) {
        expect(step.template).toBeUndefined();
      }
      expect(
        outcome.ok &&
          outcome.notes
            .filter((note) => note.kind === 'variable-without-value')
            .map((note) => note.configName),
      ).toEqual(['blog-app', 'blog-app', 'blog-app', 'blog-app']);
    });

    it('names the config files an own part mounts, never their text', () => {
      const withFile: PendingSetupInput = {
        ...SETUP,
        parts: [
          {
            ...SETUP.parts[0],
            files: [{ path: 'config.json', mount: '/etc/ghost/config.json' }],
          },
          SETUP.parts[1],
        ],
      };

      const app = creates(plan(GHOST, [withFile])).find(
        (step) => step.configName === 'ghost-app',
      );

      expect(app?.template?.files).toEqual([
        { path: 'config.json', mount: '/etc/ghost/config.json' },
      ]);
    });

    it('plans an ordinary create when there is no Pending setup', () => {
      for (const step of creates(plan(GHOST, []))) {
        expect(step.template).toBeUndefined();
      }
    });
  });

  describe('the compose part of a Pending setup', () => {
    const STACKED = `version: 1
services:
  ghost-app: { kind: compose, managed: console }
  ghost-db:
    kind: postgres
`;

    const WITH_STACK: PendingSetupInput = {
      pendingSetupId: 'ps-2',
      templateId: 'ghost',
      templateName: 'Ghost',
      setupName: 'ghost',
      parts: [
        {
          configName: 'ghost-app',
          kind: 'compose',
          made: {
            DB_PASSWORD: 'generated (password, 32 characters)',
            ADMIN_EMAIL: 'asked',
          },
          domains: [
            {
              service: 'ghost',
              port: 2368,
              path: '/',
              host: 'ghost-1a2b3c-198-51-100-7.sslip.io',
            },
          ],
          files: [{ path: 'config.production.json', mount: null }],
        },
        { configName: 'ghost-db', kind: 'postgres', made: {} },
      ],
    };

    it('creates a console-managed stack with no Service from the setup holding it, with its values, Domains and files', () => {
      const stack = creates(plan(STACKED, [WITH_STACK])).find(
        (step) => step.configName === 'ghost-app',
      );

      expect(stack).toMatchObject({
        action: 'create',
        kind: 'compose',
        placement: PLATFORM,
        fields: [],
      });
      expect(stack?.template).toEqual({
        pendingSetupId: 'ps-2',
        templateId: 'ghost',
        templateName: 'Ghost',
        setupName: 'ghost',
        values: [
          {
            list: 'env',
            variable: 'DB_PASSWORD',
            made: 'generated (password, 32 characters)',
          },
          { list: 'env', variable: 'ADMIN_EMAIL', made: 'asked' },
        ],
        domains: [
          {
            service: 'ghost',
            port: 2368,
            path: '/',
            host: 'ghost-1a2b3c-198-51-100-7.sslip.io',
          },
        ],
        files: [{ path: 'config.production.json', mount: null }],
      });
    });

    it('creates it even when the config in effect already listed the line', () => {
      const outcome = plan(STACKED, [WITH_STACK], {
        context: {
          previous: {
            services: { 'ghost-app': { kind: 'compose', managed: 'console' } },
          },
        },
      });

      expect(creates(outcome).map((step) => step.configName)).toContain(
        'ghost-app',
      );
    });

    it('matches strictly by Config name: a renamed line is still refused', () => {
      const renamed = STACKED.replace('ghost-app', 'blog-app');

      expect(refusals(plan(renamed, [WITH_STACK]))).toEqual([
        'blog-app is listed with managed: console, but this Environment has no Service with that Config name; a console-managed Service is created in the console',
      ]);
    });

    it('matches strictly by kind: a setup part of another kind under the name creates nothing', () => {
      const otherKind: PendingSetupInput = {
        ...WITH_STACK,
        parts: [{ ...WITH_STACK.parts[0], kind: 'web' }],
      };

      expect(refusals(plan(STACKED, [otherKind]))).toEqual([
        'ghost-app is listed with managed: console, but this Environment has no Service with that Config name; a console-managed Service is created in the console',
      ]);
    });

    it('refuses the plan when a Domain host is taken', () => {
      const outcome = plan(STACKED, [WITH_STACK], {
        takenHosts: new Map([
          [
            'ghost-1a2b3c-198-51-100-7.sslip.io',
            'Domain with this host and path already exists',
          ],
        ]),
      });

      expect(refusals(outcome)).toEqual([
        'ghost-app: its Domain ghost-1a2b3c-198-51-100-7.sslip.io is taken (Domain with this host and path already exists); cancel this setup and set the template up again with another host',
      ]);
    });
  });

  /**
   * In a Cloud Environment the compose part runs on its own Stack VM
   * (ADR-0070, #1379): its create is a Stack VM create, priced like any
   * cloud step, at the template's minimum size or `medium`.
   */
  describe('the compose part of a Pending setup in a Cloud Environment', () => {
    const STACKED = `version: 1
services:
  ghost-app: { kind: compose, managed: console }
`;

    const AWS: DeployTarget = {
      kind: 'cloud',
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
    };

    const TYPED: PendingSetupInput = {
      pendingSetupId: 'ps-3',
      templateId: 'ghost',
      templateName: 'Ghost',
      setupName: 'ghost',
      parts: [
        {
          configName: 'ghost-app',
          kind: 'compose',
          made: { DB_PASSWORD: 'generated (password, 32 characters)' },
          domains: [
            {
              service: 'ghost',
              port: 2368,
              path: '/',
              host: 'blog.example.com',
            },
          ],
          files: [{ path: 'config.production.json', mount: null }],
        },
      ],
    };

    function inCloud(more: Partial<PlanInput> = {}): PlanOutcome {
      return plan(STACKED, [TYPED], {
        deployTarget: AWS,
        cloud: 'aws',
        networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
        ...more,
      });
    }

    function stackOf(outcome: PlanOutcome): Create {
      const stack = creates(outcome).find(
        (step) => step.configName === 'ghost-app',
      );
      if (!stack) throw new Error('no create of ghost-app');
      return stack;
    }

    it('creates the stack as a Stack VM line, read from its cloud, with its template, typed hosts and files', () => {
      const stack = stackOf(inCloud());

      expect(stack).toMatchObject({
        action: 'create',
        kind: 'compose',
        placement: AWS,
        fields: [],
        cloudRead: { status: 'reading' },
        template: {
          pendingSetupId: 'ps-3',
          templateName: 'Ghost',
          domains: [
            {
              service: 'ghost',
              port: 2368,
              path: '/',
              host: 'blog.example.com',
            },
          ],
          files: [{ path: 'config.production.json', mount: null }],
        },
      });
      // Not a console-made stack's: there is no row yet.
      expect(stack.stackVm?.consoleStackId).toBeUndefined();
    });

    it('starts at medium when the template names no minimum size, priced in its region', () => {
      const vm = stackOf(inCloud()).stackVm;

      expect(vm?.size).toEqual({
        name: 'medium',
        from: 'default',
        machineType: 't3.small',
        machine: '2 vCPU, 2 GB',
      });
      expect(vm?.lines).toEqual([
        'ghost-app Stack VM: no size, starts at medium → t3.small (2 vCPU, 2 GB) in eu-west-1',
        'ghost-app Stack VM cost: about $19.40 a month (machine $16.64, 20 GB data disk $1.76, daily snapshots about $1.00)',
        'ghost-app Stack VM data disk: 20 GB for its volumes, snapshotted daily, each snapshot kept 7 days',
      ]);
    });

    it("starts at the template's minimum size", () => {
      const vm = stackOf(
        inCloud({ stackVmStartingSizes: { 'ghost-app': 'large' } }),
      ).stackVm;

      expect(vm?.size).toEqual({
        name: 'large',
        from: 'template',
        machineType: 't3.medium',
        machine: '2 vCPU, 4 GB',
      });
      expect(vm?.lines[0]).toBe(
        "ghost-app Stack VM: the template's minimum, large → t3.medium (2 vCPU, 4 GB) in eu-west-1",
      );
    });

    it('makes the Environment network first where there is none', () => {
      const outcome = inCloud({ networks: [] });

      expect(outcome.ok && outcome.steps.map((step) => step.action)).toEqual([
        'network-create',
        'create',
      ]);
    });

    it('refuses it in a Cloud account whose role predates Stack VMs', () => {
      const [refusal] = refusals(
        inCloud({
          cloudAccount: { name: 'Production AWS', policyVersion: 3 },
        }),
      );

      expect(refusal).toMatch(
        /^ghost-app: a Stack VM cannot be made in Cloud account Production AWS/,
      );
    });

    it('refuses the plan when a typed host is taken', () => {
      const taken = new Map([
        ['blog.example.com', 'Domain with this host and path already exists'],
      ]);

      expect(refusals(inCloud({ takenHosts: taken }))).toEqual([
        'ghost-app: its Domain blog.example.com is taken (Domain with this host and path already exists); cancel this setup and set the template up again with another host',
      ]);
    });

    it('creates nothing for a part whose stack an Apply already made, its Domains waiting for its Stack VM', () => {
      const waiting: PendingSetupInput = {
        ...TYPED,
        parts: [{ ...TYPED.parts[0], made: {}, stackId: 'compose-1' }],
      };

      expect(
        refusals(
          plan(STACKED, [waiting], {
            deployTarget: AWS,
            cloud: 'aws',
            networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
          }),
        ),
      ).toEqual([
        'ghost-app is listed with managed: console, but this Environment has no Service with that Config name; a console-managed Service is created in the console',
      ]);
    });
  });
});
