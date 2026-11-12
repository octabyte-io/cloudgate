import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import { linkableSources } from '../../src/project-config/planner/plan-links';
import type {
  DeployTarget,
  PlanOutcome,
  ProjectConfig,
  SavedService,
} from '../../src/project-config';

/**
 * The planner's wired-variable rules (ADR-0031): links a plan
 * honours, how a change of link reads, and each refusal, naming the Service
 * and the variable.
 */

const SERVER: DeployTarget = { kind: 'server', serverId: 'srv-1' };

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function plan(
  text: string,
  saved: SavedService[] = [],
  previous: string | null = null,
  deployTarget: DeployTarget = SERVER,
): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved,
    deployTarget,
    context: { previous: previous === null ? null : config(previous) },
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

function savedWeb(
  extra: { env?: string[]; links?: SavedService['links'] } = {},
): SavedService {
  return {
    serviceType: 'application',
    serviceId: 'app-web',
    name: 'web',
    configName: 'web',
    serverId: 'srv-1',
    ...(extra.links ? { links: extra.links } : {}),
    settings: {
      configKind: 'web',
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      command: null,
      args: null,
      port: 3000,
      cronSchedule: null,
      cronTimezone: null,
      cronTimeoutSeconds: null,
      sourceType: 'github',
      owner: null,
      repository: null,
      buildPath: '/',
      gitlabOwner: null,
      gitlabRepository: null,
      gitlabPathNamespace: null,
      gitlabBuildPath: '/',
      giteaOwner: null,
      giteaRepository: null,
      giteaBuildPath: '/',
      bitbucketOwner: null,
      bitbucketRepository: null,
      bitbucketBuildPath: '/',
      customGitUrl: null,
      customGitBuildPath: null,
      dockerImage: null,
      buildType: 'nixpacks',
      railpackVersion: '0.15.4',
      herokuVersion: '24',
      dockerfile: 'Dockerfile',
      dockerContextPath: null,
      dockerBuildStage: null,
      publishDirectory: null,
      isStaticSpa: null,
      createEnvFile: true,
      enableSubmodules: false,
      watchPaths: null,
    },
    variables: { env: extra.env ?? [], buildArgs: [], buildSecrets: [] },
  };
}

function savedPostgres(configName = 'pg-1', serverId = 'srv-1'): SavedService {
  return {
    serviceType: 'postgres',
    serviceId: `pg-${configName}`,
    name: configName,
    configName,
    serverId,
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'postgres:18',
      databaseName: 'app',
      databaseUser: 'app',
    },
    variables: { env: [] },
  };
}

function savedRedis(): SavedService {
  return {
    serviceType: 'redis',
    serviceId: 'redis-redis',
    name: 'redis',
    configName: 'redis',
    serverId: 'srv-1',
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'redis:8',
    },
    variables: { env: [] },
  };
}

/** `web`, `pg-1` and `redis`, with `web`'s env as given. */
const stack = (webEnv: string, extra = '') => `version: 1
services:
  web:
    kind: web
    env: ${webEnv}
  pg-1:
    kind: postgres
  redis:
    kind: redis
${extra}`;

const existing = (web: SavedService = savedWeb()) => [
  web,
  savedPostgres(),
  savedRedis(),
];

describe('planEnvironment: wired variables', () => {
  it('plans links to a postgres and a redis it creates on the same Server', () => {
    const { steps, notes } = planned(
      stack('[NODE_ENV, { DATABASE_URL: pg-1.url }, { REDIS_URL: redis.url }]'),
    );
    const web = steps.find(
      (step) => step.action === 'create' && step.configName === 'web',
    );
    expect(web).toMatchObject({
      fields: expect.arrayContaining([
        { field: 'env.DATABASE_URL', from: null, to: 'pg-1.url' },
        { field: 'env.REDIS_URL', from: null, to: 'redis.url' },
      ]) as unknown,
    });
    // Only the typed name needs a value here; a link never does.
    expect(
      notes.filter((note) => note.kind === 'variable-without-value'),
    ).toEqual([expect.objectContaining({ variable: 'NODE_ENV' })]);
  });

  it.each(['url', 'host', 'port', 'user', 'password', 'database'])(
    'accepts a link to a postgres %s',
    (output) => {
      expect(plan(stack(`[{ V: pg-1.${output} }]`), existing()).ok).toBe(true);
    },
  );

  it.each(['url', 'host', 'port', 'password'])(
    'accepts a link to a redis %s',
    (output) => {
      expect(plan(stack(`[{ V: redis.${output} }]`), existing()).ok).toBe(true);
    },
  );

  it('accepts links between Services on the platform host', () => {
    const onHost = existing().map((found) => ({
      ...found,
      serverId: undefined,
    }));
    expect(
      plan(stack('[{ V: pg-1.url }]'), onHost as SavedService[], null, {
        kind: 'platform-host',
      }).ok,
    ).toBe(true);
  });

  it('has nothing to change when the applied links are the config links', () => {
    const saved = existing(
      savedWeb({ links: { DATABASE_URL: { source: 'pg-1', output: 'url' } } }),
    );
    expect(planned(stack('[{ DATABASE_URL: pg-1.url }]'), saved).steps).toEqual(
      [],
    );
  });

  it('drops a typed value for a name the config now links, as a change', () => {
    const saved = existing(savedWeb({ env: ['DATABASE_URL', 'NODE_ENV'] }));
    const { steps } = planned(
      stack('[NODE_ENV, { DATABASE_URL: pg-1.url }]'),
      saved,
    );
    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'web',
        fields: [
          {
            field: 'env',
            from: ['DATABASE_URL', 'NODE_ENV'],
            to: ['NODE_ENV'],
          },
          { field: 'env.DATABASE_URL', from: 'typed value', to: 'pg-1.url' },
        ],
      }),
    ]);
  });

  it('shows a link the config drops, or moves to another Output, as a change', () => {
    const saved = existing(
      savedWeb({
        links: {
          DATABASE_URL: { source: 'pg-1', output: 'url' },
          DB_HOST: { source: 'pg-1', output: 'host' },
        },
      }),
    );
    expect(planned(stack('[{ DB_HOST: pg-1.port }]'), saved).steps).toEqual([
      expect.objectContaining({
        action: 'change',
        fields: [
          { field: 'env.DB_HOST', from: 'pg-1.host', to: 'pg-1.port' },
          { field: 'env.DATABASE_URL', from: 'pg-1.url', to: null },
        ],
      }),
    ]);
  });

  describe('refusals, each naming the Service and the variable', () => {
    const at = 'web.env.DATABASE_URL';

    it('refuses a missing source', () => {
      expect(
        refusals(stack('[{ DATABASE_URL: pg-2.url }]'), existing()),
      ).toEqual([
        {
          at,
          message: `${at} links to pg-2.url, but this config has no Service pg-2`,
        },
      ]);
    });

    it('refuses a source the config removes or renames while the link stays', () => {
      const renamed = `version: 1
services:
  web:
    kind: web
    env: [{ DATABASE_URL: pg-1.url }]
  pg-2:
    kind: postgres
`;
      const [only] = refusals(renamed, existing(), stack('[]'));
      expect(only.at).toBe(at);
      expect(only.message).toContain('this config no longer lists pg-1');
    });

    it.each([
      ['an unknown Output', 'pg-1.uri', 'hands out no uri'],
      [
        'ca on a Server',
        'pg-1.ca',
        'a postgres on Server srv-1 hands out no ca',
      ],
      ['an Output of another kind', 'redis.user', 'hands out no user'],
    ])('refuses %s', (_case, target, words) => {
      const [only] = refusals(
        stack(`[{ DATABASE_URL: ${target} }]`),
        existing(),
      );
      expect(only.at).toBe(at);
      expect(only.message).toContain(words);
    });

    it.each(['worker', 'web', 'static'])(
      'refuses a %s, a kind with no Outputs',
      (kind) => {
        const text = `${stack('[{ DATABASE_URL: api.url }]')}  api:\n    kind: ${kind}\n`;
        const [only] = refusals(text, existing());
        expect(only.at).toBe(at);
        expect(only.message).toContain('which hands out no Outputs');
      },
    );

    it("takes a link to a mysql's url, and refuses its ca on a Server", () => {
      const text = (output: string) =>
        `${stack(`[{ DATABASE_URL: my-1.${output} }]`)}  my-1:\n    kind: mysql\n`;
      expect(plan(text('url'), existing()).ok).toBe(true);
      const [only] = refusals(text('ca'), existing());
      expect(only.at).toBe(at);
      expect(only.message).toContain('a mysql on Server srv-1 hands out no ca');
    });

    it('refuses a console-managed source', () => {
      const text = `version: 1
services:
  web:
    kind: web
    env: [{ DATABASE_URL: pg-1.url }]
  pg-1:
    kind: postgres
    managed: console
`;
      const [only] = refusals(text, existing(), text);
      expect(only.at).toBe(at);
      expect(only.message).toContain('pg-1 is managed: console');
    });

    it('refuses a source on another Server', () => {
      const saved = [savedWeb(), savedPostgres('pg-1', 'srv-2'), savedRedis()];
      const [only] = refusals(stack('[{ DATABASE_URL: pg-1.url }]'), saved);
      expect(only.at).toBe(at);
      expect(only.message).toContain('cannot reach it');
    });

    it('refuses a source on another Server than the one a create goes on', () => {
      expect(
        refusals(stack('[{ DATABASE_URL: pg-1.url }]'), [
          savedPostgres('pg-1', 'srv-2'),
        ]).map((refusal) => refusal.at),
      ).toEqual([at]);
    });

    it('refuses a source on the platform host from a Service on a Server', () => {
      const onHost = { ...savedPostgres(), serverId: undefined };
      expect(
        refusals(stack('[{ DATABASE_URL: pg-1.url }]'), [
          savedWeb(),
          onHost as SavedService,
          savedRedis(),
        ]).map((refusal) => refusal.at),
      ).toEqual([at]);
    });

    it('refuses a loop of links, once', () => {
      const text = `version: 1
services:
  pg-1:
    kind: postgres
    env: [{ CACHE: redis.url }]
  redis:
    kind: redis
    env: [{ DB: pg-1.host }]
`;
      const found = refusals(text);
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('closes a loop of links');
      expect(found[0].message).toContain('pg-1 → redis → pg-1');
    });

    it('refuses a Service linking to itself', () => {
      expect(
        refusals(
          'version: 1\nservices:\n  pg-1:\n    kind: postgres\n    env: [{ SELF: pg-1.url }]\n',
        ).map((refusal) => refusal.at),
      ).toEqual(['pg-1.env.SELF']);
    });
  });
});

describe('planEnvironment: wired variables to a bucket', () => {
  const BUCKET_OUTPUTS = [
    'name',
    'region',
    'endpoint',
    'access_key_id',
    'secret_access_key',
    'path_style',
  ];
  const withUploads = (webEnv: string, workerEnv = '[]') =>
    stack(
      webEnv,
      `  worker:
    kind: worker
    env: ${workerEnv}
  uploads:
    kind: bucket
`,
    );
  const savedUploads = (serverId = 'srv-1'): SavedService => ({
    serviceType: 'bucket',
    serviceId: 'bucket-uploads',
    name: 'uploads',
    configName: 'uploads',
    serverId,
    settings: { description: null, bucketName: 'uploads-k3j9x2ab' },
    variables: { env: [] },
  });

  it('plans a link to each of its six Outputs, shown as a link and never a value', () => {
    const env = `[${BUCKET_OUTPUTS.map((output) => `{ V_${output.toUpperCase()}: uploads.${output} }`).join(', ')}]`;
    const { steps } = planned(withUploads(env));
    const web = steps.find(
      (step) => step.action === 'create' && step.configName === 'web',
    );
    expect(web).toMatchObject({
      fields: expect.arrayContaining(
        BUCKET_OUTPUTS.map((output) => ({
          field: `env.V_${output.toUpperCase()}`,
          from: null,
          to: `uploads.${output}`,
        })),
      ) as unknown,
    });
  });

  it('lets any number of Services link one bucket', () => {
    expect(
      plan(
        withUploads(
          '[{ S3_BUCKET: uploads.name }]',
          '[{ BUCKET: uploads.name }]',
        ),
        [...existing(), savedUploads()],
      ).ok,
    ).toBe(true);
  });

  it('refuses an Output a bucket does not hand out, naming the Service, the variable and its Outputs', () => {
    expect(
      refusals(withUploads('[{ S3_URL: uploads.url }]'), [
        ...existing(),
        savedUploads(),
      ]),
    ).toEqual([
      {
        at: 'web.env.S3_URL',
        message: `web.env.S3_URL links to uploads.url, but a bucket on Server srv-1 hands out no url; it hands out ${BUCKET_OUTPUTS.join(', ')}`,
      },
    ]);
  });

  it('refuses a bucket on another Server', () => {
    expect(
      refusals(withUploads('[{ S3_BUCKET: uploads.name }]'), [
        ...existing(),
        savedUploads('srv-2'),
      ]).map((refusal) => refusal.at),
    ).toEqual(['web.env.S3_BUCKET']);
  });
});

/**
 * The console's picker: the sources a Service may link to are the
 * ones a plan accepts a link to, with that kind's Outputs.
 */
describe('linkableSources', () => {
  const sourcesOf = (
    text: string,
    saved: SavedService[] = existing(),
    name = 'web',
  ) =>
    linkableSources(
      {
        config: config(text),
        saved,
        deployTarget: SERVER,
        context: { previous: null },
      },
      name,
    );

  it("offers each described source on the same Server with its kind's Outputs", () => {
    expect(sourcesOf(stack('[NODE_ENV]'))).toEqual([
      {
        configName: 'pg-1',
        kind: 'postgres',
        outputs: ['url', 'host', 'port', 'user', 'password', 'database'],
      },
      {
        configName: 'redis',
        kind: 'redis',
        outputs: ['url', 'host', 'port', 'password'],
      },
    ]);
  });

  it('does not offer a console-managed Service, one on another Server, or one with no Outputs', () => {
    const text = `version: 1
services:
  web:
    kind: web
  api:
    kind: web
  pg-1:
    kind: postgres
  redis:
    kind: redis
    managed: console
`;
    const saved = [savedWeb(), savedPostgres('pg-1', 'srv-2'), savedRedis()];
    expect(sourcesOf(text, saved)).toEqual([]);
  });

  it('does not offer a source that already links back to the Service', () => {
    const text = stack(
      '[NODE_ENV]',
      '  worker:\n    kind: postgres\n    env: [{ WEB: web.url }]\n',
    );
    expect(sourcesOf(text).map((source) => source.configName)).toEqual([
      'pg-1',
      'redis',
    ]);
  });

  it('offers nothing to a Service the config does not describe', () => {
    expect(sourcesOf(stack('[NODE_ENV]'), existing(), 'api')).toEqual([]);
  });
});
