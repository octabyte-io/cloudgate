import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  PendingSetupInput,
  PlanNote,
  PlanOutcome,
  SavedService,
  SetupRecordInput,
} from '../../src/project-config';

/**
 * A Template set up in one Environment, planned in another (ADR-0065,
 * #1377): the Project's Setup records hold a setup's parts back together,
 * with one note, wherever none of them exists and no Pending setup covers
 * them, so `staging` never gets a database with empty passwords or a
 * refused stack line.
 */

const CONFIG = `version: 1
services:
  api:
    kind: web
    port: 3000
    source: { image: "api:1.0" }
  ghost-app:
    kind: web
    port: 2368
    source: { image: "ghost:5.96" }
    env:
      - SESSION_SECRET
      - CACHE_URL: ghost-cache.url
  ghost-cache:
    kind: redis
    version: "7"
  ghost-stack:
    kind: compose
    managed: console
`;

const RECORD: SetupRecordInput = {
  setupRecordId: 'sr-1',
  templateId: 'ghost',
  setupName: 'ghost',
  configNames: ['ghost-app', 'ghost-cache', 'ghost-stack'],
};

const PENDING: PendingSetupInput = {
  pendingSetupId: 'ps-1',
  templateId: 'ghost',
  templateName: 'Ghost',
  setupName: 'ghost',
  parts: [
    {
      configName: 'ghost-app',
      kind: 'web',
      made: { SESSION_SECRET: 'generated (base64, 32 bytes)' },
    },
    { configName: 'ghost-cache', kind: 'redis', made: {} },
  ],
};

function savedRedis(configName: string): SavedService {
  return {
    serviceType: 'redis',
    serviceId: `redis-${configName}`,
    name: configName,
    configName,
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'redis:7',
    },
    variables: { env: [] },
  };
}

function plan(
  text: string,
  input: {
    readonly setupRecords?: readonly SetupRecordInput[];
    readonly pendingSetups?: readonly PendingSetupInput[];
    readonly saved?: SavedService[];
    readonly previous?: string;
  },
): PlanOutcome {
  const parse = (yaml: string) => {
    const parsed = parseProjectConfig(yaml);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    return parsed.config;
  };
  return planEnvironment({
    config: parse(text),
    saved: input.saved ?? [],
    deployTarget: { kind: 'platform-host' },
    context: {
      previous: input.previous === undefined ? null : parse(input.previous),
    },
    ...(input.setupRecords ? { setupRecords: input.setupRecords } : {}),
    ...(input.pendingSetups ? { pendingSetups: input.pendingSetups } : {}),
  });
}

function planned(outcome: PlanOutcome) {
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((r) => r.message).join('; '));
  }
  return outcome;
}

const created = (outcome: PlanOutcome) =>
  planned(outcome)
    .steps.flatMap((step) =>
      step.action === 'create' ? [step.configName] : [],
    )
    .sort();

const heldNotes = (outcome: PlanOutcome) =>
  planned(outcome).notes.filter((note) => note.kind === 'setup-held-back');

describe('planEnvironment', () => {
  describe('a Setup record in an Environment its template was not set up in', () => {
    it('holds every part back together, the console-managed stack line too, with one note', () => {
      const outcome = plan(CONFIG, { setupRecords: [RECORD] });

      expect(created(outcome)).toEqual(['api']);
      expect(heldNotes(outcome)).toEqual<PlanNote[]>([
        {
          kind: 'setup-held-back',
          configName: 'ghost-app',
          configNames: ['ghost-app', 'ghost-cache', 'ghost-stack'],
          templateId: 'ghost',
          setupName: 'ghost',
          message:
            'ghost-app, ghost-cache and ghost-stack are held back here: they were set up from the ghost template in another Environment, and are created here when the template is set up in this Environment',
        },
      ]);
    });

    it('notes no empty variable for a part it holds back', () => {
      const outcome = plan(CONFIG, { setupRecords: [RECORD] });

      expect(
        planned(outcome).notes.filter(
          (note) => note.kind === 'variable-without-value',
        ),
      ).toEqual([]);
    });

    it('holds the stack line back whether or not the config in effect had it', () => {
      const outcome = plan(CONFIG, {
        setupRecords: [RECORD],
        previous: CONFIG,
      });

      expect(created(outcome)).toEqual(['api']);
      expect(heldNotes(outcome)).toHaveLength(1);
    });

    it('holds nothing back where a Pending setup covers the parts', () => {
      const outcome = plan(CONFIG.replace(/ {2}ghost-stack:\n.*\n.*\n/, ''), {
        setupRecords: [RECORD],
        pendingSetups: [PENDING],
      });

      expect(created(outcome)).toEqual(['api', 'ghost-app', 'ghost-cache']);
      expect(heldNotes(outcome)).toEqual([]);
    });

    it('holds nothing back where one of the parts already exists', () => {
      const outcome = plan(CONFIG.replace(/ {2}ghost-stack:\n.*\n.*\n/, ''), {
        setupRecords: [RECORD],
        saved: [savedRedis('ghost-cache')],
      });

      expect(created(outcome)).toEqual(['api', 'ghost-app']);
      expect(heldNotes(outcome)).toEqual([]);
    });

    it('refuses an entry of the config that links to a part it holds back', () => {
      const outcome = plan(
        CONFIG.replace(
          '    source: { image: "api:1.0" }\n',
          '    source: { image: "api:1.0" }\n    env:\n      - CACHE_URL: ghost-cache.url\n',
        ),
        { setupRecords: [RECORD] },
      );

      expect(outcome).toEqual({
        ok: false,
        refusals: [
          {
            at: 'api.env.CACHE_URL',
            message:
              'api.env.CACHE_URL links to ghost-cache.url, but ghost-cache is held back in this Environment until the ghost template is set up here',
          },
        ],
      });
    });

    it('plans as before with no Setup record', () => {
      const outcome = plan(
        CONFIG.replace(/ {2}ghost-stack:\n.*\n.*\n/, ''),
        {},
      );

      expect(created(outcome)).toEqual(['api', 'ghost-app', 'ghost-cache']);
      expect(heldNotes(outcome)).toEqual([]);
    });
  });
});
