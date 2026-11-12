import {
  generateProjectConfig,
  parseProjectConfig,
  planEnvironment,
} from '../../src/project-config';
import type { DockerSettings } from '../../src/native/docker-native';
import type {
  GeneratorEnvironment,
  ProjectConfig,
  SavedApplicationSettings,
  SavedPostgresSettings,
  SavedRedisSettings,
  SavedService,
  SavedStackVm,
} from '../../src/project-config';

const SCHEMA_URL =
  'https://cloud.example.com/backend/schema/project-config/v1.json';

/** An Application as a console create leaves it, with these settings on top. */
function app(
  configName: string,
  settings: Partial<SavedApplicationSettings> = {},
  env: string[] = [],
  build: { buildArgs?: string[]; buildSecrets?: string[] } = {},
): SavedService {
  return {
    serviceType: 'application',
    serviceId: `app-${configName}-${Math.random()}`,
    name: `App ${configName}`,
    configName,
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
      ...settings,
    },
    variables: {
      env,
      buildArgs: build.buildArgs ?? [],
      buildSecrets: build.buildSecrets ?? [],
    },
  };
}

function pg(
  configName: string,
  settings: Partial<SavedPostgresSettings> = {},
  env: string[] = [],
): SavedService {
  return {
    serviceType: 'postgres',
    serviceId: `pg-${configName}-${Math.random()}`,
    name: `Postgres ${configName}`,
    configName,
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'postgres:18',
      databaseName: 'app',
      databaseUser: 'app',
      ...settings,
    },
    variables: { env },
  };
}

function redis(
  configName: string,
  settings: Partial<SavedRedisSettings> = {},
): SavedService {
  return {
    serviceType: 'redis',
    serviceId: `redis-${configName}-${Math.random()}`,
    name: `Redis ${configName}`,
    configName,
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'redis:8',
      ...settings,
    },
    variables: { env: [] },
  };
}

function mysqlDb(
  configName: string,
  settings: Partial<SavedPostgresSettings> = {},
): SavedService {
  return {
    serviceType: 'mysql',
    serviceId: `mysql-${configName}-${Math.random()}`,
    name: `MySQL ${configName}`,
    configName,
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'mysql:8',
      databaseName: 'app',
      databaseUser: 'app',
      ...settings,
    },
    variables: { env: [] },
  };
}

function other(
  configName: string,
  serviceType: 'mongo' | 'mariadb' | 'libsql',
): SavedService {
  return {
    serviceType,
    serviceId: `${serviceType}-${configName}-${Math.random()}`,
    name: `${serviceType} ${configName}`,
    configName,
  };
}

/** A template's Compose stack: its compose file is kept in Cloudgate. */
function templateStack(configName: string): SavedService {
  return {
    serviceType: 'compose',
    serviceId: `compose-${configName}-${Math.random()}`,
    name: `compose ${configName}`,
    configName,
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
  };
}

function env(
  name: string,
  saved: SavedService[],
  serverId: string | null = null,
): GeneratorEnvironment {
  return {
    name,
    deployTarget: serverId
      ? { kind: 'server', serverId }
      : { kind: 'platform-host' },
    saved,
  };
}

function parsed(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

/**
 * The property: the generated config, stored as a
 * Cloudgate-kept text, plans nothing to change in any Environment.
 */
function expectEmptyPlans(
  text: string,
  environments: readonly GeneratorEnvironment[],
) {
  const config = parsed(text);
  for (const environment of environments) {
    const outcome = planEnvironment({
      config,
      saved: environment.saved,
      deployTarget: environment.deployTarget,
      context: { previous: config },
    });
    expect({ environment: environment.name, outcome }).toMatchObject({
      environment: environment.name,
      outcome: { ok: true, steps: [] },
    });
  }
}

function generate(environments: GeneratorEnvironment[]) {
  const text = generateProjectConfig({ environments, schemaUrl: SCHEMA_URL });
  expectEmptyPlans(text, environments);
  return { text, config: parsed(text) };
}

/** The comment block written directly above a Service's key. */
function commentAbove(text: string, configName: string): string {
  const lines = text.split('\n');
  const at = lines.indexOf(`  ${configName}:`);
  if (at < 0) throw new Error(`${configName} is not in the text`);
  const comments: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i].trim().startsWith('#'); i--) {
    comments.unshift(lines[i].trim().replace(/^# ?/, ''));
  }
  return comments.join(' ');
}

describe('generateProjectConfig', () => {
  it('begins with the schema comment, naming the instance’s own URL', () => {
    const { text, config } = generate([env('production', [])]);

    expect(text.split('\n')[0]).toBe(
      `# yaml-language-server: $schema=${SCHEMA_URL}`,
    );
    expect(config).toEqual({ version: 1, services: {} });
  });

  it('writes no schema comment when the instance has no URL to name', () => {
    const text = generateProjectConfig({
      environments: [env('production', [])],
      schemaUrl: null,
    });

    expect(text).not.toContain('$schema');
    expect(parsed(text)).toEqual({ version: 1, services: {} });
  });

  it('describes a Project spread across Servers whose Environments agree', () => {
    const shop = (extraEnv: string[]) =>
      app(
        'shop',
        {
          description: 'The storefront',
          sourceType: 'github',
          owner: 'acme',
          repository: 'shop',
          buildPath: '/apps/shop',
          buildType: 'dockerfile',
          dockerfile: 'Dockerfile.prod',
          port: 8080,
          command: 'node',
          args: ['server.js'],
          watchPaths: ['apps/shop/**'],
          cpuLimit: '500000000',
          memoryLimit: '1073741824',
        },
        ['DATABASE_URL', ...extraEnv],
        { buildArgs: ['NODE_ENV'] },
      );
    const environments = [
      env(
        'production',
        [
          shop(['SENTRY_DSN']),
          pg('db', { dockerImage: 'postgres:16' }, ['POSTGRES_INITDB_ARGS']),
          redis('cache', {
            cpuLimit: '1500000000',
            memoryLimit: String(768 * 1024 * 1024),
          }),
        ],
        'srv-prod',
      ),
      env(
        'staging',
        [
          shop(['DEBUG']),
          pg('db', { dockerImage: 'postgres:16' }),
          redis('cache', {
            cpuLimit: '1500000000',
            memoryLimit: String(768 * 1024 * 1024),
          }),
        ],
        'srv-staging',
      ),
    ];

    const { config } = generate(environments);

    expect(config.services).toEqual({
      cache: {
        kind: 'redis',
        managed: false,
        dockerImage: 'redis:8',
        size: { cpu: 1.5, memoryMb: 768 },
        env: [],
      },
      db: {
        kind: 'postgres',
        managed: false,
        dockerImage: 'postgres:16',
        databaseName: 'app',
        databaseUser: 'app',
        env: ['POSTGRES_INITDB_ARGS'],
      },
      shop: {
        kind: 'web',
        managed: false,
        description: 'The storefront',
        size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
        command: 'node',
        args: ['server.js'],
        port: 8080,
        source: {
          sourceType: 'github',
          repository: 'acme/shop',
          buildPath: '/apps/shop',
        },
        build: {
          buildType: 'dockerfile',
          dockerfile: 'Dockerfile.prod',
          watchPaths: ['apps/shop/**'],
        },
        // The union across Environments: a name missing in one is a note there.
        env: ['DATABASE_URL', 'SENTRY_DSN', 'DEBUG'],
        buildArgs: ['NODE_ENV'],
        buildSecrets: [],
      },
    });
  });

  describe('wired variables', () => {
    const shop = (extra: Partial<SavedService> = {}, keys = ['NODE_ENV']) =>
      ({
        ...app('shop', { sourceType: 'docker', dockerImage: 'nginx:1' }, keys),
        ...extra,
      }) as SavedService;

    it('never makes a link, even for a typed value a database could give', () => {
      const { text, config } = generate([
        env('production', [shop({}, ['DATABASE_URL']), pg('db')], 'srv-prod'),
      ]);

      expect(config.services.shop).toMatchObject({ env: ['DATABASE_URL'] });
      expect(config.services.shop).not.toHaveProperty('links');
      expect(text).not.toContain('db.url');
    });

    it('writes back the links a Service has applied, so its plan changes nothing', () => {
      const linked = shop({
        links: { DATABASE_URL: { source: 'db', output: 'url' } },
      });
      // `generate` checks every Environment's plan is empty.
      const { text, config } = generate([
        env('production', [linked, pg('db')], 'srv-prod'),
      ]);

      expect(config.services.shop).toMatchObject({
        env: ['NODE_ENV'],
        links: { DATABASE_URL: { source: 'db', output: 'url' } },
      });
      expect(text).toContain('DATABASE_URL: db.url');
    });
  });

  it('describes a static site, an image and a custom git URL without a credential', () => {
    const environments = [
      env('production', [
        app('docs', {
          configKind: 'static',
          buildType: 'static',
          sourceType: 'gitea',
          giteaOwner: 'acme',
          giteaRepository: 'docs',
          publishDirectory: 'dist',
          isStaticSpa: true,
        }),
        app('proxy', { sourceType: 'docker', dockerImage: 'nginx:1.27' }),
        app('tool', {
          sourceType: 'git',
          customGitUrl: 'git@git.example.com:acme/tool.git',
          customGitBuildPath: '/',
        }),
      ]),
    ];

    const { config } = generate(environments);

    expect(config.services.docs).toMatchObject({
      kind: 'static',
      source: { sourceType: 'gitea', repository: 'acme/docs' },
      build: { publishDirectory: 'dist', isStaticSpa: true },
    });
    expect(config.services.proxy).toMatchObject({
      kind: 'web',
      source: { sourceType: 'docker', dockerImage: 'nginx:1.27' },
    });
    expect(config.services.tool).toMatchObject({
      kind: 'web',
      source: {
        sourceType: 'git',
        customGitUrl: 'git@git.example.com:acme/tool.git',
      },
    });
  });

  describe('the recorded kind', () => {
    it('writes each Application as its recorded kind, and plans nothing to change', () => {
      const environments = [
        env('production', [
          app('site', {
            configKind: 'static',
            buildType: 'static',
            sourceType: 'github',
            owner: 'acme',
            repository: 'site',
          }),
          app('api', {
            configKind: 'web',
            sourceType: 'github',
            owner: 'acme',
            repository: 'api',
          }),
        ]),
      ];
      const { config } = generate(environments);

      expect(config.services.site).toMatchObject({ kind: 'static' });
      expect(config.services.api).toMatchObject({ kind: 'web' });
    });

    it('keeps an Application with no Domain a web, with no note suggesting another kind', () => {
      // A SavedService carries no Domains at all: whether it has one is never
      // what decides its kind.
      const environments = [
        env('production', [
          app('queue', {
            sourceType: 'github',
            owner: 'acme',
            repository: 'queue',
          }),
        ]),
      ];
      const { text, config } = generate(environments);

      expect(config.services.queue).toMatchObject({ kind: 'web' });
      const outcome = planEnvironment({
        config,
        saved: environments[0].saved,
        deployTarget: environments[0].deployTarget,
        context: { previous: config },
      });
      expect(outcome).toEqual({ ok: true, steps: [], notes: [] });
      expect(text).not.toMatch(/worker|web-private|cron/);
    });

    it('writes a web-private with its port always, even at the default, and plans nothing to change', () => {
      const environments = [
        env('production', [
          app('api', {
            configKind: 'web-private',
            sourceType: 'github',
            owner: 'acme',
            repository: 'api',
          }),
        ]),
      ];
      const { config } = generate(environments);

      expect(config.services.api).toMatchObject({
        kind: 'web-private',
        port: 3000,
        build: { buildType: 'nixpacks' },
      });
    });

    it('writes a worker with its build type and never a port, and plans nothing to change', () => {
      const environments = [
        env('production', [
          app('jobs', {
            configKind: 'worker',
            sourceType: 'github',
            owner: 'acme',
            repository: 'jobs',
            command: 'node',
            args: ['worker.js'],
            port: 8080,
          }),
        ]),
        env('staging', [
          app('jobs', {
            configKind: 'worker',
            sourceType: 'github',
            owner: 'acme',
            repository: 'jobs',
            command: 'node',
            args: ['worker.js'],
          }),
        ]),
      ];
      const { text, config } = generate(environments);

      expect(config.services.jobs).toMatchObject({
        kind: 'worker',
        command: 'node',
        args: ['worker.js'],
        build: { buildType: 'nixpacks' },
      });
      expect(config.services.jobs).not.toHaveProperty('port');
      expect(text).not.toMatch(/port:/);
    });
  });

  describe('a Cron service', () => {
    const report = (settings: Partial<SavedApplicationSettings> = {}) =>
      app('report', {
        configKind: 'cron',
        sourceType: 'github',
        owner: 'acme',
        repository: 'reports',
        command: 'node dist/report.js',
        cronSchedule: '0 3 * * MON-FRI',
        cronTimezone: 'UTC',
        cronTimeoutSeconds: 3600,
        ...settings,
      });

    it('describes it with its command and schedule, leaving out a default timezone and timeout', () => {
      const { text, config } = generate([
        env('production', [report()]),
        env('staging', [report()]),
      ]);

      expect(config.services.report).toEqual({
        kind: 'cron',
        managed: false,
        command: 'node dist/report.js',
        schedule: '0 3 * * MON-FRI',
        source: { sourceType: 'github', repository: 'acme/reports' },
        env: [],
        buildArgs: [],
        buildSecrets: [],
      });
      expect(text).not.toMatch(/^\s*(timezone|timeout|port):/m);
    });

    it('writes a timezone and timeout that are not the defaults', () => {
      const { config } = generate([
        env('production', [
          report({ cronTimezone: 'Europe/Berlin', cronTimeoutSeconds: 5400 }),
        ]),
      ]);

      expect(config.services.report).toMatchObject({
        timezone: 'Europe/Berlin',
        timeoutSeconds: 5400,
      });
    });

    it('lists a Cron service whose Environments disagree on its schedule', () => {
      const { config } = generate([
        env('production', [report()]),
        env('staging', [report({ cronSchedule: '*/5 * * * *' })]),
      ]);

      expect(config.services.report).toEqual({
        kind: 'cron',
        managed: 'console',
      });
    });

    it('plans nothing for a Project with a Cron service beside a web', () => {
      generate([
        env('production', [
          report(),
          app('site', {
            sourceType: 'github',
            owner: 'acme',
            repository: 'site',
          }),
        ]),
      ]);
    });
  });

  describe('sizes', () => {
    it('writes a matching size name, otherwise a custom pair', () => {
      const { config } = generate([
        env('production', [
          pg('named', { cpuLimit: '2000000000', memoryLimit: '4294967296' }),
          pg('pair', {
            cpuLimit: '750000000',
            memoryLimit: String(3 * 1024 * 1024 * 1024),
          }),
        ]),
      ]);

      expect(config.services.named).toMatchObject({
        size: { name: 'large', cpu: 2, memoryMb: 4096 },
      });
      expect(config.services.pair).toMatchObject({
        size: { cpu: 0.75, memoryMb: 3072 },
      });
    });

    it('writes no size for no caps or a cap only on one side', () => {
      const { text, config } = generate([
        env('production', [
          pg('uncapped'),
          pg('cpu-only', { cpuLimit: '1000000000' }),
        ]),
        env('staging', [
          pg('uncapped'),
          pg('cpu-only', { cpuLimit: '1000000000' }),
        ]),
      ]);

      for (const name of ['uncapped', 'cpu-only']) {
        expect(config.services[name]).toMatchObject({ kind: 'postgres' });
        expect(config.services[name]).not.toHaveProperty('size');
      }
      expect(commentAbove(text, 'cpu-only')).toMatch(
        /cannot be written as a size/,
      );
      expect(commentAbove(text, 'uncapped')).toBe('');
    });
  });

  describe('managed: console, with a comment saying why', () => {
    /**
     * A console-made stack in a Cloud Environment (#1372): the plan makes
     * its Stack VM, and once made moves it by its console setting and
     * Cloudgate's pins (#1368). Those steps are the console's, not a field
     * the config describes, so they never demote nor fail the generation.
     */
    describe('a console-made stack on its Stack VM', () => {
      const IN_CLOUD = {
        kind: 'cloud' as const,
        cloudAccountId: 'ca-1',
        region: 'eu-west-1',
      };
      function onStackVm(over: Partial<SavedStackVm>): SavedService {
        return {
          ...(templateStack('stack') as Extract<
            SavedService,
            { serviceType: 'compose' }
          >),
          stackVm: {
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
          },
        };
      }
      function onlyStackVmSteps(
        text: string,
        environment: GeneratorEnvironment,
      ) {
        const config = parsed(text);
        const outcome = planEnvironment({
          config,
          saved: environment.saved,
          deployTarget: environment.deployTarget,
          context: { previous: config },
        });
        if (!outcome.ok) throw new Error('refused');
        const steps = outcome.steps.filter(
          (step) => !step.action.startsWith('network-'),
        );
        expect(steps.length).toBeGreaterThan(0);
        for (const step of steps) {
          expect(step).toMatchObject({ configName: 'stack', fields: [] });
          expect('stackVm' in step && step.stackVm).toBeTruthy();
        }
        return config;
      }

      it.each([
        ['not made yet, which the plan makes', onStackVm({})],
        [
          'made, and resized by its console setting',
          onStackVm({ made: true, consoleSize: 'large' }),
        ],
        [
          'made at pins Cloudgate has moved past, which the plan replaces',
          onStackVm({
            made: true,
            pins: {
              image: 'ami-0old',
              dockerEngine: '1.0.0',
              composePlugin: '1.0.0',
            },
          }),
        ],
      ])('lists one %s', (_what, stack) => {
        const environment: GeneratorEnvironment = {
          name: 'production',
          deployTarget: IN_CLOUD,
          saved: [stack],
        };
        const text = generateProjectConfig({
          environments: [environment],
          schemaUrl: SCHEMA_URL,
        });

        const config = onlyStackVmSteps(text, environment);
        expect(config.services).toEqual({
          stack: { kind: 'compose', managed: 'console' },
        });
      });
    });

    it('lists a kind version 1 cannot describe', () => {
      const environments = [
        env('production', [other('docs', 'mongo'), templateStack('stack')]),
        env('staging', [other('docs', 'mongo'), templateStack('stack')]),
      ];
      const { text, config } = generate(environments);

      expect(config.services).toEqual({
        docs: { kind: 'mongo', managed: 'console' },
        stack: { kind: 'compose', managed: 'console' },
      });
      expect(commentAbove(text, 'docs')).toMatch(/cannot describe a mongo/);
    });

    it('keeps a MySQL console-managed with its comment as it was, though mysql can be described', () => {
      const environments = [
        env('production', [mysqlDb('shop-db'), other('maria', 'mariadb')]),
        env('staging', [mysqlDb('shop-db'), other('maria', 'mariadb')]),
      ];
      const { text, config } = generate(environments);

      expect(config.services).toEqual({
        maria: { kind: 'mariadb', managed: 'console' },
        'shop-db': { kind: 'mysql', managed: 'console' },
      });
      expect(commentAbove(text, 'shop-db')).toBe(
        'Version 1 cannot describe a mysql Service, so the console keeps it.',
      );
    });

    it('describes a MySQL the stored config already describes, its database and user included', () => {
      const environments = [
        env('production', [
          mysqlDb('shop-db', { databaseName: 'legacy', databaseUser: 'root' }),
        ]),
      ];
      const text = generateProjectConfig({
        environments,
        schemaUrl: SCHEMA_URL,
        described: new Set(['shop-db']),
      });
      expectEmptyPlans(text, environments);

      expect(parsed(text).services['shop-db']).toMatchObject({
        kind: 'mysql',
        managed: false,
        dockerImage: 'mysql:8',
        databaseName: 'legacy',
        databaseUser: 'root',
      });
      expect(text).not.toMatch(/cannot describe/);
    });

    it('plans nothing for a Project with a console-managed MySQL but the note that it can now be described', () => {
      const environments = [env('production', [mysqlDb('shop-db')])];
      const { config } = generate(environments);

      expect(
        planEnvironment({
          config,
          saved: environments[0].saved,
          deployTarget: environments[0].deployTarget,
          context: { previous: config },
        }),
      ).toEqual({
        ok: true,
        steps: [],
        notes: [
          {
            kind: 'mysql-can-be-described',
            configName: 'shop-db',
            message:
              'shop-db: mysql can now be described; remove managed: console to hand it to the config',
          },
        ],
      });
    });

    it('lists a Service that exists in only some Environments', () => {
      const environments = [
        env('production', [
          app('worker', { sourceType: 'docker', dockerImage: 'acme/w:1' }),
        ]),
        env('staging', []),
      ];
      const { text, config } = generate(environments);

      expect(config.services.worker).toEqual({
        kind: 'web',
        managed: 'console',
      });
      expect(commentAbove(text, 'worker')).toMatch(
        /only in the production Environment/,
      );
    });

    it('lists a Service whose Environments disagree on a config-owned field, naming the field', () => {
      const environments = [
        env('production', [app('api', { dockerfile: 'Dockerfile' })]),
        env('staging', [app('api', { dockerfile: 'Dockerfile.dev' })]),
      ];
      const { text, config } = generate(environments);

      expect(config.services.api).toEqual({ kind: 'web', managed: 'console' });
      expect(commentAbove(text, 'api')).toMatch(
        /disagree on build\.dockerfile/,
      );
      expect(text).not.toContain('Dockerfile.dev');
    });

    it('lists a Service whose Environments disagree on its size, or on a postgres database or user', () => {
      const { text, config } = generate([
        env('production', [
          pg('sized', { cpuLimit: '1000000000', memoryLimit: '2147483648' }),
          pg('named', { databaseName: 'shop_prod' }),
          pg('user', { databaseUser: 'prod' }),
        ]),
        env('staging', [
          pg('sized', { cpuLimit: '500000000', memoryLimit: '1073741824' }),
          pg('named', { databaseName: 'shop_staging' }),
          pg('user', { databaseUser: 'staging' }),
        ]),
      ]);

      expect(config.services).toEqual({
        named: { kind: 'postgres', managed: 'console' },
        sized: { kind: 'postgres', managed: 'console' },
        user: { kind: 'postgres', managed: 'console' },
      });
      expect(commentAbove(text, 'sized')).toMatch(/disagree on size/);
      expect(commentAbove(text, 'named')).toMatch(/disagree on database/);
      expect(commentAbove(text, 'user')).toMatch(/disagree on user/);
    });

    it('lists a postgres whose user PostgreSQL reserves, since the config refuses that user:', () => {
      const { text, config } = generate([
        env('production', [pg('pg-1', { databaseUser: 'pg_1' })]),
      ]);

      expect(config.services['pg-1']).toEqual({
        kind: 'postgres',
        managed: 'console',
      });
      expect(commentAbove(text, 'pg-1')).toMatch(/pg_1.*reserves/);
    });

    it('lists a Service whose Environments disagree on its kind', () => {
      const environments = [
        env('production', [pg('store')]),
        env('staging', [redis('store')]),
      ];
      const { text, config } = generate(environments);

      expect(config.services.store).toMatchObject({ managed: 'console' });
      expect(commentAbove(text, 'store')).toMatch(/disagree on its kind/);
    });

    it('lists a Service whose git URL carries a credential, and never copies the URL', () => {
      const environments = [
        env('production', [
          app('legacy', {
            sourceType: 'git',
            customGitUrl: 'https://deploy:s3cr3t-token@git.example.com/a/b.git',
          }),
        ]),
      ];
      const { text, config } = generate(environments);

      expect(config.services.legacy).toEqual({
        kind: 'web',
        managed: 'console',
      });
      expect(commentAbove(text, 'legacy')).toMatch(/carries a credential/);
      expect(text).not.toContain('s3cr3t-token');
      expect(text).not.toContain('git.example.com');
    });

    it('lists a Service whose source or settings version 1 cannot write', () => {
      const environments = [
        env('production', [
          app('upload', { sourceType: 'drop' }),
          app('static-image', {
            configKind: 'static',
            buildType: 'static',
            sourceType: 'docker',
            dockerImage: 'nginx:1',
          }),
          pg('postgis', { dockerImage: 'postgis/postgis:16' }),
        ]),
      ];
      const { text, config } = generate(environments);

      expect(config.services).toEqual({
        upload: { kind: 'web', managed: 'console' },
        'static-image': { kind: 'static', managed: 'console' },
        postgis: { kind: 'postgres', managed: 'console' },
      });
      expect(commentAbove(text, 'upload')).toMatch(/source/);
      expect(commentAbove(text, 'postgis')).toMatch(/image/);
    });
  });

  describe('the seven Swarm settings in native.docker', () => {
    const SECOND = 1_000_000_000;
    const healthCheck = {
      Test: ['CMD-SHELL', 'curl -f http://localhost:3000/health'],
      Interval: 10 * SECOND,
      Retries: 5,
    };
    const withDocker = (
      service: SavedService,
      docker: DockerSettings,
    ): SavedService => ({ ...service, docker });

    it('writes a health check every Environment stores under native.docker, in Docker’s spelling', () => {
      const { text, config } = generate([
        env(
          'production',
          [withDocker(app('api'), { HealthCheck: healthCheck })],
          'srv-1',
        ),
        env(
          'staging',
          [withDocker(app('api'), { HealthCheck: healthCheck })],
          'srv-2',
        ),
      ]);

      expect(config.services.api).toMatchObject({
        kind: 'web',
        native: { docker: { HealthCheck: healthCheck } },
      });
      expect(text).toContain(
        '    native:\n      docker:\n        HealthCheck:',
      );
    });

    it('writes only what differs from the kind’s defaults, field by field', () => {
      const docker: DockerSettings = {
        UpdateConfig: {
          Parallelism: 2,
          Order: 'start-first',
          FailureAction: 'rollback',
        },
        Labels: { team: 'checkout' },
      };
      const { config } = generate([
        env('production', [withDocker(app('api'), docker)], 'srv-1'),
        env('staging', [withDocker(app('api'), docker)], 'srv-2'),
      ]);

      expect(config.services.api).toMatchObject({
        native: {
          docker: {
            Labels: { team: 'checkout' },
            UpdateConfig: { Parallelism: 2 },
          },
        },
      });
      const written = (
        config.services.api as { native?: { docker?: DockerSettings } }
      ).native?.docker;
      expect(written?.UpdateConfig).toEqual({ Parallelism: 2 });
    });

    it('lists a Service whose Environments store different restart policies managed: console, naming RestartPolicy', () => {
      const { text, config } = generate([
        env(
          'production',
          [
            withDocker(app('api'), {
              RestartPolicy: { Condition: 'on-failure', MaxAttempts: 3 },
            }),
          ],
          'srv-1',
        ),
        env(
          'staging',
          [withDocker(app('api'), { RestartPolicy: { Condition: 'any' } })],
          'srv-2',
        ),
      ]);

      expect(config.services.api).toEqual({ kind: 'web', managed: 'console' });
      expect(commentAbove(text, 'api')).toMatch(
        /disagree on its Swarm setting RestartPolicy/,
      );
      expect(text).not.toContain('on-failure');
    });

    it('lists a Service one Environment sets a Swarm setting on and another leaves at the default', () => {
      const { text, config } = generate([
        env(
          'production',
          [withDocker(app('api'), { HealthCheck: healthCheck })],
          'srv-1',
        ),
        env('staging', [app('api')], 'srv-2'),
      ]);

      expect(config.services.api).toEqual({ kind: 'web', managed: 'console' });
      expect(commentAbove(text, 'api')).toMatch(/HealthCheck/);
    });

    it('writes no native block for stored settings that are only the kind’s defaults', () => {
      const appDefaults: DockerSettings = {
        UpdateConfig: {
          Parallelism: 1,
          Order: 'start-first',
          FailureAction: 'rollback',
        },
        RollbackConfig: { Parallelism: 1, Order: 'start-first' },
        Labels: {},
        Ulimits: [],
      };
      const dbDefaults: DockerSettings = {
        UpdateConfig: {
          Parallelism: 1,
          Order: 'stop-first',
          FailureAction: 'rollback',
        },
        RollbackConfig: { Parallelism: 1, Order: 'stop-first' },
        StopGracePeriod: 30 * SECOND,
      };
      const { text, config } = generate([
        env(
          'production',
          [
            withDocker(app('api'), appDefaults),
            withDocker(pg('db'), dbDefaults),
          ],
          'srv-1',
        ),
        env('staging', [app('api'), withDocker(pg('db'), dbDefaults)], 'srv-2'),
      ]);

      expect(config.services.api).not.toHaveProperty('native');
      expect(config.services.db).not.toHaveProperty('native');
      expect(config.services.db).toMatchObject({
        kind: 'postgres',
        managed: false,
      });
      expect(text).not.toContain('native');
    });

    it('lists a database stored start-first managed: console, with the lock’s reason, rather than writing a refused value', () => {
      const docker: DockerSettings = {
        UpdateConfig: { Parallelism: 1, Order: 'start-first' },
      };
      const { text, config } = generate([
        env('production', [withDocker(pg('db'), docker)], 'srv-1'),
      ]);

      expect(config.services.db).toEqual({
        kind: 'postgres',
        managed: 'console',
      });
      expect(commentAbove(text, 'db')).toMatch(
        /native\.docker\.UpdateConfig\.Order "start-first": refused - A database updates and rolls back stop-first/,
      );
    });

    /** A cron takes Labels, StopGracePeriod and Ulimits alone. */
    it('writes a Cron service’s open keys only, leaving out a stored key a cron refuses', () => {
      const cron = withDocker(
        app('report', {
          configKind: 'cron',
          sourceType: 'github',
          owner: 'acme',
          repository: 'reports',
          command: 'node dist/report.js',
          cronSchedule: '0 3 * * MON-FRI',
          cronTimezone: 'UTC',
          cronTimeoutSeconds: 3600,
        }),
        {
          Labels: { team: 'billing' },
          StopGracePeriod: 20 * SECOND,
          HealthCheck: healthCheck,
          RestartPolicy: { Condition: 'any' },
        },
      );
      const { text, config } = generate([env('production', [cron], 'srv-1')]);

      expect(
        (config.services.report as { native?: { docker?: DockerSettings } })
          .native?.docker,
      ).toEqual({ Labels: { team: 'billing' }, StopGracePeriod: 20 * SECOND });
      expect(text).not.toMatch(/HealthCheck|RestartPolicy/);
    });

    /** A Server bucket's Garage takes Labels alone. */
    it('writes a Server bucket’s Garage labels under native.docker, and nothing else', () => {
      const bucket = (labels: Record<string, string>): SavedService => ({
        serviceType: 'bucket',
        serviceId: 'bucket-files',
        name: 'files',
        configName: 'files',
        docker: { Labels: labels, StopGracePeriod: 5 * SECOND },
        settings: { description: null, bucketName: 'files-a1b2c3d4' },
        variables: { env: [] },
      });
      const { config } = generate([
        env('production', [bucket({ team: 'media' })], 'srv-1'),
        env('staging', [bucket({ team: 'media' })], 'srv-2'),
      ]);

      expect(config.services.files).toMatchObject({
        kind: 'bucket',
        native: { docker: { Labels: { team: 'media' } } },
      });
      expect(
        (config.services.files as { native?: { docker?: DockerSettings } })
          .native?.docker,
      ).toEqual({ Labels: { team: 'media' } });
    });

    it('lists a Server bucket whose Environments store different Garage labels managed: console, naming Labels', () => {
      const bucket = (team: string): SavedService => ({
        serviceType: 'bucket',
        serviceId: `bucket-files-${team}`,
        name: 'files',
        configName: 'files',
        docker: { Labels: { team } },
        settings: { description: null, bucketName: 'files-a1b2c3d4' },
        variables: { env: [] },
      });
      const { text, config } = generate([
        env('production', [bucket('media')], 'srv-1'),
        env('staging', [bucket('other')], 'srv-2'),
      ]);

      expect(config.services.files).toEqual({
        kind: 'bucket',
        managed: 'console',
      });
      expect(commentAbove(text, 'files')).toMatch(
        /disagree on its Swarm setting Labels/,
      );
    });
  });

  it('hands a demoted expressible Service to the config once managed: console is removed, and the plan shows what that changes', () => {
    const environments = [
      env('production', [app('api', { dockerfile: 'Dockerfile' })]),
      env('staging', [app('api', { dockerfile: 'Dockerfile.dev' })]),
    ];
    const text = generateProjectConfig({ environments, schemaUrl: null });
    const previous = parsed(text);
    const handed = parsed('version: 1\nservices:\n  api:\n    kind: web\n');

    const staging = planEnvironment({
      config: handed,
      saved: environments[1].saved,
      deployTarget: environments[1].deployTarget,
      context: { previous },
    });
    const production = planEnvironment({
      config: handed,
      saved: environments[0].saved,
      deployTarget: environments[0].deployTarget,
      context: { previous },
    });

    expect(staging).toMatchObject({
      ok: true,
      steps: [
        {
          action: 'change',
          configName: 'api',
          fields: [
            {
              field: 'build.dockerfile',
              from: 'Dockerfile.dev',
              to: 'Dockerfile',
            },
          ],
        },
      ],
    });
    expect(production).toMatchObject({ ok: true, steps: [] });
  });

  it('plans nothing for a Project mixing every case at once', () => {
    const environments = [
      env(
        'production',
        [
          app('web', { sourceType: 'github', owner: 'a', repository: 'b' }, [
            'A',
          ]),
          app('api', { dockerfile: 'Dockerfile' }),
          app('only-prod', { sourceType: 'docker', dockerImage: 'x:1' }),
          app('legacy', {
            sourceType: 'git',
            customGitUrl: 'https://u:p@h.example/r.git',
          }),
          pg('db', { databaseUser: 'prod' }),
          mysqlDb('orders'),
          other('docs', 'mongo'),
          other('kv', 'libsql'),
        ],
        'srv-1',
      ),
      env(
        'staging',
        [
          app('web', { sourceType: 'github', owner: 'a', repository: 'b' }, [
            'B',
          ]),
          app('api', { dockerfile: 'Dockerfile.dev' }),
          app('legacy', {
            sourceType: 'git',
            customGitUrl: 'https://u:p@h.example/r.git',
          }),
          pg('db', { databaseUser: 'staging' }),
          mysqlDb('orders', { databaseUser: 'root' }),
          other('docs', 'mongo'),
        ],
        'srv-2',
      ),
      env('preview', [], null),
    ];

    const { config } = generate(environments);

    expect(Object.keys(config.services).sort()).toEqual([
      'api',
      'db',
      'docs',
      'kv',
      'legacy',
      'only-prod',
      'orders',
      'web',
    ]);
  });
});
