import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  ProjectConfig,
  SavedService,
} from '../../src/project-config';

/**
 * How links shape a plan's Apply (ADR-0031): a source's step runs
 * before what links to it, a changed Output redeploys what links to it, and
 * a destroyed source goes after whatever stops linking to it.
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

type Step = ReturnType<typeof planned>['steps'][number];

/** Each step as `<action> <configName>`, in the order an Apply runs them. */
const order = (steps: readonly Step[]) =>
  steps.map((step) =>
    'configName' in step ? `${step.action} ${step.configName}` : step.action,
  );

const STACK = (webEnv: string, pg = '') => `version: 1
services:
  web:
    kind: web
    env: ${webEnv}
  pg-1:
    kind: postgres
${pg}`;

const linkedWeb = (links: SavedService['links']) => savedWeb({ links });

describe('planEnvironment: links order the Apply', () => {
  it("runs a created source's step before the step of what links to it", () => {
    const { steps } = planned(STACK('[{ DATABASE_URL: pg-1.url }]'));
    expect(order(steps)).toEqual(['create pg-1', 'create web']);
  });

  it('keeps creates, changes and destroys in that order when nothing links', () => {
    const { steps } = planned(
      `version: 1
services:
  web:
    kind: web
    port: 8080
  cache:
    kind: redis
`,
      [savedWeb(), savedPostgres()],
      `version: 1
services:
  web:
    kind: web
  pg-1:
    kind: postgres
`,
    );
    expect(order(steps)).toEqual([
      'create cache',
      'change web',
      'destroy pg-1',
    ]);
  });

  it('redeploys what links to a re-created source after it, saying which link changed', () => {
    const pg1AsRedis: SavedService = {
      ...savedRedis(),
      serviceId: 'redis-pg-1',
      name: 'pg-1',
      configName: 'pg-1',
    };
    const { steps } = planned(
      STACK('[{ DATABASE_URL: pg-1.url }]'),
      [
        linkedWeb({ DATABASE_URL: { source: 'pg-1', output: 'url' } }),
        pg1AsRedis,
      ],
      STACK('[{ DATABASE_URL: pg-1.url }]').replace(
        'kind: postgres',
        'kind: redis',
      ),
    );
    expect(order(steps)).toEqual([
      'destroy pg-1',
      'create pg-1',
      'redeploy web',
    ]);
    expect(steps[2]).toMatchObject({
      action: 'redeploy',
      serviceId: 'app-web',
      because: ['pg-1.url'],
    });
  });

  it("redeploys only what links to an Output a source's change feeds", () => {
    const { steps } = planned(
      STACK(
        '[{ DATABASE_URL: pg-1.url }, { DB_HOST: pg-1.host }]',
        '    user: shop\n',
      ),
      [
        linkedWeb({
          DATABASE_URL: { source: 'pg-1', output: 'url' },
          DB_HOST: { source: 'pg-1', output: 'host' },
        }),
        savedPostgres(),
      ],
    );
    expect(order(steps)).toEqual(['change pg-1', 'redeploy web']);
    expect(steps[1]).toMatchObject({ because: ['pg-1.url'] });

    const hostOnly = planned(
      STACK('[{ DB_HOST: pg-1.host }]', '    user: shop\n'),
      [
        linkedWeb({ DB_HOST: { source: 'pg-1', output: 'host' } }),
        savedPostgres(),
      ],
    );
    expect(order(hostOnly.steps)).toEqual(['change pg-1']);
  });

  it("puts the reason on a linked Service's own change rather than adding a redeploy", () => {
    const { steps } = planned(
      `version: 1
services:
  web:
    kind: web
    port: 8080
    env: [{ DATABASE_URL: pg-1.url }]
  pg-1:
    kind: postgres
    database: shop
`,
      [
        linkedWeb({ DATABASE_URL: { source: 'pg-1', output: 'url' } }),
        savedPostgres(),
      ],
    );
    expect(order(steps)).toEqual(['change pg-1', 'change web']);
    expect(steps[1]).toMatchObject({ because: ['pg-1.url'] });
  });

  it("runs a source's change before a change of what links to it, whatever the config's order", () => {
    const { steps } = planned(
      `version: 1
services:
  web:
    kind: web
    port: 8080
    env: [{ DATABASE_URL: pg-1.url }]
  pg-1:
    kind: postgres
    description: the shop's
`,
      [
        linkedWeb({ DATABASE_URL: { source: 'pg-1', output: 'url' } }),
        savedPostgres(),
      ],
    );
    expect(order(steps)).toEqual(['change pg-1', 'change web']);
    expect(steps[1]).not.toHaveProperty('because');
  });

  it('renames a linked source as: create the new one, move the link, destroy the old one', () => {
    const { steps } = planned(
      STACK('[{ DATABASE_URL: pg-2.url }]').replace('pg-1:', 'pg-2:'),
      [
        linkedWeb({ DATABASE_URL: { source: 'pg-1', output: 'url' } }),
        savedPostgres(),
      ],
      STACK('[{ DATABASE_URL: pg-1.url }]'),
    );
    expect(order(steps)).toEqual(['create pg-2', 'change web', 'destroy pg-1']);
    expect(steps[1]).toMatchObject({
      fields: [{ field: 'env.DATABASE_URL', from: 'pg-1.url', to: 'pg-2.url' }],
    });
  });

  it('destroys what links to a source before the source', () => {
    const { steps } = planned(
      `version: 1
services: {}
`,
      [
        savedPostgres(),
        linkedWeb({ DATABASE_URL: { source: 'pg-1', output: 'url' } }),
      ],
      STACK('[{ DATABASE_URL: pg-1.url }]'),
    );
    expect(order(steps)).toEqual(['destroy web', 'destroy pg-1']);
  });
});
