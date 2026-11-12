import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  domain,
  mount,
  postgres,
  redis,
} from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const connection = {
  name: 'Team GitHub',
  appName: 'cloudgate-app',
  appId: 12345,
  clientId: 'Iv1.abc123',
  clientSecret: 'github-client-secret',
  installationId: '99887766',
  privateKey:
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----',
  webhookSecret: 'wh-secret',
};

interface Refusal {
  code: string;
  message: string;
  pointer?: {
    repository: string;
    path: string;
    branch: string | null;
    fileUrl: unknown;
  };
}

interface LockedService {
  serviceType: string;
  serviceId: string;
  configName: string;
  owned: boolean;
  stated: string[];
  listed: Record<'env' | 'build_args' | 'build_secrets', string[]>;
  appliedFrom: { planId: string; commitSha: string | null } | null;
}

/**
 * US56–US59, US71: once a Project's config is kept in a repository,
 * the file is the one record of what it describes. A console or API write
 * that only the file can make — a config-owned setting, a new variable
 * name, a new Service of a kind the config describes, the Delete of a
 * Service it lists — is refused with a pointer to the file and branch, and
 * nothing is written. Cloudgate's own settings, variable values and
 * console-managed kinds are written as before.
 */
describe('Locks on a repository-kept config (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  let gitProviderId: string;
  let appId: string;
  let postgresId: string;

  const execMock = { execAsync: jest.fn(), execAsyncRemote: jest.fn() };
  const docker = {
    getService: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn(),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn().mockResolvedValue([{ Status: { State: 'running' } }]),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn().mockResolvedValue(docker) },
        },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const run = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { stdout: 'absent', stderr: '' }
        : { stdout: '', stderr: '' },
    );

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(run);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) => run(command));

    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    environmentId = await createEnvironment('production');

    const github = await ctx.app.get(GithubService).create(
      {
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      },
      connection,
    );
    gitProviderId = github.gitProvider.gitProviderId;

    // Described while the config is still Cloudgate's, so the copy the
    // repository is given describes them exactly.
    const app = await send('post', '/applications', {
      name: 'Web Shop',
      environmentId,
    });
    expect(app.status).toBe(201);
    appId = (app.body as { applicationId: string }).applicationId;
    await send('patch', `/applications/${appId}`, {
      sourceType: 'docker',
      dockerImage: 'nginx:1.27',
    }).expect(200);
    await send('patch', `/applications/${appId}/environment`, {
      env: 'API_KEY=one',
    }).expect(200);
    const db = await send('post', '/postgres', {
      name: 'Db',
      environmentId,
      databaseName: 'app',
      databaseUser: 'app',
    });
    expect(db.status).toBe(201);
    postgresId = (db.body as { postgresId: string }).postgresId;

    const text = await storedText();
    ctx.configReader.commit('acme/shop', text);
    await moveIn();
  });

  function send(
    method: 'post' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) {
    const call = request(server)[method](path).set('Cookie', cookie);
    return body ? call.send(body) : call;
  }

  async function createEnvironment(name: string) {
    const created = await send('post', '/environments', { name, projectId });
    expect(created.status).toBe(201);
    return (created.body as { environmentId: string }).environmentId;
  }

  async function storedText() {
    const config = await request(server)
      .get(`/projects/${projectId}/config`)
      .set('Cookie', cookie);
    expect(config.status).toBe(200);
    return (config.body as { location: { text: string } }).location.text;
  }

  async function moveIn() {
    const to = { kind: 'repository', gitProviderId, repository: 'acme/shop' };
    const previewed = await send(
      'post',
      `/projects/${projectId}/config/move/preview`,
      { to },
    );
    expect(previewed.status).toBe(200);
    const { reads } = previewed.body as { reads: unknown[] };
    await send('post', `/projects/${projectId}/config/move`, {
      to,
      reads,
    }).expect(200);
  }

  const POINTER = {
    repository: 'acme/shop',
    path: 'cloudgate.yaml',
    branch: 'main',
    // The file at the commit read, which the console links to.
    fileUrl: expect.stringMatching(
      /^https:\/\/git\.example\/acme\/shop\/blob\/c\d+\/cloudgate\.yaml$/,
    ) as unknown,
  };

  function expectRefused(
    res: request.Response,
    pointer: Refusal['pointer'] = POINTER,
  ) {
    expect(res.status).toBe(409);
    const body = res.body as Refusal;
    expect(body.code).toBe('PROJECT_CONFIG_REPOSITORY_KEPT');
    expect(body.pointer).toEqual(pointer);
    expect(body.message).toContain('acme/shop');
  }

  async function appRow() {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, appId));
    return row;
  }

  describe('settings', () => {
    it('refuses a config-owned edit with a pointer to the file and branch, writing nothing', async () => {
      const refused = await send('patch', `/applications/${appId}`, {
        command: 'npm start',
      });

      expectRefused(refused);
      expect((refused.body as Refusal).message).toContain('command');
      expect((await appRow()).command).toBeNull();
    });

    it("refuses a database's version the same way", async () => {
      const refused = await send('patch', `/postgres/${postgresId}`, {
        dockerImage: 'postgres:17',
      });

      expectRefused(refused);
      const [row] = await ctx.db
        .select({ dockerImage: postgres.dockerImage })
        .from(postgres)
        .where(eq(postgres.postgresId, postgresId));
      expect(row.dockerImage).not.toBe('postgres:17');
    });

    it("writes Cloudgate's own settings, and a request restating a config-owned value", async () => {
      const patched = await send('patch', `/applications/${appId}`, {
        autoDeploy: false,
        replicas: 2,
        dockerImage: 'nginx:1.27',
      });

      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ autoDeploy: false, replicas: 2 });
      await send('patch', `/postgres/${postgresId}`, {
        name: 'Main database',
        cpuReservation: '100000000',
      }).expect(200);
    });

    it('keeps a described Service’s Domains, mounts, Preview settings and branch editable', async () => {
      const cloudgateOwned = {
        branch: 'release',
        previewLimit: 2,
        previewPort: 8080,
      };

      await send('post', '/domains', {
        host: 'shop.example.com',
        applicationId: appId,
        domainType: 'application',
        port: 3000,
      }).expect(201);
      await send('post', '/mounts', {
        type: 'volume',
        volumeName: 'shop-data',
        mountPath: '/data',
        serviceId: appId,
      }).expect(201);
      await send('patch', `/applications/${appId}`, cloudgateOwned).expect(200);

      expect(await appRow()).toMatchObject(cloudgateOwned);
      const domains = await ctx.db
        .select({ host: domain.host, port: domain.port })
        .from(domain)
        .where(eq(domain.applicationId, appId));
      expect(domains).toEqual([{ host: 'shop.example.com', port: 3000 }]);
      const mounts = await ctx.db
        .select({ volumeName: mount.volumeName, mountPath: mount.mountPath })
        .from(mount)
        .where(eq(mount.applicationId, appId));
      expect(mounts).toEqual([{ volumeName: 'shop-data', mountPath: '/data' }]);
    });

    it('writes a Service the file lists as console-managed', async () => {
      const text = await currentCopy();
      const at = text.indexOf('  web-shop:');
      const next = text.indexOf('\n  db:', at);
      ctx.configReader.commit(
        'acme/shop',
        `${text.slice(0, at)}  web-shop:\n    kind: web\n    managed: console${text.slice(next)}`,
      );

      await send('patch', `/applications/${appId}`, {
        command: 'npm start',
      }).expect(200);
      expect((await appRow()).command).toBe('npm start');
    });

    it("refuses a config-owned edit while the file cannot be read, and still writes Cloudgate's own", async () => {
      ctx.configReader.setUnreachable('acme/shop', true);

      const refused = await send('patch', `/applications/${appId}`, {
        command: 'npm start',
      });
      expect(refused.status).toBe(409);
      expect((refused.body as Refusal).code).toBe('CONFIG_UNREADABLE');
      expect((await appRow()).command).toBeNull();

      await send('patch', `/applications/${appId}`, {
        autoDeploy: false,
      }).expect(200);
    });

    it('points at the Environment’s own Config branch', async () => {
      ctx.configReader.commit('acme/shop', await currentCopy(), {
        branch: 'release',
      });
      await send('patch', `/environments/${environmentId}`, {
        configBranch: 'release',
      }).expect(200);

      const refused = await send('patch', `/applications/${appId}`, {
        port: 8080,
      });

      expectRefused(refused, { ...POINTER, branch: 'release' });
    });
  });

  /**
   * On a described Service the seven Swarm settings are the file's
   * `native.docker`, so a console Save of one is refused with a pointer;
   * placement, networks, published ports, the mode and the replica count
   * are Cloudgate's and save as before.
   */
  describe('Swarm settings', () => {
    const HEALTH_CHECK = {
      Test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'],
      Retries: 5,
    };

    it("refuses a described web's health check with a pointer to the file, writing nothing", async () => {
      const refused = await send('patch', `/applications/${appId}`, {
        healthCheckSwarm: HEALTH_CHECK,
      });

      expectRefused(refused);
      expect((refused.body as Refusal).message).toContain(
        'native.docker.HealthCheck.Retries',
      );
      expect((await appRow()).healthCheckSwarm).toBeNull();
    });

    it("refuses a database's stop grace period the same way", async () => {
      const refused = await send('patch', `/postgres/${postgresId}`, {
        stopGracePeriodSwarm: 60_000_000_000,
      });

      expectRefused(refused);
      expect((refused.body as Refusal).message).toContain(
        'native.docker.StopGracePeriod',
      );
      const [row] = await ctx.db
        .select({ stopGracePeriodSwarm: postgres.stopGracePeriodSwarm })
        .from(postgres)
        .where(eq(postgres.postgresId, postgresId));
      expect(row.stopGracePeriodSwarm).toBeNull();
    });

    it('saves placement, networks, published ports, the mode and replicas, and a restated default', async () => {
      const patched = await send('patch', `/applications/${appId}`, {
        placementSwarm: { Constraints: ['node.role==worker'] },
        networkSwarm: [{ Target: 'shop-net' }],
        endpointSpecSwarm: {
          Ports: [{ TargetPort: 3000, PublishedPort: 8080 }],
        },
        modeSwarm: { Replicated: { Replicas: 2 } },
        replicas: 2,
        // The kind's own update settings, as the console's form sends them.
        updateConfigSwarm: {
          Parallelism: 1,
          Order: 'start-first',
          FailureAction: 'rollback',
        },
      });

      expect(patched.status).toBe(200);
      expect(await appRow()).toMatchObject({
        placementSwarm: { Constraints: ['node.role==worker'] },
        modeSwarm: { Replicated: { Replicas: 2 } },
        replicas: 2,
      });
    });

    it('saves the Swarm settings of a Service the file lists as console-managed', async () => {
      const text = await currentCopy();
      const at = text.indexOf('  web-shop:');
      const next = text.indexOf('\n  db:', at);
      ctx.configReader.commit(
        'acme/shop',
        `${text.slice(0, at)}  web-shop:\n    kind: web\n    managed: console${text.slice(next)}`,
      );

      await send('patch', `/applications/${appId}`, {
        healthCheckSwarm: HEALTH_CHECK,
      }).expect(200);
      expect((await appRow()).healthCheckSwarm).toEqual(HEALTH_CHECK);
    });
  });

  /** The text the repository's default branch holds. */
  async function currentCopy() {
    const copy = await request(server)
      .get(`/environments/${environmentId}/config`)
      .set('Cookie', cookie);
    return (copy.body as { copy: { text: string } }).copy.text;
  }

  describe('variables', () => {
    it('refuses a new variable name, and writes a changed value', async () => {
      const refused = await send(
        'patch',
        `/applications/${appId}/environment`,
        {
          env: 'API_KEY=one\nNEW_NAME=two',
        },
      );
      expectRefused(refused);
      expect((await appRow()).env).toBe('API_KEY=one');

      await send('patch', `/applications/${appId}/environment`, {
        env: 'API_KEY=rotated',
      }).expect(200);
      expect((await appRow()).env).toBe('API_KEY=rotated');
    });

    it('reads links as the file’s and refuses a link Save, pointing at the file', async () => {
      const shown = await request(server)
        .get(`/services/application/${appId}/links`)
        .set('Cookie', cookie);
      expect(shown.status).toBe(200);
      expect(shown.body).toMatchObject({
        keptIn: 'repository',
        editable: false,
        links: [],
        sources: [],
      });

      const [db] = await ctx.db
        .select({ configName: postgres.configName })
        .from(postgres)
        .where(eq(postgres.postgresId, postgresId));
      const refused = await request(server)
        .put(`/services/application/${appId}/links`)
        .set('Cookie', cookie)
        .send({
          links: [
            { name: 'DATABASE_URL', source: db.configName, output: 'url' },
          ],
        });
      expectRefused(refused);
      expect((refused.body as Refusal).message).toContain('env.DATABASE_URL');
      expect((await appRow()).configLinks).toEqual({});
    });
  });

  describe('creating', () => {
    // A `static` Service is an Application whose build type is static; the
    // create is refused before a build type could be set.
    it.each([
      ['web', 'applications', application, {}],
      ['static', 'applications', application, { buildType: 'static' }],
      [
        'postgres',
        'postgres',
        postgres,
        { databaseName: 'x', databaseUser: 'x' },
      ],
      ['redis', 'redis', redis, {}],
    ] as const)(
      'refuses a new %s, a kind the config describes, writing nothing',
      async (_kind, route, table, extra) => {
        const refused = await send('post', `/${route}`, {
          name: 'Extra',
          environmentId,
          ...extra,
        });

        expectRefused(refused);
        const written = await ctx.db
          .select({ name: table.name })
          .from(table)
          .where(eq(table.name, 'Extra'));
        expect(written).toEqual([]);
      },
    );

    it('creates a console-managed kind, and the next plan gives the line to paste', async () => {
      const made = await send('post', '/mongo', {
        name: 'Sessions',
        environmentId,
        databaseUser: 'app',
      });
      expect(made.status).toBe(201);

      const planned = await send('post', `/environments/${environmentId}/plan`);
      expect(planned.status).toBe(201);
      expect((planned.body as { notes: unknown[] }).notes).toContainEqual(
        expect.objectContaining({
          kind: 'console-managed-unlisted',
          configName: 'sessions',
          line: 'sessions:\n  kind: mongo\n  managed: console',
        }),
      );
    });
  });

  describe('deleting', () => {
    it('refuses the Delete of a listed Service before anything is torn down', async () => {
      const calls = execMock.execAsync.mock.calls.length;

      const refused = await send('delete', `/applications/${appId}`);

      expectRefused(refused);
      expect(await appRow()).toBeDefined();
      expect(execMock.execAsync.mock.calls.length).toBe(calls);
    });

    it('deletes a Service the config does not list', async () => {
      const made = await send('post', '/mongo', {
        name: 'Sessions',
        environmentId,
        databaseUser: 'app',
      });
      const { mongoId } = made.body as { mongoId: string };

      await send('delete', `/mongo/${mongoId}`).expect(200);
    });
  });

  describe('the whole-YAML edit', () => {
    it('is refused with the same pointer, on the default branch', async () => {
      const refused = await send(
        'post',
        `/projects/${projectId}/config/plans`,
        { text: 'version: 1\nservices: {}\n' },
      );

      expectRefused(refused);
    });
  });

  describe("an Environment's copy", () => {
    it('names the Services whose config-owned fields the file owns, and the commit each was last applied from', async () => {
      const copied = ctx.configReader.commit(
        'acme/shop',
        (await currentCopy()).replace('port: 3000', 'port: 8080'),
      );
      const planned = await send('post', `/environments/${environmentId}/plan`);
      const { planId } = planned.body as { planId: string };
      await send('post', `/environments/${environmentId}/plan/apply`, {
        planId,
      }).expect(200);

      const copy = await request(server)
        .get(`/environments/${environmentId}/config`)
        .set('Cookie', cookie);

      expect(copy.status).toBe(200);
      const services = (copy.body as { services: LockedService[] }).services;
      expect(services).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            serviceType: 'application',
            serviceId: appId,
            configName: 'web-shop',
            owned: true,
            // No size stated, so the caps stay the console's; the names it
            // lists may be given values.
            stated: [],
            listed: { env: ['API_KEY'], build_args: [], build_secrets: [] },
            appliedFrom: expect.objectContaining({
              planId,
              commitSha: copied,
            }) as unknown,
          }),
          expect.objectContaining({
            serviceType: 'postgres',
            serviceId: postgresId,
            owned: true,
            stated: ['database', 'user'],
            // Last written by a console Save while Cloudgate kept the
            // config: a plan, but no commit.
            appliedFrom: expect.objectContaining({
              commitSha: null,
            }) as unknown,
          }),
        ]),
      );
    });
  });
});
