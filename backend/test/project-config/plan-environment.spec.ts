import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import { kindsOn } from '../../src/project-config/planner/plan-environment';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  PlanStep,
  ProjectConfig,
  SavedApplicationSettings,
  SavedService,
} from '../../src/project-config';

const PLATFORM: DeployTarget = { kind: 'platform-host' };

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

/** An Application as a console create leaves it, with these settings on top. */
function savedApp(
  configName: string,
  settings: Partial<SavedApplicationSettings> = {},
  variables: {
    env?: string[];
    buildArgs?: string[];
    buildSecrets?: string[];
  } = {},
): SavedService {
  return {
    serviceType: 'application',
    serviceId: `app-${configName}`,
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
      env: variables.env ?? [],
      buildArgs: variables.buildArgs ?? [],
      buildSecrets: variables.buildSecrets ?? [],
    },
  };
}

function savedPostgres(
  configName: string,
  settings: Partial<{
    dockerImage: string;
    databaseName: string;
    databaseUser: string;
    cpuLimit: string | null;
    memoryLimit: string | null;
  }> = {},
  env: string[] = [],
): SavedService {
  return {
    serviceType: 'postgres',
    serviceId: `pg-${configName}`,
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

function savedMysql(
  configName: string,
  settings: Partial<{
    dockerImage: string;
    databaseName: string;
    databaseUser: string;
    cpuLimit: string | null;
    memoryLimit: string | null;
  }> = {},
  env: string[] = [],
): SavedService {
  return {
    serviceType: 'mysql',
    serviceId: `mysql-${configName}`,
    name: `MySQL ${configName}`,
    configName,
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'mysql:8.4',
      databaseName: 'app',
      databaseUser: 'app',
      ...settings,
    },
    variables: { env },
  };
}

function savedMongo(configName: string): SavedService {
  return {
    serviceType: 'mongo',
    serviceId: `mongo-${configName}`,
    name: `Mongo ${configName}`,
    configName,
  };
}

function plan(
  text: string,
  saved: SavedService[] = [],
  options: {
    previous?: string;
    deployTarget?: DeployTarget;
    networks?: PlanInput['networks'];
    cloudReads?: PlanInput['cloudReads'];
  } = {},
): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved,
    deployTarget: options.deployTarget ?? PLATFORM,
    context: {
      previous:
        options.previous === undefined ? null : config(options.previous),
    },
    networks: options.networks,
    cloudReads: options.cloudReads,
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

function refusedAt(...args: Parameters<typeof plan>) {
  const outcome = plan(...args);
  if (outcome.ok) throw new Error('planned, but a refusal was expected');
  return outcome.refusals.map((refusal) => refusal.at);
}

const actions = (steps: readonly PlanStep[]) =>
  steps.map((step) =>
    step.action === 'network-create' ||
    step.action === 'network-change' ||
    step.action === 'network-remove'
      ? `${step.action} ${step.region}`
      : `${step.action} ${step.configName}`,
  );

describe('planEnvironment', () => {
  it('has nothing to change for an empty config and an empty Environment', () => {
    expect(planned('version: 1\nservices: {}\n')).toEqual({
      ok: true,
      steps: [],
      notes: [],
    });
  });

  it('creates a listed Service the Environment does not have, on its Deploy target', () => {
    const target: DeployTarget = { kind: 'server', serverId: 'srv-1' };
    const { steps } = planned(
      `version: 1
services:
  web:
    kind: web
    port: 8080
    source: { github: acme/shop }
`,
      [],
      { deployTarget: target },
    );

    expect(steps).toEqual([
      {
        action: 'create',
        configName: 'web',
        kind: 'web',
        placement: target,
        fields: [
          { field: 'port', from: null, to: 8080 },
          {
            field: 'source',
            from: null,
            to: { github: 'acme/shop', path: '/' },
          },
        ],
      },
    ]);
  });

  describe('a Service the Environment already has', () => {
    const shop = savedApp('web', {
      sourceType: 'github',
      owner: 'acme',
      repository: 'shop',
      cpuLimit: '500000000',
      memoryLimit: '1073741824',
    });
    const SHOP = `version: 1
services:
  web:
    kind: web
    size: small
    source: { github: acme/shop }
`;

    it('has nothing to change when the saved settings say what the config says', () => {
      expect(planned(SHOP, [shop])).toEqual({ ok: true, steps: [], notes: [] });
    });

    it('matches by Config name and never by display name', () => {
      const renamed = { ...shop, name: 'Storefront (renamed in the console)' };
      expect(planned(SHOP, [renamed]).steps).toEqual([]);
    });

    it('lists each config-owned field that differs, as the config names it', () => {
      const { steps } = planned(
        `version: 1
services:
  web:
    kind: web
    size: { cpu: 1, memory: 1 GB }
    port: 8080
    command: node server.js
    source: { github: acme/shop, path: /api }
    build: { type: dockerfile, dockerfile: api.Dockerfile }
`,
        [shop],
      );

      expect(steps).toEqual([
        {
          action: 'change',
          configName: 'web',
          kind: 'web',
          serviceType: 'application',
          serviceId: 'app-web',
          name: 'App web',
          fields: [
            { field: 'size', from: 'small', to: { cpu: 1, memory: '1 GB' } },
            { field: 'command', from: null, to: 'node server.js' },
            { field: 'port', from: 3000, to: 8080 },
            {
              field: 'source',
              from: { github: 'acme/shop', path: '/' },
              to: { github: 'acme/shop', path: '/api' },
            },
            { field: 'build.type', from: 'nixpacks', to: 'dockerfile' },
            {
              field: 'build.dockerfile',
              from: 'Dockerfile',
              to: 'api.Dockerfile',
            },
          ],
        },
      ]);
    });

    it('leaves the caps alone when the config names no size', () => {
      const text = SHOP.replace('    size: small\n', '');
      expect(planned(text, [shop]).steps).toEqual([]);
    });

    it('reads a custom pair equal to a named size as that size', () => {
      const text = SHOP.replace('small', '{ cpu: 0.5, memory: 1024 MB }');
      expect(planned(text, [shop]).steps).toEqual([]);
    });

    it('compares a field the config leaves out with what a console create leaves it at', () => {
      const custom = savedApp('web', {
        owner: 'acme',
        repository: 'shop',
        dockerfile: 'Custom.Dockerfile',
        description: 'The shop',
      });
      const text = SHOP.replace('    size: small\n', '');

      expect(planned(text, [custom]).steps).toMatchObject([
        {
          action: 'change',
          fields: [
            { field: 'description', from: 'The shop', to: null },
            {
              field: 'build.dockerfile',
              from: 'Custom.Dockerfile',
              to: 'Dockerfile',
            },
          ],
        },
      ]);
    });

    it('destroys and creates on a kind change, under the same Config name', () => {
      const { steps } = planned(SHOP.replace('kind: web', 'kind: static'), [
        shop,
      ]);

      expect(actions(steps)).toEqual(['destroy web', 'create web']);
      expect(steps[0]).toEqual({
        action: 'destroy',
        configName: 'web',
        kind: 'web',
        serviceType: 'application',
        serviceId: 'app-web',
        name: 'App web',
      });
    });

    it('destroys and creates on a kind change matched against the recorded kind', () => {
      const site = savedApp('web', {
        configKind: 'static',
        buildType: 'static',
        owner: 'acme',
        repository: 'shop',
      });
      const { steps } = planned(SHOP, [site]);

      expect(actions(steps)).toEqual(['destroy web', 'create web']);
      expect(steps[0]).toMatchObject({ action: 'destroy', kind: 'static' });
    });

    it('reads an Application by its recorded kind, never by its build type', () => {
      // A nixpacks build: this used to be a `web` by inference.
      const jobs = savedApp('web', {
        configKind: 'worker',
        owner: 'acme',
        repository: 'shop',
      });
      const { steps } = planned(SHOP, [jobs]);

      expect(actions(steps)).toEqual(['destroy web', 'create web']);
      expect(steps[0]).toMatchObject({ action: 'destroy', kind: 'worker' });
    });

    it('destroys and creates on a rename in the config', () => {
      const { steps } = planned(
        SHOP.replace('  web:', '  storefront:'),
        [shop],
        {
          previous: SHOP,
        },
      );

      expect(actions(steps)).toEqual(['create storefront', 'destroy web']);
    });

    it('orders steps creates, then changes, then destroys', () => {
      const text = `${SHOP}    port: 4000\n  cache:\n    kind: redis\n`;
      const { steps } = planned(text, [savedPostgres('db'), shop], {
        previous: `${SHOP}  db:\n    kind: postgres\n`,
      });

      expect(actions(steps)).toEqual([
        'create cache',
        'change web',
        'destroy db',
      ]);
    });
  });

  describe('web-private', () => {
    const API = `version: 1
services:
  api:
    kind: web-private
    port: 4000
    source: { github: acme/api }
`;
    const savedApi = (settings: Partial<SavedApplicationSettings> = {}) =>
      savedApp('api', {
        configKind: 'web-private',
        port: 4000,
        owner: 'acme',
        repository: 'api',
        ...settings,
      });

    it('creates one with its port and fields, as a web is created', () => {
      const target: DeployTarget = { kind: 'server', serverId: 'srv-1' };
      const { steps } = planned(API, [], { deployTarget: target });

      expect(steps).toEqual([
        {
          action: 'create',
          configName: 'api',
          kind: 'web-private',
          placement: target,
          fields: [
            { field: 'port', from: null, to: 4000 },
            {
              field: 'source',
              from: null,
              to: { github: 'acme/api', path: '/' },
            },
          ],
        },
      ]);
    });

    it('has nothing to change when the saved settings say what the config says', () => {
      expect(planned(API, [savedApi()]).steps).toEqual([]);
    });

    it('changes the port and the build fields as a web does', () => {
      const { steps } = planned(
        API.replace(
          'port: 4000',
          'port: 5000\n    build: { type: dockerfile }',
        ),
        [savedApi()],
      );

      expect(steps).toEqual([
        expect.objectContaining({
          action: 'change',
          kind: 'web-private',
          fields: [
            { field: 'port', from: 4000, to: 5000 },
            { field: 'build.type', from: 'nixpacks', to: 'dockerfile' },
          ],
        }),
      ]);
    });

    it.each([
      ['web', 'web-private'],
      ['web-private', 'web'],
    ] as const)(
      'destroys and creates on a change from %s to %s',
      (from, to) => {
        const { steps } = planned(API.replace('web-private', to), [
          savedApi({ configKind: from }),
        ]);

        expect(actions(steps)).toEqual(['destroy api', 'create api']);
        expect(steps[1]).toMatchObject({ action: 'create', kind: to });
        expect(steps[0]).toMatchObject({ action: 'destroy', kind: from });
      },
    );
  });

  describe('a worker', () => {
    const JOBS = `version: 1
services:
  jobs:
    kind: worker
    command: node
    args: [worker.js]
    source: { github: acme/jobs }
`;
    const settings: Partial<SavedApplicationSettings> = {
      configKind: 'worker',
      command: 'node',
      args: ['worker.js'],
      owner: 'acme',
      repository: 'jobs',
    };
    const jobs = savedApp('jobs', settings);

    it('creates a worker with its fields and no port', () => {
      const target: DeployTarget = { kind: 'server', serverId: 'srv-1' };
      const { steps } = planned(JOBS, [], { deployTarget: target });

      expect(steps).toEqual([
        {
          action: 'create',
          configName: 'jobs',
          kind: 'worker',
          placement: target,
          fields: [
            { field: 'command', from: null, to: 'node' },
            { field: 'args', from: null, to: ['worker.js'] },
            {
              field: 'source',
              from: null,
              to: { github: 'acme/jobs', path: '/' },
            },
          ],
        },
      ]);
    });

    it('has nothing to change for a saved worker, whatever its port column holds', () => {
      expect(planned(JOBS, [jobs])).toEqual({
        ok: true,
        steps: [],
        notes: [],
      });
      const onOtherPort = savedApp('jobs', {
        ...settings,
        port: 8080,
      });
      expect(planned(JOBS, [onOtherPort]).steps).toEqual([]);
    });

    it('changes a worker in place, naming the web build fields it shares', () => {
      const { steps } = planned(`${JOBS}    build:\n      type: dockerfile\n`, [
        jobs,
      ]);
      expect(steps).toEqual([
        expect.objectContaining({
          action: 'change',
          kind: 'worker',
          fields: [{ field: 'build.type', from: 'nixpacks', to: 'dockerfile' }],
        }),
      ]);
    });

    it('destroys and creates when a web becomes a worker, and back', () => {
      const asWeb = savedApp('jobs', {
        ...settings,
        configKind: 'web',
      });
      const toWorker = planned(JOBS, [asWeb]).steps;
      expect(actions(toWorker)).toEqual(['destroy jobs', 'create jobs']);
      expect(toWorker[1]).toMatchObject({ kind: 'worker' });
      expect(toWorker[0]).toMatchObject({ action: 'destroy', kind: 'web' });

      const toWeb = planned(JOBS.replace('kind: worker', 'kind: web'), [
        jobs,
      ]).steps;
      expect(actions(toWeb)).toEqual(['destroy jobs', 'create jobs']);
      expect(toWeb[1]).toMatchObject({ kind: 'web' });
      expect(toWeb[0]).toMatchObject({ action: 'destroy', kind: 'worker' });
    });

    it('destroys a worker the config no longer describes', () => {
      expect(
        actions(
          planned('version: 1\nservices: {}\n', [jobs], { previous: JOBS })
            .steps,
        ),
      ).toEqual(['destroy jobs']);
    });
  });

  describe('postgres', () => {
    it('compares the image as its version', () => {
      const { steps } = planned(
        'version: 1\nservices:\n  db:\n    kind: postgres\n    version: "17"\n',
        [savedPostgres('db', { databaseName: 'shop', databaseUser: 'shop' })],
      );

      expect(steps).toMatchObject([
        {
          action: 'change',
          serviceType: 'postgres',
          fields: [
            { field: 'version', from: 'postgres:18', to: 'postgres:17' },
          ],
        },
      ]);
    });

    it('compares the database and user only when the config states them', () => {
      const { steps } = planned(
        'version: 1\nservices:\n  db:\n    kind: postgres\n    database: orders\n',
        [savedPostgres('db', { databaseName: 'shop', databaseUser: 'shop' })],
      );

      expect(steps).toMatchObject([
        { fields: [{ field: 'database', from: 'shop', to: 'orders' }] },
      ]);
    });
  });

  describe('mysql', () => {
    const MYSQL = 'version: 1\nservices:\n  shop-db:\n    kind: mysql\n';
    const server: DeployTarget = { kind: 'server', serverId: 'srv-1' };

    it('creates one on the Deploy target, running mysql:8.4 when no version is written', () => {
      const { steps } = planned(MYSQL, [], { deployTarget: server });

      expect(steps).toEqual([
        {
          action: 'create',
          configName: 'shop-db',
          kind: 'mysql',
          placement: server,
          fields: [],
        },
      ]);
    });

    it('shows a written version, database and user on a create', () => {
      const { steps } = planned(
        `${MYSQL}    version: "8.0"\n    database: shop\n    user: root\n`,
      );

      expect(steps).toMatchObject([
        {
          action: 'create',
          kind: 'mysql',
          fields: [
            { field: 'version', from: null, to: 'mysql:8.0' },
            { field: 'database', from: null, to: 'shop' },
            { field: 'user', from: null, to: 'root' },
          ],
        },
      ]);
    });

    it('has nothing to change for one created from an entry with no version', () => {
      expect(
        planned(MYSQL, [savedMysql('shop-db')], { previous: MYSQL }).steps,
      ).toEqual([]);
    });

    it('changes version, size and env in place', () => {
      const { steps } = planned(
        `${MYSQL}    version: "9.1"\n    size: small\n    env: [TZ]\n`,
        [savedMysql('shop-db', {}, ['TZ', 'OLD'])],
        { previous: MYSQL },
      );

      expect(steps).toEqual([
        {
          action: 'change',
          configName: 'shop-db',
          kind: 'mysql',
          serviceType: 'mysql',
          serviceId: 'mysql-shop-db',
          name: 'MySQL shop-db',
          fields: [
            { field: 'size', from: null, to: 'small' },
            { field: 'version', from: 'mysql:8.4', to: 'mysql:9.1' },
            { field: 'env', from: ['TZ', 'OLD'], to: ['TZ'] },
          ],
        },
      ]);
    });

    it('compares the database and user only when the config states them', () => {
      expect(
        planned(MYSQL, [savedMysql('shop-db', { databaseUser: 'root' })], {
          previous: MYSQL,
        }).steps,
      ).toEqual([]);
      expect(
        planned(`${MYSQL}    user: shop\n`, [
          savedMysql('shop-db', { databaseUser: 'root' }),
        ]).steps,
      ).toMatchObject([
        { fields: [{ field: 'user', from: 'root', to: 'shop' }] },
      ]);
    });

    it('destroys one the config described and no longer lists', () => {
      const { steps } = planned(
        'version: 1\nservices: {}\n',
        [savedMysql('shop-db')],
        { previous: MYSQL },
      );

      expect(steps).toEqual([
        {
          action: 'destroy',
          configName: 'shop-db',
          kind: 'mysql',
          serviceType: 'mysql',
          serviceId: 'mysql-shop-db',
          name: 'MySQL shop-db',
        },
      ]);
    });
  });

  describe('handing a console-managed mysql to the config', () => {
    const LISTED =
      'version: 1\nservices:\n  shop-db:\n    kind: mysql\n    managed: console\n';
    const DESCRIBED = 'version: 1\nservices:\n  shop-db:\n    kind: mysql\n';
    const NOTE = {
      kind: 'mysql-can-be-described',
      configName: 'shop-db',
      message:
        'shop-db: mysql can now be described; remove managed: console to hand it to the config',
    };
    // A MySQL made in the console before the default image changed runs the old
    // one.
    const consoleMysql = (settings: Parameters<typeof savedMysql>[1] = {}) =>
      savedMysql('shop-db', { dockerImage: 'mysql:8', ...settings });

    it('notes on every plan that a console-managed mysql can now be described', () => {
      for (const previous of [undefined, LISTED]) {
        expect(planned(LISTED, [consoleMysql()], { previous })).toEqual({
          ok: true,
          steps: [],
          notes: [NOTE],
        });
      }
    });

    it('notes it on AWS too, which makes a mysql on RDS, and on Google Cloud, which makes one on Cloud SQL', () => {
      const deployTarget: DeployTarget = {
        kind: 'cloud',
        cloudAccountId: 'ca-1',
        region: 'eu-west-1',
      };
      const on = (cloud: 'aws' | 'gcp') =>
        planEnvironment({
          config: config(LISTED),
          saved: [consoleMysql()],
          deployTarget,
          cloud,
          context: { previous: config(LISTED) },
        });

      expect(on('aws')).toMatchObject({ ok: true, notes: [NOTE] });
      expect(on('gcp')).toMatchObject({ ok: true, notes: [NOTE] });
    });

    it('notes a console-managed mysql line the config already had, in an Environment without that Service', () => {
      expect(planned(LISTED, [], { previous: LISTED }).notes).toEqual([NOTE]);
    });

    it('gives no note for a console-managed mariadb', () => {
      const line =
        'version: 1\nservices:\n  shop-db:\n    kind: mariadb\n    managed: console\n';
      expect(planned(line, [], { previous: line }).notes).toEqual([]);
    });

    it('changes it in place, matched by Config name, once managed: console is removed', () => {
      const { steps, notes } = planned(
        `${DESCRIBED}    version: "8"\n    description: Shop\n`,
        [consoleMysql()],
        { previous: LISTED },
      );

      expect(steps).toEqual([
        {
          action: 'change',
          configName: 'shop-db',
          kind: 'mysql',
          serviceType: 'mysql',
          serviceId: 'mysql-shop-db',
          name: 'MySQL shop-db',
          fields: [{ field: 'description', from: null, to: 'Shop' }],
        },
      ]);
      expect(notes).toEqual([]);
    });

    it('plans mysql:8 → mysql:8.4 for one with no version written, and nothing for version "8"', () => {
      expect(
        planned(DESCRIBED, [consoleMysql()], { previous: LISTED }).steps,
      ).toMatchObject([
        {
          action: 'change',
          fields: [{ field: 'version', from: 'mysql:8', to: 'mysql:8.4' }],
        },
      ]);
      expect(
        planned(`${DESCRIBED}    version: "8"\n`, [consoleMysql()], {
          previous: LISTED,
        }).steps,
      ).toEqual([]);
    });

    it('keeps its database and user when the entry leaves them out, a root user included', () => {
      expect(
        planned(
          `${DESCRIBED}    version: "8"\n`,
          [consoleMysql({ databaseName: 'legacy', databaseUser: 'root' })],
          { previous: LISTED },
        ).steps,
      ).toEqual([]);
    });
  });

  describe('variables', () => {
    it('notes a listed name with no value here, and changes nothing for it', () => {
      const outcome = planned(
        'version: 1\nservices:\n  web:\n    kind: web\n    env: [DATABASE_URL, PORT]\n    build_secrets: [NPM_TOKEN]\n',
        [savedApp('web', {}, { env: ['PORT'] })],
      );

      expect(outcome.steps).toEqual([]);
      expect(outcome.notes).toEqual([
        {
          kind: 'variable-without-value',
          configName: 'web',
          list: 'env',
          variable: 'DATABASE_URL',
          message:
            'web.env lists DATABASE_URL, which has no value in this Environment',
        },
        {
          kind: 'variable-without-value',
          configName: 'web',
          list: 'build_secrets',
          variable: 'NPM_TOKEN',
          message:
            'web.build_secrets lists NPM_TOKEN, which has no value in this Environment',
        },
      ]);
    });

    it('changes a Service holding a key the config does not list, which Apply removes', () => {
      const { steps } = planned(
        'version: 1\nservices:\n  web:\n    kind: web\n    env: [PORT]\n',
        [
          savedApp(
            'web',
            {},
            { env: ['PORT', 'LEGACY_FLAG'], buildArgs: ['NODE_ENV'] },
          ),
        ],
      );

      expect(steps).toMatchObject([
        {
          action: 'change',
          fields: [
            { field: 'env', from: ['PORT', 'LEGACY_FLAG'], to: ['PORT'] },
            { field: 'build_args', from: ['NODE_ENV'], to: [] },
          ],
        },
      ]);
    });

    it('notes every listed name of a Service it creates', () => {
      const { notes } = planned(
        'version: 1\nservices:\n  cache:\n    kind: redis\n    env: [REDIS_ARGS]\n',
      );

      expect(notes).toMatchObject([
        {
          kind: 'variable-without-value',
          configName: 'cache',
          variable: 'REDIS_ARGS',
        },
      ]);
    });
  });

  describe('console-managed Services', () => {
    it('leaves a listed console-managed Service alone', () => {
      expect(
        planned(
          'version: 1\nservices:\n  docs:\n    kind: mongo\n    managed: console\n  db:\n    kind: postgres\n    managed: console\n',
          [
            savedMongo('docs'),
            savedPostgres('db', { dockerImage: 'postgres:15' }),
          ],
        ),
      ).toEqual({ ok: true, steps: [], notes: [] });
    });

    it('notes a console-managed Service the config does not list, with the line to paste', () => {
      const outcome = planned('version: 1\nservices: {}\n', [
        savedMongo('docs'),
      ]);

      expect(outcome.steps).toEqual([]);
      expect(outcome.notes).toEqual([
        {
          kind: 'console-managed-unlisted',
          configName: 'docs',
          line: 'docs:\n  kind: mongo\n  managed: console',
          message:
            'docs is a mongo Service the config does not list; paste the line to keep the config complete',
        },
      ]);
    });

    it('notes a dropped console-managed line and never destroys the Service', () => {
      const outcome = planned(
        'version: 1\nservices: {}\n',
        [savedPostgres('db')],
        {
          previous:
            'version: 1\nservices:\n  db:\n    kind: postgres\n    managed: console\n',
        },
      );

      expect(outcome.steps).toEqual([]);
      expect(outcome.notes).toMatchObject([
        {
          kind: 'console-managed-dropped',
          configName: 'db',
          line: 'db:\n  kind: postgres\n  managed: console',
        },
      ]);
    });

    it('destroys a described Service the config no longer lists', () => {
      const { steps } = planned(
        'version: 1\nservices: {}\n',
        [savedPostgres('db')],
        { previous: 'version: 1\nservices:\n  db:\n    kind: postgres\n' },
      );

      expect(actions(steps)).toEqual(['destroy db']);
    });

    it('notes, and never destroys, a describable Service the previous config did not describe', () => {
      for (const previous of [undefined, 'version: 1\nservices: {}\n']) {
        const outcome = planned(
          'version: 1\nservices: {}\n',
          [savedPostgres('db')],
          { previous },
        );

        expect(outcome.steps).toEqual([]);
        expect(outcome.notes).toMatchObject([
          {
            kind: 'console-managed-unlisted',
            configName: 'db',
            line: 'db:\n  kind: postgres\n  managed: console',
          },
        ]);
      }
    });

    it('hands an expressible Service to the config when managed: console is removed', () => {
      const { steps } = planned(
        'version: 1\nservices:\n  db:\n    kind: postgres\n    version: "18"\n',
        [savedPostgres('db', { dockerImage: 'postgres:15' })],
        {
          previous:
            'version: 1\nservices:\n  db:\n    kind: postgres\n    managed: console\n',
        },
      );

      expect(steps).toMatchObject([
        {
          action: 'change',
          fields: [
            { field: 'version', from: 'postgres:15', to: 'postgres:18' },
          ],
        },
      ]);
    });

    it('refuses a console-managed line for a Service that does not exist, naming it', () => {
      expect(
        refusedAt(
          'version: 1\nservices:\n  docs:\n    kind: mongo\n    managed: console\n',
        ),
      ).toEqual(['docs']);
    });

    it('leaves alone a console-managed line the config already had, in an Environment without that Service', () => {
      const line =
        'version: 1\nservices:\n  docs:\n    kind: mongo\n    managed: console\n';
      expect(planned(line, [], { previous: line })).toEqual({
        ok: true,
        steps: [],
        notes: [],
      });
    });

    it('leaves alone a console-managed line the config already had, whatever kind the Service here is', () => {
      const line =
        'version: 1\nservices:\n  db:\n    kind: postgres\n    managed: console\n';
      expect(planned(line, [savedMongo('db')], { previous: line })).toEqual({
        ok: true,
        steps: [],
        notes: [],
      });
    });

    it('refuses a console-managed line under another kind, naming its kind', () => {
      expect(
        refusedAt(
          'version: 1\nservices:\n  docs:\n    kind: mysql\n    managed: console\n',
          [savedMongo('docs')],
        ),
      ).toEqual(['docs.kind']);
    });

    it('refuses describing a Service of a kind version 1 cannot describe', () => {
      expect(
        refusedAt('version: 1\nservices:\n  docs:\n    kind: postgres\n', [
          savedMongo('docs'),
        ]),
      ).toEqual(['docs.kind']);
    });

    it('names every refusal, not only the first', () => {
      expect(
        refusedAt(
          'version: 1\nservices:\n  a:\n    kind: mongo\n    managed: console\n  b:\n    kind: compose\n    managed: console\n',
        ),
      ).toEqual(['a', 'b']);
    });
  });

  describe('a Deploy target in a Cloud account', () => {
    const cloud: DeployTarget = {
      kind: 'cloud',
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
    };
    const onCloud = { deployTarget: cloud };

    it('refuses every entry of a kind it cannot make yet, naming it, and never places it on a Server', () => {
      const outcome = plan(
        `version: 1
services:
  db:
    kind: postgres
  cache:
    kind: redis
  docs:
    kind: static
    source: { github: acme/docs }
  jobs:
    kind: worker
    command: node
    source: { github: acme/jobs }
  report:
    kind: cron
    command: node
    schedule: "0 3 * * *"
    source: { github: acme/jobs }
  shop-db:
    kind: mysql
`,
        [savedPostgres('db')],
        onCloud,
      );

      // A postgres is an RDS instance there, a redis an ElastiCache
      // replication group, a static site on S3 + CloudFront, a worker on ECS,
      // a cron as ECS tasks, and a mysql an RDS instance: AWS refuses no kind
      // of version 1 now.
      expect(outcome.ok).toBe(true);
    });

    describe('the kinds each cloud makes (spec S17)', () => {
      it('on AWS: a web, a postgres, a redis, a bucket, a static site, a worker, a web-private, a cron, a mysql and a compose', () => {
        expect([...kindsOn('aws')]).toEqual([
          'web',
          'postgres',
          'redis',
          'bucket',
          'static',
          'worker',
          'web-private',
          'cron',
          'mysql',
          'compose',
        ]);
      });

      it('on Google Cloud: a web, a postgres, a redis, a bucket, a static site, a worker, a web-private, a cron, a mysql and, last, a compose on its Stack VM', () => {
        expect([...kindsOn('gcp')]).toEqual([
          'web',
          'postgres',
          'redis',
          'bucket',
          'static',
          'worker',
          'web-private',
          'cron',
          'mysql',
          'compose',
        ]);
      });

      it('refuses no kind of version 1 on Google Cloud now that a mysql is made on Cloud SQL', () => {
        const text = `version: 1
services:
  report:
    kind: cron
    command: node
    schedule: "0 3 * * *"
    source: { github: acme/jobs }
  shop-db:
    kind: mysql
  api:
    kind: web
    source: { image: nginx }
`;
        const onGoogle = planEnvironment({
          config: config(text),
          saved: [],
          deployTarget: cloud,
          cloud: 'gcp',
          context: { previous: null },
        });
        // A cron is a Cloud Run job there, and a mysql a Cloud SQL
        // for MySQL instance.
        expect(onGoogle.ok).toBe(true);
      });

      it("plans by the Deploy target's cloud, AWS when none is named", () => {
        // A mysql, an RDS instance on AWS and a Cloud SQL one on
        // Google Cloud.
        const text = `version: 1
services:
  shop-db:
    kind: mysql
  api:
    kind: web
    source: { image: nginx }
`;
        const onAws = planEnvironment({
          config: config(text),
          saved: [],
          deployTarget: cloud,
          cloud: 'aws',
          context: { previous: null },
        });

        const onGoogle = planEnvironment({
          config: config(text),
          saved: [],
          deployTarget: cloud,
          cloud: 'gcp',
          context: { previous: null },
        });

        expect(onAws).toEqual(plan(text, [], onCloud));
        const made = (outcome: PlanOutcome) =>
          outcome.ok
            ? outcome.steps.find(
                (step) =>
                  step.action === 'create' && step.configName === 'shop-db',
              )
            : undefined;
        expect(made(onAws)).toHaveProperty('database');
        expect(made(onGoogle)).toHaveProperty('cloudSql');
      });
    });

    describe("each of the spec's new kinds", () => {
      const NEW_KINDS = `version: 1
services:
  shop-db:
    kind: mysql
  jobs:
    kind: worker
    command: node
    args: [worker.js]
    source: { github: acme/jobs }
  api:
    kind: web-private
    port: 4000
    source: { github: acme/api }
  report:
    kind: cron
    command: node dist/report.js
    schedule: "0 3 * * *"
    source: { github: acme/reports }
`;

      it('is made on AWS, each of them: a worker, a web-private, a cron and a mysql', () => {
        expect(plan(NEW_KINDS, [], onCloud).ok).toBe(true);
      });

      it('is made on Google Cloud, each of them: a worker, a web-private, a cron and a mysql', () => {
        const onGoogle = planEnvironment({
          config: config(NEW_KINDS),
          saved: [],
          deployTarget: cloud,
          cloud: 'gcp',
          context: { previous: null },
        });

        expect(onGoogle.ok).toBe(true);
      });

      it('keeps one already on a Server there, changing it in place (ADR-0035)', () => {
        const { steps } = planned(
          NEW_KINDS.replace(/ {2}jobs:[\s\S]*/, ''),
          [savedMysql('shop-db', { dockerImage: 'mysql:8.4' })],
          onCloud,
        );

        expect(steps.filter((step) => step.action !== 'change')).toEqual([]);
      });

      it('plans each one normally on a Server target', () => {
        const { steps } = planned(NEW_KINDS, [], {
          deployTarget: { kind: 'server', serverId: 'srv-1' },
        });

        expect(actions(steps)).toEqual([
          'create shop-db',
          'create jobs',
          'create api',
          'create report',
        ]);
      });
    });

    it('creates a web there reading AWS, with the Environment network made first as its own step', () => {
      const { steps } = planned(
        'version: 1\nservices:\n  web:\n    kind: web\n    size: small\n    port: 8080\n    command: node\n    args: [server.js]\n    source: { image: nginx }\n',
        [],
        onCloud,
      );

      expect(steps).toEqual([
        {
          action: 'network-create',
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          cloudRead: { status: 'reading' },
        },
        expect.objectContaining({
          action: 'create',
          configName: 'web',
          kind: 'web',
          placement: cloud,
          cloud: {
            size: {
              name: 'small',
              pair: { runsOn: 'Fargate', wording: '0.5 vCPU / 1 GB' },
            },
            service: {
              port: 8080,
              command: 'node',
              args: ['server.js'],
              size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
            },
          },
          cloudRead: { status: 'reading' },
        }),
      ]);
    });

    describe('a worker on ECS', () => {
      const WORKER =
        'version: 1\nservices:\n  jobs:\n    kind: worker\n    size: small\n    command: node\n    args: [worker.js]\n    source: { image: acme/jobs:1 }\n';
      const inCloud = (settings = {}): SavedService => ({
        ...savedApp('jobs', {
          sourceType: 'docker',
          dockerImage: 'acme/jobs:1',
          ...settings,
        }),
        cloud: {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          linkedRegistries: [],
        },
      });
      const networks = [
        {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          environmentNetworkId: 'net-1',
        },
      ];

      it('creates one reading AWS, with no port, and makes the whole Environment network first when it is the first cloud Service', () => {
        const { steps, notes } = planned(WORKER, [], onCloud);

        expect(steps).toEqual([
          {
            action: 'network-create',
            cloudAccountId: 'ca-1',
            region: 'eu-west-1',
            cloudRead: { status: 'reading' },
          },
          expect.objectContaining({
            action: 'create',
            configName: 'jobs',
            kind: 'worker',
            placement: cloud,
            cloud: {
              size: {
                name: 'small',
                pair: { runsOn: 'Fargate', wording: '0.5 vCPU / 1 GB' },
              },
              service: {
                port: null,
                command: 'node',
                args: ['worker.js'],
                size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
              },
            },
            cloudRead: { status: 'reading' },
          }),
        ]);
        // A worker takes no Domain, so the plan never points it at one.
        expect(notes.map((note) => note.kind)).not.toContain('cloud-no-domain');
      });

      it("refuses a size above Fargate's largest pair, naming the entry", () => {
        expect(
          refusedAt(
            'version: 1\nservices:\n  jobs:\n    kind: worker\n    size: { cpu: 32, memory: 64 GB }\n',
            [],
            onCloud,
          ),
        ).toEqual(['jobs.size']);
      });

      it('reads one a step changes with the config its read writes', () => {
        const { steps } = planned(WORKER, [inCloud({ configKind: 'worker' })], {
          ...onCloud,
          networks,
        });

        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({
          action: 'change',
          configName: 'jobs',
          kind: 'worker',
          cloud: {
            service: {
              port: null,
              command: 'node',
              args: ['worker.js'],
              size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
            },
          },
          cloudRead: { status: 'reading' },
        });
      });

      it('destroys and creates when a web there becomes a worker, and back', () => {
        const toWorker = planned(WORKER, [inCloud({ configKind: 'web' })], {
          ...onCloud,
          networks,
        });
        expect(actions(toWorker.steps)).toEqual([
          'destroy jobs',
          'create jobs',
        ]);
        expect(toWorker.steps[1]).toMatchObject({
          kind: 'worker',
          cloud: { service: { port: null } },
        });

        const toWeb = planned(
          'version: 1\nservices:\n  jobs:\n    kind: web\n    source: { image: acme/jobs:1 }\n',
          [inCloud({ configKind: 'worker' })],
          { ...onCloud, networks },
        );
        expect(actions(toWeb.steps)).toEqual(['destroy jobs', 'create jobs']);
        expect(toWeb.steps[1]).toMatchObject({
          kind: 'web',
          cloud: { service: { port: 3000 } },
        });
      });
    });

    describe('a cron on ECS', () => {
      const REPORT =
        'version: 1\nservices:\n  report:\n    kind: cron\n    size: small\n    command: node dist/report.js\n    args: [--all]\n    schedule: "0 3 * * *"\n    source: { image: acme/reports:1 }\n';
      const inCloud = (settings = {}): SavedService => ({
        ...savedApp('report', {
          configKind: 'cron',
          sourceType: 'docker',
          dockerImage: 'acme/reports:1',
          command: 'node dist/report.js',
          args: ['--all'],
          cpuLimit: '500000000',
          memoryLimit: '1073741824',
          cronSchedule: '0 3 * * *',
          cronTimezone: 'UTC',
          cronTimeoutSeconds: 3600,
          ...settings,
        }),
        cloud: {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          linkedRegistries: [],
        },
      });
      const networks = [
        {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          environmentNetworkId: 'net-1',
        },
      ];

      it('creates one reading AWS, with no port, its timetable among its fields, and the Environment network first', () => {
        const { steps, notes } = planned(REPORT, [], onCloud);

        expect(steps).toEqual([
          {
            action: 'network-create',
            cloudAccountId: 'ca-1',
            region: 'eu-west-1',
            cloudRead: { status: 'reading' },
          },
          expect.objectContaining({
            action: 'create',
            configName: 'report',
            kind: 'cron',
            placement: cloud,
            fields: expect.arrayContaining([
              { field: 'schedule', from: null, to: '0 3 * * *' },
            ]) as unknown,
            cloud: {
              size: {
                name: 'small',
                pair: { runsOn: 'Fargate', wording: '0.5 vCPU / 1 GB' },
              },
              service: {
                port: null,
                command: 'node dist/report.js',
                args: ['--all'],
                size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
              },
            },
            cloudRead: { status: 'reading' },
          }),
        ]);
        // A Cron service takes no Domain, so the plan never points it at one.
        expect(notes.map((note) => note.kind)).not.toContain('cloud-no-domain');
      });

      it('is nothing to change when its row says what the config says', () => {
        expect(
          planned(REPORT, [inCloud()], { ...onCloud, networks }).steps,
        ).toEqual([]);
      });

      it.each([
        ['schedule', 'schedule: "0 3 * * *"', 'schedule: "*/30 * * * *"'],
        ['timezone', 'size: small', 'size: small\n    timezone: Europe/Berlin'],
        ['timeout', 'size: small', 'size: small\n    timeout: 30m'],
      ])(
        'shows a changed %s as a Cloudgate setting that reads nothing in AWS',
        (field, from, to) => {
          const { steps } = planned(REPORT.replace(from, to), [inCloud()], {
            ...onCloud,
            networks,
          });

          expect(steps).toHaveLength(1);
          expect(steps[0]).toMatchObject({
            action: 'change',
            configName: 'report',
            fields: [expect.objectContaining({ field })],
          });
          expect(steps[0]).not.toHaveProperty('cloudRead');
          expect(steps[0]).not.toHaveProperty('cloud');
        },
      );

      it('reads AWS for a changed command, with the config its read writes', () => {
        const { steps } = planned(
          REPORT.replace('node dist/report.js', 'node dist/report-v2.js'),
          [inCloud()],
          { ...onCloud, networks },
        );

        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({
          action: 'change',
          fields: [expect.objectContaining({ field: 'command' })],
          cloud: { service: { port: null, command: 'node dist/report-v2.js' } },
          cloudRead: { status: 'reading' },
        });
      });

      it('reads AWS when a timetable field changes beside one AWS holds', () => {
        const { steps } = planned(
          REPORT.replace('node dist/report.js', 'node dist/x.js').replace(
            '0 3 * * *',
            '0 4 * * *',
          ),
          [inCloud()],
          { ...onCloud, networks },
        );

        expect(steps[0]).toMatchObject({
          action: 'change',
          cloudRead: { status: 'reading' },
        });
      });
    });

    describe('a web-private on ECS', () => {
      const INTERNAL =
        'version: 1\nservices:\n  inside:\n    kind: web-private\n    size: small\n    port: 4000\n    source: { image: acme/inside:1 }\n';
      const WEB =
        'version: 1\nservices:\n  api:\n    kind: web\n    source: { image: nginx }\n';
      const inCloud = (name: string, settings = {}): SavedService => ({
        ...savedApp(name, {
          sourceType: 'docker',
          dockerImage: 'acme/inside:1',
          ...settings,
        }),
        cloud: {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          linkedRegistries: [],
        },
      });
      const made = (privateLinks?: 'private-dns'[]) => [
        {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          environmentNetworkId: 'net-1',
          ...(privateLinks ? { privateLinks } : {}),
        },
      ];

      it('creates one reading AWS on its port, and makes the network with its private DNS namespace first', () => {
        const { steps, notes } = planned(INTERNAL, [], onCloud);

        expect(steps).toEqual([
          {
            action: 'network-create',
            cloudAccountId: 'ca-1',
            region: 'eu-west-1',
            privateLinks: ['private-dns'],
            cloudRead: { status: 'reading' },
          },
          expect.objectContaining({
            action: 'create',
            configName: 'inside',
            kind: 'web-private',
            placement: cloud,
            cloud: expect.objectContaining({
              service: expect.objectContaining({ port: 4000 }) as unknown,
            }) as unknown,
            cloudRead: { status: 'reading' },
          }),
        ]);
        // It takes no Domain, so the plan never points it at one.
        expect(notes.map((note) => note.kind)).not.toContain('cloud-no-domain');
      });

      it('adds the namespace to a made network that has none, as its own network step', () => {
        const { steps } = planned(INTERNAL, [], {
          ...onCloud,
          networks: made(),
        });

        expect(steps[0]).toEqual({
          action: 'network-change',
          environmentNetworkId: 'net-1',
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          privateLinks: ['private-dns'],
          cloudRead: { status: 'reading' },
        });
        expect(actions(steps)).toEqual([
          'network-change eu-west-1',
          'create inside',
        ]);
      });

      it('does not add it again for a second web-private', () => {
        const { steps } = planned(
          'version: 1\nservices:\n  inside:\n    kind: web-private\n    port: 4000\n    source: { image: acme/inside:1 }\n  other:\n    kind: web-private\n    port: 5000\n    source: { image: acme/other:1 }\n',
          [inCloud('inside', { configKind: 'web-private', port: 4000 })],
          { ...onCloud, networks: made(['private-dns']) },
        );

        expect(actions(steps)).toEqual(['create other']);
      });

      it('keeps it when the last web-private goes: only the Service is destroyed', () => {
        const { steps } = planned(
          WEB,
          [
            inCloud('inside', { configKind: 'web-private', port: 4000 }),
            inCloud('api', { configKind: 'web', port: 3000 }),
          ],
          {
            ...onCloud,
            networks: made(['private-dns']),
            previous: `${WEB}  inside:\n    kind: web-private\n    port: 4000\n    source: { image: acme/inside:1 }\n`,
          },
        );

        expect(actions(steps)).toContain('destroy inside');
        expect(
          actions(steps).filter((one) => one.startsWith('network')),
        ).toEqual([]);
      });

      it('refuses one whose Config name ends in a hyphen, naming the entry and the rule, before anything is made', () => {
        const outcome = plan(
          INTERNAL.replace('inside:', 'inside-:'),
          [],
          onCloud,
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusals).toEqual([
          {
            at: 'inside-',
            message: expect.stringContaining(
              'cannot end in a hyphen',
            ) as unknown,
          },
        ]);
        expect(outcome.refusals[0].message).toContain('inside-');
      });

      it('still plans a web whose Config name ends in a hyphen: only a web-private takes a DNS name', () => {
        const { steps } = planned(WEB.replace('api:', 'api-:'), [], onCloud);

        expect(actions(steps)).toContain('create api-');
      });

      it('adds nothing to the network for a web or a worker', () => {
        const { steps } = planned(WEB, [], { ...onCloud, networks: made() });
        expect(actions(steps)).toEqual(['create api']);
      });

      it('destroys and creates when a web or a worker there becomes a web-private, and back', () => {
        for (const from of ['web', 'worker']) {
          const switched = planned(
            INTERNAL,
            [inCloud('inside', { configKind: from })],
            { ...onCloud, networks: made(['private-dns']) },
          );
          expect(actions(switched.steps)).toEqual([
            'destroy inside',
            'create inside',
          ]);
          expect(switched.steps[1]).toMatchObject({ kind: 'web-private' });
        }
        const back = planned(
          'version: 1\nservices:\n  inside:\n    kind: web\n    port: 4000\n    source: { image: acme/inside:1 }\n',
          [inCloud('inside', { configKind: 'web-private', port: 4000 })],
          { ...onCloud, networks: made(['private-dns']) },
        );
        expect(actions(back.steps)).toEqual([
          'destroy inside',
          'create inside',
        ]);
      });
    });

    it('makes no network step where the Environment already has one in that Cloud account and region', () => {
      const text =
        'version: 1\nservices:\n  api:\n    kind: web\n    source: { image: nginx }\n';

      const there = planEnvironment({
        config: config(text),
        saved: [],
        deployTarget: cloud,
        context: { previous: null },
        networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
      });
      const elsewhere = planEnvironment({
        config: config(text),
        saved: [],
        deployTarget: cloud,
        context: { previous: null },
        networks: [{ cloudAccountId: 'ca-1', region: 'us-east-1' }],
      });

      expect(there.ok && actions(there.steps)).toEqual(['create api']);
      expect(elsewhere.ok && actions(elsewhere.steps)).toEqual([
        'network-create eu-west-1',
        'create api',
      ]);
    });

    it('creates a web with no size at the xsmall pair', () => {
      const { steps } = planned(
        'version: 1\nservices:\n  web:\n    kind: web\n',
        [],
        onCloud,
      );

      expect(steps[1]).toMatchObject({
        cloud: {
          size: {
            name: null,
            pair: { runsOn: 'Fargate', wording: '0.25 vCPU / 0.5 GB' },
          },
        },
      });
    });

    it("refuses a size above Fargate's largest pair, naming the entry", () => {
      const outcome = plan(
        'version: 1\nservices:\n  web:\n    kind: web\n    size: { cpu: 32, memory: 64 GB }\n',
        [],
        onCloud,
      );

      expect(outcome).toEqual({
        ok: false,
        refusals: [
          {
            at: 'web.size',
            message:
              "web: size 32 CPU / 64 GB is above Fargate's largest pair, 16 vCPU / 120 GB",
          },
        ],
      });
    });

    it('plans a cloud web that lists variables, whose values reach the task as SSM parameters', () => {
      const { steps } = planned(
        'version: 1\nservices:\n  web:\n    kind: web\n    env: [API_KEY, DEBUG]\n',
        [],
        onCloud,
      );

      expect(steps).toEqual([
        expect.objectContaining({ action: 'network-create' }),
        expect.objectContaining({
          action: 'create',
          configName: 'web',
          cloudRead: { status: 'reading' },
        }),
      ]);
    });

    it('refuses a Registry or build Registry linked to a cloud Service the config describes, naming it', () => {
      const site: SavedService = {
        ...savedApp('site', { sourceType: 'docker', dockerImage: 'nginx' }),
        cloud: {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          linkedRegistries: [
            { as: 'Registry', name: 'Docker Hub' },
            { as: 'build Registry', name: 'ghcr' },
          ],
        },
      };

      expect(
        plan(
          'version: 1\nservices:\n  site:\n    kind: web\n    source: { image: nginx }\n',
          [site],
          onCloud,
        ),
      ).toEqual({
        ok: false,
        refusals: [
          {
            at: 'site',
            message:
              "site runs in a Cloud account, where its image always goes to the Service's own ECR repository, so the Registry Docker Hub linked to it is refused. Unlink it in the console",
          },
          {
            at: 'site',
            message:
              "site runs in a Cloud account, where its image always goes to the Service's own ECR repository, so the build Registry ghcr linked to it is refused. Unlink it in the console",
          },
        ],
      });
    });

    it('destroys and creates for a kind change that creates a web there', () => {
      const { steps } = planned(
        'version: 1\nservices:\n  site:\n    kind: web\n',
        [savedApp('site', { configKind: 'static', buildType: 'static' })],
        {
          ...onCloud,
          previous: 'version: 1\nservices:\n  site:\n    kind: static\n',
        },
      );

      expect(actions(steps)).toEqual([
        'network-create eu-west-1',
        'destroy site',
        'create site',
      ]);
    });

    it('still changes a web that already runs on a Server, where it was created', () => {
      const { steps } = planned(
        'version: 1\nservices:\n  web:\n    kind: web\n    port: 8080\n',
        [savedApp('web')],
        onCloud,
      );

      expect(actions(steps)).toEqual(['change web']);
    });

    it('leaves console-managed lines of any kind alone', () => {
      expect(
        planned(
          'version: 1\nservices:\n  db:\n    kind: postgres\n    managed: console\n',
          [savedPostgres('db')],
          onCloud,
        ),
      ).toEqual({ ok: true, steps: [], notes: [] });
    });

    describe('which cloud Services and networks a plan reads for Drift', () => {
      const inCloud = (name: string, settings = {}): SavedService => ({
        ...savedApp(name, {
          sourceType: 'docker',
          dockerImage: 'nginx',
          ...settings,
        }),
        cloud: {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          linkedRegistries: [],
        },
      });
      const TWO = `version: 1
services:
  web:
    kind: web
    port: 8080
    source: { image: nginx }
  api:
    kind: web
    source: { image: nginx }
`;
      const saved = [inCloud('web'), inCloud('api')];
      const networks = [
        {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          environmentNetworkId: 'net-1',
        },
      ];

      it('reads a cloud Service a step changes, with the config its read writes', () => {
        const { steps } = planned(TWO, saved, { ...onCloud, networks });

        expect(steps).toEqual([
          expect.objectContaining({
            action: 'change',
            configName: 'web',
            fields: [{ field: 'port', from: 3000, to: 8080 }],
            cloud: {
              size: {
                name: null,
                pair: { runsOn: 'Fargate', wording: '0.25 vCPU / 0.5 GB' },
              },
              service: { port: 8080, command: null, args: [], size: null },
            },
            cloudRead: { status: 'reading' },
          }),
        ]);
      });

      it('reads every cloud Service and each made network on Check for changes, an unchanged one as a change of no field', () => {
        const { steps } = planned(TWO, saved, {
          ...onCloud,
          networks,
          cloudReads: { everything: true, services: [] },
        });

        expect(steps).toEqual([
          {
            action: 'network-change',
            environmentNetworkId: 'net-1',
            cloudAccountId: 'ca-1',
            region: 'eu-west-1',
            cloudRead: { status: 'reading' },
          },
          expect.objectContaining({
            action: 'change',
            configName: 'web',
            cloudRead: { status: 'reading' },
          }),
          expect.objectContaining({
            action: 'change',
            configName: 'api',
            serviceId: 'app-api',
            fields: [],
            cloudRead: { status: 'reading' },
          }),
        ]);
      });

      it('reads, besides what it touches, only the Services an open plan found drift on', () => {
        const { steps } = planned(TWO, saved, {
          ...onCloud,
          networks,
          cloudReads: { everything: false, services: ['app-api'] },
        });

        expect(actions(steps)).toEqual(['change web', 'change api']);
      });

      it('reads no network that is not made yet, and no Service on a Server', () => {
        const { steps } = planned(
          TWO,
          [
            inCloud('web'),
            savedApp('api', { sourceType: 'docker', dockerImage: 'nginx' }),
          ],
          {
            ...onCloud,
            networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
            cloudReads: { everything: true, services: [] },
          },
        );

        expect(actions(steps)).toEqual(['change web']);
      });

      it('does not read a cloud Service the plan destroys', () => {
        const { steps } = planned(
          'version: 1\nservices: {}\n',
          [inCloud('web')],
          {
            ...onCloud,
            previous: TWO,
            cloudReads: { everything: true, services: [] },
          },
        );

        expect(steps).toEqual([
          expect.objectContaining({ action: 'destroy', configName: 'web' }),
        ]);
      });
    });
  });

  describe('an Environment network nothing uses', () => {
    const network = {
      environmentNetworkId: 'net-1',
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      dnsRecordsLeft: [
        { name: 'shop.example.com', type: 'CNAME', value: 'alb.example' },
      ],
    };
    const text =
      'version: 1\nservices:\n  api:\n    kind: web\n    source: { image: nginx }\n';
    const inCloud = (configName: string): SavedService => ({
      ...savedApp(configName, { sourceType: 'docker', dockerImage: 'nginx' }),
      cloud: {
        cloudAccountId: 'ca-1',
        region: 'eu-west-1',
        linkedRegistries: [],
      },
    });
    const withNetwork = (saved: SavedService[], deployTarget: DeployTarget) =>
      planEnvironment({
        config: config(text),
        saved,
        deployTarget,
        context: { previous: null },
        networks: [network],
        removableNetworks: [network],
      });

    it('removes it, last and typed-confirmed, once neither a Service nor the Deploy target is there', () => {
      const outcome = withNetwork([], PLATFORM);

      expect(outcome.ok && outcome.steps).toEqual([
        expect.objectContaining({ action: 'create', configName: 'api' }),
        {
          action: 'network-remove',
          environmentNetworkId: 'net-1',
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          confirmName: 'network-eu-west-1',
          dnsRecordsLeft: network.dnsRecordsLeft,
        },
      ]);
    });

    it('keeps it while the Deploy target is there', () => {
      const outcome = withNetwork([], {
        kind: 'cloud',
        cloudAccountId: 'ca-1',
        region: 'eu-west-1',
      });

      expect(outcome.ok && actions(outcome.steps)).toEqual(['create api']);
    });

    it('keeps it while a Service still runs there, the config describing it or not', () => {
      const outcome = withNetwork([inCloud('legacy')], PLATFORM);

      expect(outcome.ok && actions(outcome.steps)).toEqual(['create api']);
    });

    it('keeps it while this plan destroys the last Service there, for the plan after', () => {
      const outcome = planEnvironment({
        config: config(text),
        saved: [inCloud('old')],
        deployTarget: PLATFORM,
        context: {
          previous: config(
            'version: 1\nservices:\n  old:\n    kind: web\n    source: { image: nginx }\n',
          ),
        },
        removableNetworks: [network],
      });

      expect(outcome.ok && actions(outcome.steps)).toEqual([
        'create api',
        'destroy old',
      ]);
    });

    it('removes one in another region than the Deploy target, after making the new one first', () => {
      const outcome = withNetwork([], {
        kind: 'cloud',
        cloudAccountId: 'ca-1',
        region: 'us-east-1',
      });

      expect(outcome.ok && actions(outcome.steps)).toEqual([
        'network-create us-east-1',
        'create api',
        'network-remove eu-west-1',
      ]);
    });
  });

  describe('kind: cron', () => {
    const REPORT = [
      'version: 1',
      'services:',
      '  report:',
      '    kind: cron',
      '    command: node dist/report.js',
      '    schedule: "0 3 * * *"',
      '    source:',
      '      github: acme/reports',
      '',
    ].join('\n');

    const report = (settings: Partial<SavedApplicationSettings> = {}) =>
      savedApp('report', {
        configKind: 'cron',
        owner: 'acme',
        repository: 'reports',
        command: 'node dist/report.js',
        cronSchedule: '0 3 * * *',
        cronTimezone: 'UTC',
        cronTimeoutSeconds: 3600,
        ...settings,
      });

    it('creates a Cron service, showing its command and schedule beyond the defaults', () => {
      const { steps } = planned(REPORT);

      expect(steps).toEqual([
        {
          action: 'create',
          configName: 'report',
          kind: 'cron',
          placement: PLATFORM,
          fields: [
            { field: 'command', from: null, to: 'node dist/report.js' },
            { field: 'schedule', from: null, to: '0 3 * * *' },
            {
              field: 'source',
              from: null,
              to: { github: 'acme/reports', path: '/' },
            },
          ],
        },
      ]);
    });

    it('shows a stated timezone and timeout on the create', () => {
      const { steps } = planned(
        `${REPORT}    timezone: Europe/Berlin\n    timeout: 30m\n`,
      );

      expect(steps[0]).toMatchObject({
        action: 'create',
        fields: expect.arrayContaining([
          { field: 'timezone', from: null, to: 'Europe/Berlin' },
          { field: 'timeout', from: null, to: '30m' },
        ]) as unknown,
      });
    });

    it('has nothing to change when the saved timetable says what the config says', () => {
      expect(planned(REPORT, [report()])).toEqual({
        ok: true,
        steps: [],
        notes: [],
      });
    });

    it('reads a timeout written another way as the same limit', () => {
      expect(planned(`${REPORT}    timeout: 60m\n`, [report()]).steps).toEqual(
        [],
      );
    });

    it.each([
      [
        'schedule',
        'schedule: "0 3 * * *"',
        'schedule: "*/30 * * * *"',
        '0 3 * * *',
        '*/30 * * * *',
      ],
      [
        'timezone',
        'source:',
        'timezone: Asia/Tokyo\n    source:',
        'UTC',
        'Asia/Tokyo',
      ],
      ['timeout', 'source:', 'timeout: 2h\n    source:', '1h', '2h'],
    ])('changes the %s in place', (field, before, after, from, to) => {
      const { steps } = planned(REPORT.replace(before, after), [report()]);

      expect(steps).toEqual([
        {
          action: 'change',
          configName: 'report',
          kind: 'cron',
          serviceType: 'application',
          serviceId: 'app-report',
          name: 'App report',
          fields: [{ field, from, to }],
        },
      ]);
    });

    it('destroys a web and creates a Cron service on a kind change to cron', () => {
      const web = savedApp('report', { owner: 'acme', repository: 'reports' });
      const { steps } = planned(REPORT, [web]);

      expect(actions(steps)).toEqual(['destroy report', 'create report']);
      expect(steps[1]).toMatchObject({ action: 'create', kind: 'cron' });
      expect(steps[0]).toMatchObject({ action: 'destroy', kind: 'web' });
    });

    it('destroys a Cron service and creates a web on a kind change from cron', () => {
      const web = [
        'version: 1',
        'services:',
        '  report:',
        '    kind: web',
        '    source:',
        '      github: acme/reports',
        '',
      ].join('\n');
      const { steps } = planned(web, [report()]);

      expect(actions(steps)).toEqual(['destroy report', 'create report']);
      expect(steps[1]).toMatchObject({ action: 'create', kind: 'web' });
      expect(steps[0]).toMatchObject({ action: 'destroy', kind: 'cron' });
    });
  });
});
