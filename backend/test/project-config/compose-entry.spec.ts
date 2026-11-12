import {
  generateProjectConfig,
  parseProjectConfig,
  planEnvironment,
} from '../../src/project-config';
import type {
  ConfigRefusal,
  DeployTarget,
  PlanOutcome,
  ProjectConfig,
  SavedComposeSettings,
  SavedService,
} from '../../src/project-config';

/**
 * A `kind: compose` entry (ADR-0069): a Compose stack described by the
 * compose file it names — its repository, the file's path there and how
 * it is deployed — never by a copy of the file.
 */

/** A config with one `analytics` entry of these lines. */
function analytics(...lines: string[]): string {
  return `version: 1\nservices:\n  analytics:\n${lines.map((line) => `    ${line}`).join('\n')}\n`;
}

const DESCRIBED = analytics(
  'kind: compose',
  'source:',
  '  github: acme/analytics',
);

function parsed(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function refused(text: string): ConfigRefusal {
  const result = parseProjectConfig(text);
  if (result.ok) throw new Error('parsed, but a refusal was expected');
  return result.refusal;
}

const SERVER: DeployTarget = { kind: 'server', serverId: 'srv-1' };
const CLOUD: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

function plan(
  text: string,
  saved: SavedService[] = [],
  options: { previous?: string; deployTarget?: DeployTarget } = {},
): PlanOutcome {
  return planEnvironment({
    config: parsed(text),
    saved,
    deployTarget: options.deployTarget ?? SERVER,
    context: {
      previous:
        options.previous === undefined ? null : parsed(options.previous),
    },
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

/** A stack as a console create from a GitHub repository leaves it. */
function stack(
  configName: string,
  settings: Partial<SavedComposeSettings> = {},
): SavedService {
  return {
    serviceType: 'compose',
    serviceId: `compose-${configName}`,
    name: configName,
    configName,
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
      ...settings,
    },
    variables: { env: [] },
  };
}

/** A template's stack: its compose file is kept in Cloudgate. */
const templateStack = (configName: string) =>
  stack(configName, { sourceType: 'raw', owner: null, repository: null });

describe('parseProjectConfig', () => {
  describe('a kind: compose entry', () => {
    it('reads the file it names, leaving out what it leaves out', () => {
      expect(parsed(DESCRIBED).services.analytics).toEqual({
        kind: 'compose',
        managed: false,
        source: { sourceType: 'github', repository: 'acme/analytics' },
        env: [],
      });
      expect(
        parsed(
          analytics(
            'kind: compose',
            'source:',
            '  git: https://git.example.com/acme/analytics.git',
            'file: deploy/docker-compose.yml',
            'type: stack',
          ),
        ).services.analytics,
      ).toEqual({
        kind: 'compose',
        managed: false,
        source: {
          sourceType: 'git',
          customGitUrl: 'https://git.example.com/acme/analytics.git',
        },
        composePath: 'deploy/docker-compose.yml',
        composeType: 'stack',
        env: [],
      });
    });

    it('requires a source', () => {
      expect(refused(analytics('kind: compose'))).toMatchObject({
        reason: 'invalid',
        at: 'analytics.source',
      });
    });

    it('refuses an image, or a path beside the repository, naming the forms a source takes', () => {
      for (const source of [
        ['source:', '  image: ghcr.io/acme/analytics:1'],
        ['source:', '  github: acme/analytics', '  path: apps/analytics'],
      ]) {
        const refusal = refused(analytics('kind: compose', ...source));
        expect(refusal.at).toMatch(/^analytics\.source/);
      }
      expect(
        refused(
          analytics('kind: compose', 'source:', '  image: ghcr.io/acme/a:1'),
        ).message,
      ).toMatch(/the repository its compose file is in/);
    });

    it('refuses a file that leaves the repository', () => {
      expect(
        refused(
          analytics(
            'kind: compose',
            'source:',
            '  github: acme/analytics',
            'file: ../../etc/compose.yml',
          ),
        ),
      ).toMatchObject({ at: 'analytics.file' });
    });

    it('refuses a type that is not docker-compose or stack', () => {
      expect(
        refused(
          analytics(
            'kind: compose',
            'source:',
            '  github: acme/analytics',
            'type: kubernetes',
          ),
        ),
      ).toMatchObject({ at: 'analytics.type' });
    });

    it.each([
      ['services: {}', 'analytics.services'],
      ['env: [API_KEY]', 'analytics.env'],
      ['branch: main', 'analytics.branch'],
      ['description: Dashboards', 'analytics.description'],
    ])(
      'refuses %s: nothing of the file, nor what is Cloudgate’s, is a field',
      (line, at) => {
        expect(refused(`${DESCRIBED}    ${line}\n`)).toEqual({
          reason: 'invalid',
          at,
          message: `${at}: it is not a field Cloudgate knows`,
        });
      },
    );
  });
});

describe('planEnvironment', () => {
  describe('a kind: compose entry', () => {
    it('creates a stack from the file it names, on the Deploy target', () => {
      const { steps } = planned(
        analytics(
          'kind: compose',
          'source:',
          '  github: acme/analytics',
          'file: deploy/docker-compose.yml',
        ),
      );
      expect(steps).toEqual([
        {
          action: 'create',
          configName: 'analytics',
          kind: 'compose',
          placement: SERVER,
          fields: [
            { field: 'source', from: null, to: { github: 'acme/analytics' } },
            {
              field: 'file',
              from: null,
              to: 'deploy/docker-compose.yml',
            },
          ],
        },
      ]);
    });

    it('changes nothing for a stack as the entry names it, a stored ./ path included', () => {
      expect(planned(DESCRIBED, [stack('analytics')])).toEqual({
        ok: true,
        steps: [],
        notes: [],
      });
    });

    it('changes the source and the file, never comparing what the file holds', () => {
      const { steps } = planned(
        analytics(
          'kind: compose',
          'source:',
          '  gitlab: acme/platform/analytics',
          'file: deploy/compose.yml',
        ),
        [stack('analytics')],
      );
      expect(steps).toEqual([
        {
          action: 'change',
          configName: 'analytics',
          kind: 'compose',
          serviceType: 'compose',
          serviceId: 'compose-analytics',
          name: 'analytics',
          fields: [
            {
              field: 'source',
              from: { github: 'acme/analytics' },
              to: { gitlab: 'acme/platform/analytics' },
            },
            {
              field: 'file',
              from: 'docker-compose.yml',
              to: 'deploy/compose.yml',
            },
          ],
        },
      ]);
    });

    it('reads a GitLab stack by its path namespace', () => {
      expect(
        planned(
          analytics('kind: compose', 'source:', '  gitlab: acme/platform/a'),
          [
            stack('analytics', {
              sourceType: 'gitlab',
              owner: null,
              repository: null,
              gitlabOwner: 'acme',
              gitlabRepository: 'a',
              gitlabPathNamespace: 'acme/platform/a',
            }),
          ],
        ).steps,
      ).toEqual([]);
    });

    it('destroys and creates a stack whose type changes, as a rename does', () => {
      const { steps } = planned(
        analytics(
          'kind: compose',
          'source:',
          '  github: acme/analytics',
          'type: stack',
        ),
        [stack('analytics')],
      );
      expect(
        steps.map((step) => [
          step.action,
          'configName' in step ? step.configName : null,
        ]),
      ).toEqual([
        ['destroy', 'analytics'],
        ['create', 'analytics'],
      ]);
      const create = steps.find((step) => step.action === 'create');
      expect(create?.action === 'create' && create.fields).toContainEqual({
        field: 'type',
        from: null,
        to: 'stack',
      });
    });

    it('destroys a stack the config described and no longer lists', () => {
      const { steps } = planned('version: 1\nservices: {}\n', [stack('old')], {
        previous: `version: 1\nservices:\n  old:\n    kind: compose\n    source:\n      github: acme/analytics\n`,
      });
      expect(steps).toEqual([
        {
          action: 'destroy',
          configName: 'old',
          kind: 'compose',
          serviceType: 'compose',
          serviceId: 'compose-old',
          name: 'old',
        },
      ]);
    });

    it('never destroys a stack it did not describe: one that was console-managed is a note', () => {
      const outcome = planned('version: 1\nservices: {}\n', [stack('old')], {
        previous: `version: 1\nservices:\n  old:\n    kind: compose\n    managed: console\n`,
      });
      expect(outcome.steps).toEqual([]);
      expect(outcome.notes.map((note) => note.kind)).toEqual([
        'console-managed-dropped',
      ]);
    });

    // A stack takes no uploaded archive (`composeSourceTypeSchema`), so
    // `raw` is the one source kept in Cloudgate.
    it('refuses describing a raw stack, which stays console-managed', () => {
      const [refusal] = refusals(DESCRIBED, [
        stack('analytics', {
          sourceType: 'raw',
          owner: null,
          repository: null,
        }),
      ]);
      expect(refusal.at).toBe('analytics.source');
      expect(refusal.message).toMatch(
        /kept in Cloudgate, as every template stack’s is/,
      );
      expect(refusal.message).toMatch(/managed: console/);
    });

    it('refuses a native.docker block, naming it (ADR-0069)', () => {
      const native = ['native:', '  docker:', '    labels:', '      a: b'];
      expect(
        refusals(`${DESCRIBED}${native.map((l) => `    ${l}\n`).join('')}`),
      ).toEqual([
        {
          at: 'analytics.native.docker',
          message: expect.stringMatching(
            /^analytics\.native\.docker: refused - a Compose stack's container settings are its compose file's/,
          ) as string,
        },
      ]);
    });

    it('takes a native.aws block, which sets its Stack VM in an AWS Environment (ADR-0070)', () => {
      const native = ['native:', '  aws: {}'];
      expect(
        plan(`${DESCRIBED}${native.map((l) => `    ${l}\n`).join('')}`).ok,
      ).toBe(true);
    });

    describe('where the Deploy target is a Cloud account', () => {
      it('creates one on its own Stack VM, never on a Server (ADR-0070)', () => {
        const { steps } = planned(DESCRIBED, [], { deployTarget: CLOUD });
        const create = steps.find((step) => step.action === 'create');
        expect(create?.action === 'create' && create.stackVm).toBeTruthy();
      });

      it('refuses the create half of a type change too', () => {
        const [refusal] = refusals(
          `${DESCRIBED}    type: stack\n`,
          [stack('analytics')],
          { deployTarget: CLOUD },
        );
        expect(refusal.message).toMatch(/cannot run in a Cloud account/);
      });

      it('still changes a stack already on a Server there, which keeps its place', () => {
        const { steps } = planned(
          `${DESCRIBED}    file: compose.yml\n`,
          [stack('analytics')],
          { deployTarget: CLOUD },
        );
        expect(steps.map((step) => step.action)).toEqual(['change']);
      });
    });

    describe('listed managed: console', () => {
      const consoleManaged = `version: 1\nservices:\n  analytics:\n    kind: compose\n    managed: console\n`;

      it('notes that a stack whose compose file is in a repository can now be described, and plans nothing', () => {
        expect(
          planned(consoleManaged, [stack('analytics')], {
            previous: consoleManaged,
          }),
        ).toEqual({
          ok: true,
          steps: [],
          notes: [
            {
              kind: 'compose-can-be-described',
              configName: 'analytics',
              message:
                'analytics: its compose file is in a repository, so it can now be described as kind: compose; remove managed: console and name its source, file and type to hand it to the config',
            },
          ],
        });
      });

      it('notes nothing of a template stack, which cannot be described', () => {
        expect(
          planned(consoleManaged, [templateStack('analytics')], {
            previous: consoleManaged,
          }),
        ).toEqual({ ok: true, steps: [], notes: [] });
      });
    });
  });
});

describe('generateProjectConfig', () => {
  const environments = (...saved: SavedService[]) => [
    { name: 'production', deployTarget: SERVER, saved },
  ];

  it('keeps every stack managed: console, as it was: no upgrade hands one over', () => {
    const text = generateProjectConfig({
      environments: environments(
        stack('analytics'),
        templateStack('plausible'),
      ),
      schemaUrl: null,
    });
    expect(parsed(text).services).toEqual({
      analytics: { kind: 'compose', managed: 'console' },
      plausible: { kind: 'compose', managed: 'console' },
    });
  });

  it('keeps a stack the stored config describes described, writing only what differs from the defaults', () => {
    const saved = [
      stack('analytics', {
        composePath: './deploy/docker-compose.yml',
        composeType: 'stack',
      }),
    ];
    const text = generateProjectConfig({
      environments: environments(...saved),
      schemaUrl: null,
      described: new Set(['analytics']),
    });
    expect(text).toContain(
      [
        '  analytics:',
        '    kind: compose',
        '    source:',
        '      github: acme/analytics',
        '    file: deploy/docker-compose.yml',
        '    type: stack',
      ].join('\n'),
    );
    expect(
      planEnvironment({
        config: parsed(text),
        saved,
        deployTarget: SERVER,
        context: { previous: parsed(text) },
      }),
    ).toEqual({ ok: true, steps: [], notes: [] });
  });

  it('lists a template stack managed: console even where the stored config describes it', () => {
    const text = generateProjectConfig({
      environments: environments(templateStack('plausible')),
      schemaUrl: null,
      described: new Set(['plausible']),
    });
    expect(parsed(text).services.plausible).toEqual({
      kind: 'compose',
      managed: 'console',
    });
  });
});
