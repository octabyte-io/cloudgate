import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GIT_CLONE_URL_MESSAGE } from '../../src/git-providers/git-clone-url';
import {
  parseProjectConfig,
  projectConfigJsonSchema,
  SIZES,
  sizeLimits,
} from '../../src/project-config';
import {
  defaultDatabaseIdentifier,
  defaultPostgresUser,
} from '../../src/project-config/format/config-wire';
import type { ConfigRefusal, ProjectConfig } from '../../src/project-config';

/**
 * The prototype on `prototype/project-config-format` (f44f90cc), with its size
 * placeholders replaced by the spec's size list. Kept beside this spec so the
 * served-schema e2e check reads the very same text.
 */
const SAMPLE = readFileSync(join(__dirname, 'cloudgate.sample.yaml'), 'utf8');

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

/** A one-Service config, so a refusal test states only what it is about. */
function oneService(name: string, entry: string): string {
  const indented = entry
    .trim()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return `version: 1\nservices:\n  ${name}:\n${indented}\n`;
}

describe('parseProjectConfig', () => {
  describe('the prototype-shaped sample', () => {
    it('reads every Service under its Config name with backend field names', () => {
      const config = parsed(SAMPLE);

      expect(config.version).toBe(1);
      expect(Object.keys(config.services)).toEqual([
        'web',
        'api',
        'docs',
        'worker-image',
        'postgres',
        'redis',
        'mongo-1',
      ]);
      expect(config.services.web).toEqual({
        kind: 'web',
        managed: false,
        size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
        source: {
          sourceType: 'github',
          repository: 'acme/shop',
          buildPath: 'apps/web',
        },
        build: { buildType: 'nixpacks' },
        port: 3000,
        env: ['DATABASE_URL', 'REDIS_URL', 'NEXT_PUBLIC_API_URL'],
        buildArgs: ['SENTRY_RELEASE'],
        buildSecrets: [],
      });
      expect(config.services.api).toMatchObject({
        build: {
          buildType: 'dockerfile',
          dockerfile: 'Dockerfile',
          dockerBuildStage: 'runtime',
        },
        command: 'node',
        args: ['dist/main.js'],
        port: 4000,
      });
      expect(config.services.docs).toEqual({
        kind: 'static',
        managed: false,
        source: {
          sourceType: 'github',
          repository: 'acme/shop',
          buildPath: 'apps/docs',
        },
        build: { publishDirectory: 'dist', isStaticSpa: false },
        env: [],
        buildArgs: [],
        buildSecrets: [],
      });
      expect(config.services['worker-image']).toMatchObject({
        source: {
          sourceType: 'docker',
          dockerImage: 'ghcr.io/acme/gotenberg:8',
        },
        port: 3000,
      });
      expect(config.services.postgres).toEqual({
        kind: 'postgres',
        managed: false,
        size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
        dockerImage: 'postgres:18',
        databaseName: 'shop',
        databaseUser: 'shop',
        env: [],
      });
      expect(config.services.redis).toEqual({
        kind: 'redis',
        managed: false,
        size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
        dockerImage: 'redis:8',
        env: [],
      });
      expect(config.services['mongo-1']).toEqual({
        kind: 'mongo',
        managed: 'console',
      });
    });
  });

  describe('version', () => {
    it('refuses a text with no version', () => {
      expect(refused('services: {}\n')).toMatchObject({
        reason: 'version',
        at: 'version',
      });
    });

    it('refuses an unknown version, naming it', () => {
      const refusal = refused(
        'version: 2\nservices:\n  web:\n    kind: web\n    nonsense: 1\n',
      );
      expect(refusal).toMatchObject({ reason: 'version', at: 'version' });
      expect(refusal.message).toContain('version 2');
      // Nothing about the version 2 file's fields: its version is the problem.
      expect(refusal.message).not.toContain('nonsense');
    });

    it('reads a config with no Services', () => {
      expect(parsed('version: 1\n').services).toEqual({});
      expect(parsed('version: 1\nservices:\n').services).toEqual({});
    });
  });

  describe('syntax', () => {
    it('refuses text that is not YAML, naming the line', () => {
      const refusal = refused('version: 1\nservices:\n  web: [unclosed\n');
      expect(refusal.reason).toBe('syntax');
      expect(refusal.message).toMatch(/line \d+/);
    });

    it('reads JSON, which is YAML', () => {
      const config = parsed(
        JSON.stringify({ version: 1, services: { cache: { kind: 'redis' } } }),
      );
      expect(config.services.cache).toEqual({
        kind: 'redis',
        managed: false,
        env: [],
      });
    });
  });

  describe('Config names', () => {
    it.each([['Web'], ['1web'], ['web_api'], ['-web'], ['a'.repeat(64)]])(
      'refuses %s as a Config name, naming it',
      (name) => {
        const refusal = refused(oneService(name, 'kind: redis'));
        expect(refusal).toMatchObject({ reason: 'invalid', at: name });
        expect(refusal.message).toContain(name);
      },
    );

    it('accepts a 63-character Config name', () => {
      const name = `a${'b'.repeat(62)}`;
      expect(
        Object.keys(parsed(oneService(name, 'kind: redis')).services),
      ).toEqual([name]);
    });
  });

  describe('kinds', () => {
    it('refuses a kind version 1 does not describe unless it is console-managed', () => {
      const refusal = refused(oneService('mongo-1', 'kind: mongo'));
      expect(refusal).toMatchObject({ reason: 'invalid', at: 'mongo-1.kind' });
      expect(refusal.message).toContain('managed: console');
    });

    it('refuses an entry with no kind', () => {
      expect(refused(oneService('web', 'port: 3000'))).toMatchObject({
        at: 'web.kind',
      });
    });

    it('lists an expressible kind as console-managed', () => {
      expect(
        parsed(oneService('web', 'kind: web\nmanaged: console')).services.web,
      ).toEqual({ kind: 'web', managed: 'console' });
    });

    it('refuses a console-managed entry that carries any other field', () => {
      const refusal = refused(
        oneService('mongo-1', 'kind: mongo\nmanaged: console\nsize: small'),
      );
      expect(refusal).toMatchObject({ reason: 'invalid', at: 'mongo-1.size' });
      expect(refusal.message).toContain('console-managed');
    });

    it('refuses a managed value other than console', () => {
      expect(
        refused(oneService('mongo-1', 'kind: mongo\nmanaged: config')),
      ).toMatchObject({ at: 'mongo-1.managed' });
    });

    it('refuses a Service entry that is not a map', () => {
      expect(refused('version: 1\nservices:\n  web: 3\n')).toMatchObject({
        at: 'web',
      });
    });
  });

  describe('worker', () => {
    it('reads a worker with every field it takes', () => {
      const worker = parsed(
        oneService(
          'jobs',
          [
            'kind: worker',
            'description: Sends the queued mail',
            'source:',
            '  github: acme/shop',
            '  path: /jobs',
            'build:',
            '  type: dockerfile',
            '  railpack_version: 0.15.4',
            '  heroku_version: "24"',
            '  dockerfile: jobs/Dockerfile',
            '  context: jobs',
            '  stage: runtime',
            '  publish: out',
            '  create_env_file: false',
            '  submodules: true',
            '  watch_paths: [jobs/**]',
            'command: node',
            'args: [worker.js]',
            'size: small',
            'env: [QUEUE_URL]',
            'build_args: [NODE_ENV]',
            'build_secrets: [NPM_TOKEN]',
          ].join('\n'),
        ),
      ).services.jobs;
      expect(worker).toEqual({
        kind: 'worker',
        managed: false,
        description: 'Sends the queued mail',
        source: {
          sourceType: 'github',
          repository: 'acme/shop',
          buildPath: '/jobs',
        },
        build: {
          buildType: 'dockerfile',
          railpackVersion: '0.15.4',
          herokuVersion: '24',
          dockerfile: 'jobs/Dockerfile',
          dockerContextPath: 'jobs',
          dockerBuildStage: 'runtime',
          publishDirectory: 'out',
          createEnvFile: false,
          enableSubmodules: true,
          watchPaths: ['jobs/**'],
        },
        command: 'node',
        args: ['worker.js'],
        size: { name: 'small', ...SIZES.small },
        env: ['QUEUE_URL'],
        buildArgs: ['NODE_ENV'],
        buildSecrets: ['NPM_TOKEN'],
      });
    });

    it('reads a worker from an image, with no command and no port', () => {
      const worker = parsed(
        oneService('jobs', 'kind: worker\nsource:\n  image: acme/jobs:1'),
      ).services.jobs;
      expect(worker).toEqual({
        kind: 'worker',
        managed: false,
        source: { sourceType: 'docker', dockerImage: 'acme/jobs:1' },
        env: [],
        buildArgs: [],
        buildSecrets: [],
      });
    });

    it.each([
      ['kind: worker\nport: 3000', 'jobs.port'],
      ['kind: worker\nreplicas: 2', 'jobs.replicas'],
      ['kind: worker\nbuild:\n  spa: true', 'jobs.build.spa'],
    ])('refuses %j, naming %s', (entry, at) => {
      const refusal = refused(oneService('jobs', entry));
      expect(refusal).toMatchObject({ reason: 'invalid', at });
      expect(refusal.message).toContain(at);
    });

    it('names worker among the kinds version 1 describes', () => {
      expect(refused(oneService('mongo-1', 'kind: mongo')).message).toContain(
        'worker',
      );
    });
  });

  describe('unknown fields', () => {
    it.each([
      ['web', 'kind: web\nreplicas: 2', 'web.replicas'],
      [
        'web',
        'kind: web\nbuild:\n  type: nixpacks\n  cache: true',
        'web.build.cache',
      ],
      [
        'web',
        'kind: web\nsource:\n  github: acme/shop\n  branch: main',
        'web.source.branch',
      ],
      ['docs', 'kind: static\nport: 8080', 'docs.port'],
      ['docs', 'kind: static\nbuild:\n  type: nixpacks', 'docs.build.type'],
      ['db', 'kind: postgres\npassword: hunter2', 'db.password'],
      ['cache', 'kind: redis\ndatabase: zero', 'cache.database'],
      [
        'web',
        'kind: web\nsize:\n  cpu: 1\n  memory: 1 GB\n  swap: 1 GB',
        'web.size.swap',
      ],
    ])('refuses an unknown field in %s, naming it', (name, entry, at) => {
      const refusal = refused(oneService(name, entry));
      expect(refusal).toMatchObject({ reason: 'invalid', at });
      expect(refusal.message).toContain(at);
    });

    it('refuses an unknown top-level field', () => {
      expect(refused('version: 1\nproject: shop\n')).toMatchObject({
        at: 'project',
      });
    });
  });

  describe('malformed entries', () => {
    it.each([
      ['web', 'kind: web\nport: http', 'web.port'],
      ['web', 'kind: web\nport: 70000', 'web.port'],
      ['web', 'kind: web\nbuild:\n  type: makefile', 'web.build.type'],
      ['web', 'kind: web\nenv: DATABASE_URL', 'web.env'],
      ['web', 'kind: web\nenv: ["DATABASE_URL=postgres://x"]', 'web.env.0'],
      ['web', 'kind: web\nenv: [A, A]', 'web.env'],
      ['web', 'kind: web\nsource:\n  github: shop', 'web.source.github'],
      ['web', 'kind: web\nsource: {}', 'web.source'],
      [
        'web',
        'kind: web\nsource:\n  github: acme/shop\n  image: nginx:1',
        'web.source',
      ],
      [
        'web',
        'kind: web\nsource:\n  image: "Not An Image"',
        'web.source.image',
      ],
      ['docs', 'kind: static\nsource:\n  image: nginx:1', 'docs.source'],
      [
        'docs',
        'kind: static\nbuild:\n  publish: ../../etc',
        'docs.build.publish',
      ],
      ['docs', 'kind: static\nbuild:\n  publish: /etc', 'docs.build.publish'],
      [
        'docs',
        'kind: static\nsource:\n  github: acme/docs\n  path: ../../..',
        'docs.source.path',
      ],
      [
        'web',
        'kind: web\nsource:\n  git: https://example.com/a.git\n  path: apps/../../etc',
        'web.source.path',
      ],
      [
        'web',
        'kind: web\nsource:\n  github: acme/shop\n  path: "apps/$(id)"',
        'web.source.path',
      ],
      ['db', 'kind: postgres\nversion: 18', 'db.version'],
      ['db', 'kind: postgres\ndatabase: ""', 'db.database'],
    ])('refuses a malformed %s entry, naming %s', (name, entry, at) => {
      const refusal = refused(oneService(name, entry));
      expect(refusal).toMatchObject({ reason: 'invalid', at });
      expect(refusal.message).toContain(at);
    });
  });

  describe('wired variables (ADR-0031)', () => {
    it('reads a one-key map in env as a link, beside plain names', () => {
      const config = parsed(
        oneService(
          'web',
          'kind: web\nenv: [NODE_ENV, { DATABASE_URL: pg-1.url }, { REDIS_HOST: redis.host }]',
        ),
      );
      expect(config.services.web).toMatchObject({
        env: ['NODE_ENV'],
        links: {
          DATABASE_URL: { source: 'pg-1', output: 'url' },
          REDIS_HOST: { source: 'redis', output: 'host' },
        },
      });
    });

    it('leaves links out of an entry that has none', () => {
      expect(
        parsed(oneService('web', 'kind: web\nenv: [NODE_ENV]')).services.web,
      ).not.toHaveProperty('links');
    });

    it('reads a link on a database entry too', () => {
      expect(
        parsed(oneService('db', 'kind: postgres\nenv: [{ CACHE: redis.url }]'))
          .services.db,
      ).toMatchObject({
        env: [],
        links: { CACHE: { source: 'redis', output: 'url' } },
      });
    });

    it.each([
      ['kind: web\nenv: [{ DATABASE_URL: pg-1 }]', 'web.env.0.DATABASE_URL'],
      ['kind: web\nenv: [{ DATABASE_URL: Pg.url }]', 'web.env.0.DATABASE_URL'],
      ['kind: web\nenv: [{ A: pg-1.url, B: pg-1.host }]', 'web.env.0'],
      ['kind: web\nenv: [{}]', 'web.env.0'],
      ['kind: web\nenv: [A, { A: pg-1.url }]', 'web.env'],
      ['kind: web\nenv: [{ A: pg-1.url }, { A: pg-1.host }]', 'web.env'],
    ])('refuses %j, naming %s', (entry, at) => {
      const refusal = refused(oneService('web', entry));
      expect(refusal).toMatchObject({ reason: 'invalid', at });
      expect(refusal.message).toContain(at);
    });

    it.each(['build_args', 'build_secrets'])(
      'refuses a link under %s: only env takes one',
      (list) => {
        const refusal = refused(
          oneService('web', `kind: web\n${list}: [{ DATABASE_URL: pg-1.url }]`),
        );
        expect(refusal).toMatchObject({ at: `web.${list}.0` });
        expect(refusal.message).toContain('only env takes a link');
      },
    );
  });

  describe('git sources', () => {
    it.each([
      ['https://ghp_token@github.com/acme/shop.git'],
      ['https://user:secret@gitlab.example.com/acme/shop.git'],
      ['ssh://git:secret@git.example.com/acme/shop.git'],
    ])('refuses %s, which carries a credential', (url) => {
      const refusal = refused(
        oneService('web', `kind: web\nsource:\n  git: "${url}"`),
      );
      expect(refusal).toMatchObject({
        reason: 'invalid',
        at: 'web.source.git',
      });
      expect(refusal.message).toContain('credential');
      // The credential is not repeated back in the refusal.
      expect(refusal.message).not.toContain('secret');
      expect(refusal.message).not.toContain('ghp_token');
    });

    /**
     * The console's clone URL rule, so a config cannot reach what a form
     * cannot: a `file://` URL clones any repository on the build host,
     * another tenant's checkout among them.
     */
    it.each([
      ['file:///etc/cloudgate/applications/other/code'],
      ['/etc/cloudgate/applications/other/code'],
      ['-oProxyCommand=touch@host:x'],
      ['not a url'],
    ])("refuses %s with the console's message", (url) => {
      const refusal = refused(
        oneService('web', `kind: web\nsource:\n  git: "${url}"`),
      );
      expect(refusal).toMatchObject({
        reason: 'invalid',
        at: 'web.source.git',
      });
      expect(refusal.message).toContain(GIT_CLONE_URL_MESSAGE);
    });

    it.each([
      ['https://github.com/acme/shop.git'],
      ['ssh://git@git.example.com/acme/shop.git'],
      ['git@github.com:acme/shop.git'],
    ])('reads %s, which carries none', (url) => {
      expect(
        parsed(
          oneService('web', `kind: web\nsource:\n  git: "${url}"\n  path: app`),
        ).services.web,
      ).toMatchObject({
        source: { sourceType: 'git', customGitUrl: url, buildPath: 'app' },
      });
    });

    it.each([['gitlab'], ['gitea'], ['bitbucket']])(
      'reads a %s source by owner/repo',
      (provider) => {
        expect(
          parsed(
            oneService(
              'web',
              `kind: web\nsource:\n  ${provider}: acme/group/shop`,
            ),
          ).services.web,
        ).toMatchObject({
          source: { sourceType: provider, repository: 'acme/group/shop' },
        });
      },
    );
  });

  describe('build fields', () => {
    it('maps each snake_case build field to its backend name', () => {
      const web = parsed(
        oneService(
          'web',
          [
            'kind: web',
            'description: The storefront',
            'build:',
            '  type: railpack',
            '  railpack_version: 0.15.4',
            '  heroku_version: "24"',
            '  dockerfile: docker/Dockerfile',
            '  context: docker',
            '  stage: runtime',
            '  publish: out',
            '  create_env_file: false',
            '  submodules: true',
            '  watch_paths: [apps/web/**]',
            'build_secrets: [NPM_TOKEN]',
          ].join('\n'),
        ),
      ).services.web;
      expect(web).toMatchObject({
        description: 'The storefront',
        build: {
          buildType: 'railpack',
          railpackVersion: '0.15.4',
          herokuVersion: '24',
          dockerfile: 'docker/Dockerfile',
          dockerContextPath: 'docker',
          dockerBuildStage: 'runtime',
          publishDirectory: 'out',
          createEnvFile: false,
          enableSubmodules: true,
          watchPaths: ['apps/web/**'],
        },
        buildSecrets: ['NPM_TOKEN'],
      });
    });

    it('defaults a web port to 3000', () => {
      expect(parsed(oneService('web', 'kind: web')).services.web).toMatchObject(
        { port: 3000 },
      );
    });

    it("leaves a missing size absent, so the caps stay Cloudgate's", () => {
      expect(
        parsed(oneService('web', 'kind: web')).services.web,
      ).not.toHaveProperty('size');
    });
  });

  describe('mysql', () => {
    it('reads every field a mysql entry takes, as a postgres takes them', () => {
      expect(
        parsed(
          oneService(
            'shop-db',
            [
              'kind: mysql',
              'version: "8.4"',
              'database: shop',
              'user: shop_app',
              'description: Orders',
              'size: small',
              'env: [TZ]',
            ].join('\n'),
          ),
        ).services['shop-db'],
      ).toEqual({
        kind: 'mysql',
        managed: false,
        description: 'Orders',
        size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
        env: ['TZ'],
        dockerImage: 'mysql:8.4',
        databaseName: 'shop',
        databaseUser: 'shop_app',
      });
    });

    it('leaves an unstated version, database and user to the plan', () => {
      expect(
        parsed(oneService('shop-db', 'kind: mysql')).services['shop-db'],
      ).toEqual({ kind: 'mysql', managed: false, env: [] });
    });

    it.each(['root_password', 'charset', 'collation', 'password'])(
      'refuses %s on a mysql, naming it',
      (field) => {
        const refusal = refused(
          oneService('shop-db', `kind: mysql\n${field}: x`),
        );
        expect(refusal).toMatchObject({
          reason: 'invalid',
          at: `shop-db.${field}`,
        });
      },
    );

    it('refuses an unquoted version, which YAML reads as a number', () => {
      const refusal = refused(
        oneService('shop-db', 'kind: mysql\nversion: 8.4'),
      );
      expect(refusal).toMatchObject({
        reason: 'invalid',
        at: 'shop-db.version',
      });
      expect(refusal.message).toContain('quoted');
    });

    it('accepts user: root', () => {
      expect(
        parsed(oneService('shop-db', 'kind: mysql\nuser: root')).services[
          'shop-db'
        ],
      ).toMatchObject({ databaseUser: 'root' });
    });

    it('refuses a written user over 32 characters, asking for a shorter user:', () => {
      const user = 'u'.repeat(33);
      const refusal = refused(
        oneService('shop-db', `kind: mysql\nuser: ${user}`),
      );
      expect(refusal).toMatchObject({ reason: 'invalid', at: 'shop-db.user' });
      expect(refusal.message).toContain('32');
      expect(refusal.message).toContain('user:');
    });

    it('accepts a written user of exactly 32 characters', () => {
      const user = 'u'.repeat(32);
      expect(
        parsed(oneService('shop-db', `kind: mysql\nuser: ${user}`)).services[
          'shop-db'
        ],
      ).toMatchObject({ databaseUser: user });
    });

    it('refuses a Config name over 32 characters with no user, asking for user: and never shortening it', () => {
      const name = `orders-${'a'.repeat(26)}`; // 33 characters
      const refusal = refused(oneService(name, 'kind: mysql'));
      expect(refusal).toMatchObject({ reason: 'invalid', at: `${name}.user` });
      expect(refusal.message).toContain(name.replaceAll('-', '_'));
      expect(refusal.message).toContain('user:');
    });

    it('takes a long Config name once user: is written', () => {
      const name = `orders-${'a'.repeat(26)}`;
      expect(
        parsed(oneService(name, 'kind: mysql\nuser: orders')).services[name],
      ).toMatchObject({ databaseUser: 'orders' });
    });

    it('leaves a long postgres Config name alone; the rule is MySQL’s', () => {
      const name = `orders-${'a'.repeat(26)}`;
      expect(parsed(oneService(name, 'kind: postgres')).services[name]).toEqual(
        { kind: 'postgres', managed: false, env: [] },
      );
    });

    it('still takes MariaDB only as console-managed', () => {
      const refusal = refused(oneService('maria', 'kind: mariadb'));
      expect(refusal).toMatchObject({ at: 'maria.kind' });
      expect(refusal.message).toContain('mysql');
      expect(
        parsed(oneService('maria', 'kind: mariadb\nmanaged: console')).services
          .maria,
      ).toEqual({ kind: 'mariadb', managed: 'console' });
    });

    it('still takes a mysql listed as console-managed', () => {
      expect(
        parsed(oneService('shop-db', 'kind: mysql\nmanaged: console')).services[
          'shop-db'
        ],
      ).toEqual({ kind: 'mysql', managed: 'console' });
    });
  });

  describe('postgres users', () => {
    it.each(['pg_admin', 'PG_admin', 'pg_'])(
      'refuses a written user %s, since PostgreSQL reserves the prefix',
      (user) => {
        const refusal = refused(
          oneService('db', `kind: postgres\nuser: ${user}`),
        );
        expect(refusal).toMatchObject({ reason: 'invalid', at: 'db.user' });
        expect(refusal.message).toBe(
          'db.user: PostgreSQL reserves role names starting with pg_; choose another user:',
        );
      },
    );

    it('takes pg-1 with no user, and a database named pg_1', () => {
      expect(
        parsed(oneService('pg-1', 'kind: postgres\ndatabase: pg_1')).services[
          'pg-1'
        ],
      ).toMatchObject({ databaseName: 'pg_1' });
    });

    it('refuses a pg- Config name whose app_ default user passes 63 characters, asking for user:', () => {
      const name = `pg-${'a'.repeat(57)}`; // 60 characters, so app_pg_… is 64
      const refusal = refused(oneService(name, 'kind: postgres'));
      expect(refusal).toMatchObject({ reason: 'invalid', at: `${name}.user` });
      expect(refusal.message).toContain(`app_${name.replaceAll('-', '_')}`);
      expect(refusal.message).toContain('write a user:');
    });

    it('takes a pg- Config name whose app_ default user is exactly 63 characters', () => {
      const name = `pg-${'a'.repeat(56)}`;
      expect(parsed(oneService(name, 'kind: postgres')).services[name]).toEqual(
        { kind: 'postgres', managed: false, env: [] },
      );
    });

    it('takes that long Config name once user: is written', () => {
      const name = `pg-${'a'.repeat(57)}`;
      expect(
        parsed(oneService(name, 'kind: postgres\nuser: app')).services[name],
      ).toMatchObject({ databaseUser: 'app' });
    });

    it('leaves a mysql user pg_admin alone; the rule is PostgreSQL’s', () => {
      expect(
        parsed(oneService('db', 'kind: mysql\nuser: pg_admin')).services.db,
      ).toMatchObject({ databaseUser: 'pg_admin' });
    });
  });

  describe('defaultPostgresUser', () => {
    it.each([
      ['pg-1', 'app_pg_1'],
      ['pg_1', 'app_pg_1'],
      ['orders-db', 'orders_db'],
      ['pgdb', 'pgdb'],
    ])('%s defaults to %s', (name, user) => {
      expect(defaultPostgresUser(name)).toBe(user);
    });

    it('leaves the default database name pg_1', () => {
      expect(defaultDatabaseIdentifier('pg-1')).toBe('pg_1');
    });
  });

  describe('web-private', () => {
    it('reads every web field, with its stated port', () => {
      const api = parsed(
        oneService(
          'api',
          [
            'kind: web-private',
            'description: The internal API',
            'size: small',
            'source:',
            '  github: acme/api',
            '  path: apps/api',
            'command: node',
            'args: [dist/main.js]',
            'port: 4000',
            'env: [DATABASE_URL]',
            'build_args: [SENTRY_RELEASE]',
            'build_secrets: [NPM_TOKEN]',
            'build:',
            '  type: dockerfile',
            '  railpack_version: 0.15.4',
            '  heroku_version: "24"',
            '  dockerfile: docker/Dockerfile',
            '  context: docker',
            '  stage: runtime',
            '  publish: out',
            '  create_env_file: false',
            '  submodules: true',
            '  watch_paths: [apps/api/**]',
          ].join('\n'),
        ),
      ).services.api;
      expect(api).toEqual({
        kind: 'web-private',
        managed: false,
        description: 'The internal API',
        size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
        source: {
          sourceType: 'github',
          repository: 'acme/api',
          buildPath: 'apps/api',
        },
        command: 'node',
        args: ['dist/main.js'],
        port: 4000,
        env: ['DATABASE_URL'],
        buildArgs: ['SENTRY_RELEASE'],
        buildSecrets: ['NPM_TOKEN'],
        build: {
          buildType: 'dockerfile',
          railpackVersion: '0.15.4',
          herokuVersion: '24',
          dockerfile: 'docker/Dockerfile',
          dockerContextPath: 'docker',
          dockerBuildStage: 'runtime',
          publishDirectory: 'out',
          createEnvFile: false,
          enableSubmodules: true,
          watchPaths: ['apps/api/**'],
        },
      });
    });

    it('reads an image source', () => {
      expect(
        parsed(
          oneService(
            'api',
            'kind: web-private\nport: 8080\nsource:\n  image: nginx:1.27',
          ),
        ).services.api,
      ).toMatchObject({
        source: { sourceType: 'docker', dockerImage: 'nginx:1.27' },
      });
    });

    it('refuses one with no port, naming it and pointing to worker', () => {
      const refusal = refused(oneService('api', 'kind: web-private'));
      expect(refusal).toMatchObject({ reason: 'invalid', at: 'api.port' });
      expect(refusal.message).toContain('api.port is required');
      expect(refusal.message).toContain('kind: worker');
    });

    it('refuses an unknown field, naming it', () => {
      const refusal = refused(
        oneService('api', 'kind: web-private\nport: 4000\ndomain: api.test'),
      );
      expect(refusal).toMatchObject({ reason: 'invalid', at: 'api.domain' });
      expect(refusal.message).toContain('not a field Cloudgate knows');
    });

    it('names web-private among the kinds version 1 describes', () => {
      expect(refused(oneService('mongo-1', 'kind: mongo')).message).toContain(
        'web-private',
      );
    });
  });

  describe('sizes', () => {
    // From the spec's size list, not from SIZES.
    it.each([
      ['xsmall', 0.25, 512],
      ['small', 0.5, 1024],
      ['medium', 1, 2048],
      ['large', 2, 4096],
      ['xlarge', 4, 8192],
      ['2xlarge', 8, 16384],
    ])('reads %s as %s CPU and %s MB', (name, cpu, memoryMb) => {
      expect(
        parsed(oneService('db', `kind: postgres\nsize: ${name}`)).services.db,
      ).toMatchObject({ size: { name, cpu, memoryMb } });
    });

    it.each([
      ['1.5', '768 MB', 1.5, 768],
      ['3', '6GB', 3, 6144],
      ['0.75', '1.5 GB', 0.75, 1536],
    ])(
      'reads a custom pair of %s CPU and %s',
      (cpu, memory, cpuOut, memoryMb) => {
        const web = parsed(
          oneService(
            'web',
            `kind: web\nsize:\n  cpu: ${cpu}\n  memory: ${memory}`,
          ),
        ).services.web;
        expect(web).toMatchObject({ size: { cpu: cpuOut, memoryMb } });
        expect(web).not.toHaveProperty('size.name');
      },
    );

    it.each([
      ['size: huge', 'web.size'],
      ['size:\n  cpu: 1', 'web.size.memory'],
      ['size:\n  memory: 1 GB', 'web.size.cpu'],
      ['size:\n  cpu: 0\n  memory: 1 GB', 'web.size.cpu'],
      ['size:\n  cpu: 1\n  memory: 1024', 'web.size.memory'],
      ['size:\n  cpu: 1\n  memory: 1 TB', 'web.size.memory'],
      ['size:\n  cpu: 1\n  memory: 0.3 MB', 'web.size.memory'],
    ])('refuses %j, naming %s', (size, at) => {
      expect(refused(oneService('web', `kind: web\n${size}`))).toMatchObject({
        reason: 'invalid',
        at,
      });
    });
  });
});

describe('parseProjectConfig native.docker', () => {
  it('reads a native.docker block as written, in Docker’s own spelling', () => {
    const web = parsed(
      oneService(
        'web',
        [
          'kind: web',
          'native:',
          '  docker:',
          '    HealthCheck:',
          '      Test: [CMD, curl, -f, http://localhost:3000/health]',
          '      Interval: 10000000000',
          '      Retries: 3',
          '    Labels:',
          '      com.example.team: payments',
          '    StopGracePeriod: 20000000000',
        ].join('\n'),
      ),
    ).services.web;

    expect(web).toMatchObject({
      native: {
        docker: {
          HealthCheck: {
            Test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'],
            Interval: 10_000_000_000,
            Retries: 3,
          },
          Labels: { 'com.example.team': 'payments' },
          StopGracePeriod: 20_000_000_000,
        },
      },
    });
  });

  it('leaves a key outside the seven to the plan, which refuses it with its reason', () => {
    const web = parsed(
      oneService('web', 'kind: web\nnative:\n  docker:\n    Privileged: true'),
    ).services.web;
    expect(web).toMatchObject({ native: { docker: { Privileged: true } } });
  });

  it.each([
    [
      'web.native.docker.HealthCheck.Retries',
      'HealthCheck:\n      Retries: five',
    ],
    [
      'web.native.docker.HealthCheck.Interval',
      'HealthCheck:\n      Interval: 1.5',
    ],
    [
      'web.native.docker.HealthCheck.Test',
      'HealthCheck:\n      Test: CMD true',
    ],
    ['web.native.docker.HealthCheck.Probe', 'HealthCheck:\n      Probe: 1'],
    ['web.native.docker.StopGracePeriod', 'StopGracePeriod: 10s'],
    ['web.native.docker.Labels.team', 'Labels:\n      team: [a]'],
  ])('refuses a malformed value at %s', (at, value) => {
    const refusal = refused(
      oneService('web', `kind: web\nnative:\n  docker:\n    ${value}`),
    );
    expect(refusal).toMatchObject({ reason: 'invalid', at });
  });

  it('refuses a native block other than docker, aws and gcp as one Cloudgate does not know', () => {
    expect(
      refused(oneService('web', 'kind: web\nnative:\n  azure: {}')),
    ).toMatchObject({ reason: 'invalid', at: 'web.native.azure' });
  });

  it('refuses a native block on a console-managed entry', () => {
    const refusal = refused(
      oneService(
        'web',
        'kind: web\nmanaged: console\nnative:\n  docker:\n    Labels: {}',
      ),
    );
    expect(refusal).toMatchObject({ reason: 'invalid', at: 'web.native' });
    expect(refusal.message).toContain('console-managed');
  });

  it('is shown by the served JSON Schema on a described entry, and version stays 1', () => {
    const schema = JSON.stringify(projectConfigJsonSchema());
    for (const key of [
      'Labels',
      'HealthCheck',
      'RestartPolicy',
      'UpdateConfig',
      'RollbackConfig',
      'StopGracePeriod',
      'Ulimits',
    ]) {
      expect(schema).toContain(`"${key}"`);
    }
    expect(projectConfigJsonSchema()).toMatchObject({
      properties: { version: { const: 1 } },
    });
  });
});

describe('parseProjectConfig native.aws', () => {
  it('reads a native.aws block as written, keyed by full address, the container as one object', () => {
    const web = parsed(
      oneService(
        'web',
        [
          'kind: web',
          'native:',
          '  aws:',
          '    aws_ecs_service.service:',
          '      health_check_grace_period_seconds: 60',
          '    aws_ecs_task_definition.service:',
          '      container_definitions:',
          '        stopTimeout: 30',
          '        healthCheck:',
          '          command: [CMD-SHELL, curl -f localhost]',
        ].join('\n'),
      ),
    ).services.web;

    expect(web).toMatchObject({
      native: {
        aws: {
          'aws_ecs_service.service': { health_check_grace_period_seconds: 60 },
          'aws_ecs_task_definition.service': {
            container_definitions: {
              stopTimeout: 30,
              healthCheck: { command: ['CMD-SHELL', 'curl -f localhost'] },
            },
          },
        },
      },
    });
  });

  it('leaves an address and an argument to the plan, which refuses them by path with a reason', () => {
    const web = parsed(
      oneService(
        'web',
        'kind: web\nnative:\n  aws:\n    aws_vpc.network:\n      cidr_blokc: 10.0.0.0/16',
      ),
    ).services.web;
    expect(web).toMatchObject({
      native: { aws: { 'aws_vpc.network': { cidr_blokc: '10.0.0.0/16' } } },
    });
  });

  it('refuses an address written as anything but its arguments', () => {
    const refusal = refused(
      oneService(
        'web',
        'kind: web\nnative:\n  aws:\n    aws_ecs_service.service: 60',
      ),
    );
    expect(refusal).toMatchObject({ reason: 'invalid' });
    expect(refusal.at).toMatch(/^web\.native\.aws/);
  });

  it('is shown by the served JSON Schema on a described entry, and version stays 1', () => {
    const schema = projectConfigJsonSchema() as {
      $defs?: Record<string, unknown>;
    };
    const text = JSON.stringify(schema);
    expect(text).toContain('"aws":');
    expect(text).toContain('aws_ecs_task_definition.service');
    expect(schema).toMatchObject({ properties: { version: { const: 1 } } });
  });
});

describe('parseProjectConfig native.gcp', () => {
  it('reads a native.gcp block as written, keyed by full address, the container as one object', () => {
    const web = parsed(
      oneService(
        'web',
        [
          'kind: web',
          'native:',
          '  gcp:',
          '    google_cloud_run_v2_service.service:',
          '      ingress: INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
          '      template:',
          '        max_instance_request_concurrency: 40',
          '        containers:',
          '          resources:',
          '            cpu_idle: false',
        ].join('\n'),
      ),
    ).services.web;

    expect(web).toMatchObject({
      native: {
        gcp: {
          'google_cloud_run_v2_service.service': {
            ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
            template: {
              max_instance_request_concurrency: 40,
              containers: { resources: { cpu_idle: false } },
            },
          },
        },
      },
    });
  });

  it('leaves an address and an argument to the plan, which refuses them by path with a reason', () => {
    const web = parsed(
      oneService(
        'web',
        'kind: web\nnative:\n  gcp:\n    google_compute_network.network:\n      mtuu: 1500',
      ),
    ).services.web;
    expect(web).toMatchObject({
      native: { gcp: { 'google_compute_network.network': { mtuu: 1500 } } },
    });
  });

  it('refuses an address written as anything but its arguments', () => {
    const refusal = refused(
      oneService(
        'web',
        'kind: web\nnative:\n  gcp:\n    google_cloud_run_v2_service.service: 60',
      ),
    );
    expect(refusal).toMatchObject({ reason: 'invalid' });
    expect(refusal.at).toMatch(/^web\.native\.gcp/);
  });

  it('is shown by the served JSON Schema on a described entry, and version stays 1', () => {
    const schema = projectConfigJsonSchema() as {
      $defs?: Record<string, unknown>;
    };
    const text = JSON.stringify(schema);
    expect(text).toContain('"gcp":');
    expect(text).toContain('google_cloud_run_v2_service.service');
    expect(schema).toMatchObject({ properties: { version: { const: 1 } } });
  });
});

describe('sizeLimits', () => {
  // Docker's NanoCPUs and MemoryBytes, worked by hand: 0.5 CPU is 5e8 nano
  // CPUs, and 1 GB is 1024 * 1024 * 1024 bytes.
  it.each([
    ['xsmall', '250000000', '536870912'],
    ['small', '500000000', '1073741824'],
    ['medium', '1000000000', '2147483648'],
    ['large', '2000000000', '4294967296'],
    ['xlarge', '4000000000', '8589934592'],
    ['2xlarge', '8000000000', '17179869184'],
  ] as const)(
    'gives %s as cpuLimit %s and memoryLimit %s',
    (name, cpuLimit, memoryLimit) => {
      expect(sizeLimits(SIZES[name])).toEqual({ cpuLimit, memoryLimit });
    },
  );

  it('gives a custom pair in the same units', () => {
    expect(sizeLimits({ cpu: 1.5, memoryMb: 768 })).toEqual({
      cpuLimit: '1500000000',
      memoryLimit: '805306368',
    });
  });
});
