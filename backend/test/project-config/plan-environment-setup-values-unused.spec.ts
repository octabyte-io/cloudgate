import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  PendingSetupInput,
  PlanInput,
  PlanNote,
  PlanOutcome,
  PlanStep,
  SavedService,
} from '../../src/project-config';

/**
 * A Template set up into a repository-kept config (ADR-0065, #1378): the
 * user pastes the renamed entries into the file, and the plan of a push
 * picks the Pending setup up strictly by Config name and kind. A part the
 * plan does not create from it, renamed in the pasted YAML say, gets
 * nothing, and the plan notes the setup's values it left unused.
 */

const GHOST = `version: 1
services:
  ghost-app: { kind: compose, managed: console }
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
      kind: 'compose',
      made: { DB_PASSWORD: 'generated (password, 32 characters)' },
      domains: [
        {
          service: 'ghost',
          port: 2368,
          path: '/',
          host: 'ghost-1a2b3c-198-51-100-7.sslip.io',
        },
      ],
    },
    {
      configName: 'ghost-db',
      kind: 'postgres',
      made: { POSTGRES_INITDB_ARGS: 'fixed' },
    },
  ],
};

function plan(text: string, more: Partial<PlanInput> = {}): PlanOutcome {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  return planEnvironment({
    config: parsed.config,
    saved: [],
    deployTarget: { kind: 'platform-host' },
    context: { previous: null },
    pendingSetups: [SETUP],
    configKept: 'repository',
    ...more,
  });
}

function planned(outcome: PlanOutcome): {
  steps: readonly PlanStep[];
  notes: readonly PlanNote[];
} {
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((r) => r.message).join('; '));
  }
  return outcome;
}

function unused(outcome: PlanOutcome): PlanNote[] {
  return planned(outcome).notes.filter(
    (note) => note.kind === 'setup-values-unused',
  );
}

function templateOf(outcome: PlanOutcome, name: string) {
  const step = planned(outcome).steps.find(
    (one) => one.action === 'create' && one.configName === name,
  );
  return step?.action === 'create' ? step.template : undefined;
}

describe('planEnvironment', () => {
  describe("a repository-kept config's plan and its Pending setups", () => {
    it('creates every part from the setup when the pasted entries are unchanged, and notes nothing', () => {
      const outcome = plan(GHOST);

      expect(templateOf(outcome, 'ghost-app')?.pendingSetupId).toBe('ps-1');
      expect(templateOf(outcome, 'ghost-db')?.pendingSetupId).toBe('ps-1');
      expect(unused(outcome)).toEqual([]);
    });

    it('gives a renamed part nothing, and notes the values it left unused', () => {
      const outcome = plan(GHOST.replace('ghost-db', 'blog-db'));

      expect(templateOf(outcome, 'blog-db')).toBeUndefined();
      expect(templateOf(outcome, 'ghost-app')?.pendingSetupId).toBe('ps-1');
      expect(unused(outcome)).toEqual([
        {
          kind: 'setup-values-unused',
          configName: 'ghost-db',
          configNames: ['ghost-db'],
          pendingSetupId: 'ps-1',
          templateId: 'ghost',
          setupName: 'ghost',
          message:
            'ghost-db is not created from the ghost setup of the Ghost template: this config lists no postgres named ghost-db, so its values (POSTGRES_INITDB_ARGS) are left unused. List it under that Config name and kind, or cancel the setup',
        },
      ]);
    });

    it('gives a part listed under its name with another kind nothing, and notes it', () => {
      const outcome = plan(
        GHOST.replace(
          'kind: postgres\n    env: [POSTGRES_INITDB_ARGS]',
          'kind: redis\n    version: "7"',
        ),
      );

      expect(templateOf(outcome, 'ghost-db')).toBeUndefined();
      expect(unused(outcome).map((note) => note.configName)).toEqual([
        'ghost-db',
      ]);
    });

    it('gives a compose part listed as a described stack nothing: only its console-managed line takes it', () => {
      const described = GHOST.replace(
        'ghost-app: { kind: compose, managed: console }',
        `ghost-app:
    kind: compose
    source: { github: acme/ghost }`,
      );

      const outcome = plan(described);

      expect(templateOf(outcome, 'ghost-app')).toBeUndefined();
      const notes = unused(outcome);
      expect(notes.map((note) => note.configName)).toEqual(['ghost-app']);
      expect(notes[0].message).toContain(
        'this config lists no console-managed compose named ghost-app',
      );
    });

    it('notes every part in one note when the file lists none of them yet', () => {
      const outcome = plan(`version: 1
services:
  api:
    kind: web
    port: 3000
    source: { image: "api:1.0" }
`);

      expect(unused(outcome)).toEqual([
        expect.objectContaining({
          configName: 'ghost-app',
          configNames: ['ghost-app', 'ghost-db'],
          message:
            'ghost-app and ghost-db are not created from the ghost setup of the Ghost template: this config lists no console-managed compose named ghost-app and no postgres named ghost-db, so their values (DB_PASSWORD, POSTGRES_INITDB_ARGS) are left unused. List them under those Config names and kinds, or cancel the setup',
        }),
      ]);
    });

    it('notes a part whose Service already exists, which the plan does not create', () => {
      const cache: SavedService = {
        serviceType: 'redis',
        serviceId: 'redis-1',
        name: 'ghost-cache',
        configName: 'ghost-cache',
        settings: {
          description: null,
          cpuLimit: null,
          memoryLimit: null,
          dockerImage: 'redis:7',
        },
        variables: { env: [] },
      };
      const withCache: PendingSetupInput = {
        ...SETUP,
        parts: [
          ...SETUP.parts,
          { configName: 'ghost-cache', kind: 'redis', made: {} },
        ],
      };

      const outcome = plan(
        `${GHOST}  ghost-cache:\n    kind: redis\n    version: "7"\n`,
        { saved: [cache], pendingSetups: [withCache] },
      );

      expect(unused(outcome)).toEqual([
        expect.objectContaining({
          configNames: ['ghost-cache'],
          message:
            "ghost-cache is not created from the ghost setup of the Ghost template: ghost-cache's Service already exists here",
        }),
      ]);
    });

    it("notes nothing on a Cloudgate-kept config's plan, whose setup wrote the entries itself", () => {
      const outcome = plan(GHOST.replace('ghost-db', 'blog-db'), {
        configKept: undefined,
      });

      expect(unused(outcome)).toEqual([]);
    });
  });
});
