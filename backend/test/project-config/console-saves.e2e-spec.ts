import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse } from 'yaml';

import {
  application,
  deployment,
  mysql,
  plan as planTable,
  postgres,
  projectConfigLocation,
} from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

interface PlanBody {
  planId: string;
  environmentId: string;
  source: string;
  status: string;
  steps: {
    action: string;
    configName: string;
    fields?: { field: string; from: unknown; to: unknown }[];
  }[];
  results:
    | {
        configName: string;
        action: string;
        status: string;
        serviceId: string | null;
        leftovers: Record<string, unknown> | null;
      }[]
    | null;
}

type Entry = Record<string, unknown>;

/**
 * On a Cloudgate-kept config, a console Save that touches a
 * config-owned field is a `save` plan the Save applies — the stored text is
 * rewritten for that one entry and the plan is recorded applied — while a
 * Save of Cloudgate's own fields writes directly. Either way the console
 * answers as it always has, and "Check for changes" then finds nothing.
 */
describe('Console saves on a Cloudgate-kept config (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
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

  beforeEach(async () => {
    await ctx.resetDb();
    const run = (command: string) =>
      Promise.resolve(
        isPresenceProbe(command)
          ? { stdout: 'absent', stderr: '' }
          : { stdout: '', stderr: '' },
      );
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

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    environmentId = await createEnvironment('production');
  });

  async function createEnvironment(name: string) {
    const created = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name, projectId });
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

  async function entries(): Promise<Record<string, Entry>> {
    const parsed = parse(await storedText()) as {
      services: Record<string, Entry>;
    };
    return parsed.services;
  }

  /** "Check for changes" in an Environment. */
  async function checkForChanges(id = environmentId) {
    const planned = await request(server)
      .post(`/environments/${id}/plan`)
      .set('Cookie', cookie);
    expect(planned.status).toBe(201);
    return planned.body as PlanBody;
  }

  async function savePlans() {
    return (await ctx.db
      .select()
      .from(planTable)
      .where(eq(planTable.source, 'save'))
      .orderBy(planTable.createdAt)) as unknown as PlanBody[];
  }

  async function createApplication(name: string, env = environmentId) {
    const created = await request(server)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ name, environmentId: env });
    expect(created.status).toBe(201);
    return created.body as { applicationId: string; configName: string };
  }

  describe('creating', () => {
    it('adds a console-created Application to the config under its Config name, as an applied save plan', async () => {
      const app = await createApplication('Web Shop');

      expect(app.configName).toBe('web-shop');
      expect((await entries())['web-shop']).toMatchObject({
        kind: 'web',
        port: 3000,
      });
      const [saved] = await savePlans();
      expect(saved).toMatchObject({ environmentId, status: 'applied' });
      expect(saved.steps).toEqual([
        expect.objectContaining({ action: 'create', configName: 'web-shop' }),
      ]);
      expect(saved.results).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'web-shop',
          status: 'applied',
          serviceId: app.applicationId,
        }),
      ]);
      const [row] = await ctx.db
        .select({ configPlanId: application.configPlanId })
        .from(application);
      expect(row.configPlanId).toBe(saved.planId);
      expect((await checkForChanges()).status).toBe('unchanged');
    });
  });

  /** Stores `text` through the whole-YAML edit, which changes nothing. */
  async function storeText(text: string) {
    const saved = await request(server)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    expect((saved.body as { stored: boolean }).stored).toBe(true);
  }

  const patchApplication = (id: string, body: object) =>
    request(server)
      .patch(`/applications/${id}`)
      .set('Cookie', cookie)
      .send(body);

  describe('updating', () => {
    it('rewrites only the touched fields of the entry, keeping the comments, as an applied save plan', async () => {
      const app = await createApplication('Web Shop');
      await createApplication('Admin');
      const commented = (await storedText())
        .replace('  web-shop:', '  # the storefront\n  web-shop:')
        .replace('version: 1', '# kept by hand\nversion: 1');
      await storeText(commented);

      const patched = await patchApplication(app.applicationId, {
        command: 'npm start',
        port: 8080,
      });

      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ command: 'npm start', port: 8080 });
      const text = await storedText();
      expect(text).toContain('# the storefront\n  web-shop:');
      expect(text).toContain('# kept by hand\nversion: 1');
      expect((await entries())['web-shop']).toMatchObject({
        kind: 'web',
        command: 'npm start',
        port: 8080,
      });
      const saved = (await savePlans()).at(-1)!;
      expect(saved.status).toBe('applied');
      expect(saved.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'web-shop',
          fields: expect.arrayContaining([
            { field: 'command', from: null, to: 'npm start' },
            { field: 'port', from: 3000, to: 8080 },
          ]) as unknown,
        }),
      ]);
      expect(saved.results).toEqual([
        expect.objectContaining({
          action: 'change',
          status: 'applied',
          serviceId: app.applicationId,
        }),
      ]);
      const [row] = await ctx.db
        .select({ configPlanId: application.configPlanId })
        .from(application)
        .where(eq(application.applicationId, app.applicationId));
      expect(row.configPlanId).toBe(saved.planId);
      expect((await checkForChanges()).status).toBe('unchanged');
    });

    it('writes a Cloudgate-owned field directly, leaving the config and recording no plan', async () => {
      const app = await createApplication('Web Shop');
      const text = await storedText();
      const plans = (await savePlans()).length;

      const patched = await patchApplication(app.applicationId, {
        autoDeploy: false,
        branch: 'release',
        replicas: 3,
      });

      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        autoDeploy: false,
        branch: 'release',
        replicas: 3,
      });
      expect(await storedText()).toBe(text);
      expect(await savePlans()).toHaveLength(plans);
      expect((await checkForChanges()).status).toBe('unchanged');
    });

    it('adds a new variable name to the entry, and never a value', async () => {
      const app = await createApplication('Web Shop');

      const saved = await request(server)
        .patch(`/applications/${app.applicationId}/environment`)
        .set('Cookie', cookie)
        .send({ env: 'API_KEY=s3cret\nLOG_LEVEL=debug' });

      expect(saved.status).toBe(200);
      expect((await entries())['web-shop'].env).toEqual([
        'API_KEY',
        'LOG_LEVEL',
      ]);
      expect(await storedText()).not.toContain('s3cret');
      expect((await checkForChanges()).status).toBe('unchanged');

      // A changed value alone is Cloudgate's.
      const text = await storedText();
      const plans = (await savePlans()).length;
      await request(server)
        .patch(`/applications/${app.applicationId}/environment`)
        .set('Cookie', cookie)
        .send({ env: 'API_KEY=rotated\nLOG_LEVEL=debug' })
        .expect(200);
      expect(await storedText()).toBe(text);
      expect(await savePlans()).toHaveLength(plans);
    });

    it('rewrites the source, and a build type that changes the kind as one change', async () => {
      const app = await createApplication('Web Shop');

      await patchApplication(app.applicationId, {
        sourceType: 'docker',
        dockerImage: 'nginx:1.27',
      }).expect(200);
      expect((await entries())['web-shop'].source).toEqual({
        image: 'nginx:1.27',
      });

      await patchApplication(app.applicationId, {
        sourceType: 'git',
        customGitUrl: 'https://example.com/shop.git',
        buildType: 'static',
        publishDirectory: 'dist',
      }).expect(200);

      expect((await entries())['web-shop']).toMatchObject({
        kind: 'static',
        source: { git: 'https://example.com/shop.git' },
        build: { publish: 'dist' },
      });
      const saved = (await savePlans()).at(-1)!;
      expect(saved.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'web-shop',
          fields: [{ field: 'kind', from: 'web', to: 'static' }],
        }),
      ]);
      expect(await ctx.db.select().from(application)).toHaveLength(1);
      expect((await checkForChanges()).status).toBe('unchanged');
      // The row records the kind the Save wrote, and switching the
      // build type back records the change the other way.
      const kindOf = async () =>
        (
          await ctx.db
            .select({ configKind: application.configKind })
            .from(application)
        )[0].configKind;
      expect(await kindOf()).toBe('static');

      await patchApplication(app.applicationId, {
        buildType: 'dockerfile',
      }).expect(200);

      expect((await entries())['web-shop']).toMatchObject({ kind: 'web' });
      expect((await savePlans()).at(-1)!.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'web-shop',
          fields: [{ field: 'kind', from: 'static', to: 'web' }],
        }),
      ]);
      expect(await kindOf()).toBe('web');
      expect((await checkForChanges()).status).toBe('unchanged');
    });

    it('rewrites a database version from its console page', async () => {
      const made = await request(server)
        .post('/postgres')
        .set('Cookie', cookie)
        .send({
          name: 'Orders DB',
          environmentId,
          databaseName: 'orders',
          databaseUser: 'shop',
        });
      expect(made.status).toBe(201);
      const { postgresId } = made.body as { postgresId: string };

      const patched = await request(server)
        .patch(`/postgres/${postgresId}`)
        .set('Cookie', cookie)
        .send({ dockerImage: 'postgres:17' });

      expect(patched.status).toBe(200);
      expect((await entries())['orders-db']).toMatchObject({
        kind: 'postgres',
        version: '17',
      });
      const saved = (await savePlans()).at(-1)!;
      expect(saved.steps).toEqual([
        expect.objectContaining({ action: 'change', configName: 'orders-db' }),
      ]);
      const [row] = await ctx.db
        .select({ configPlanId: postgres.configPlanId })
        .from(postgres);
      expect(row.configPlanId).toBe(saved.planId);
      expect((await checkForChanges()).status).toBe('unchanged');
    });

    describe('a MySQL handed over to the config', () => {
      /** A console-made MySQL whose entry the operator has since described. */
      async function handedOver() {
        const made = await request(server)
          .post('/mysql')
          .set('Cookie', cookie)
          .send({
            name: 'Shop DB',
            environmentId,
            databaseName: 'legacy',
            databaseUser: 'root',
            dockerImage: 'mysql:8',
          });
        expect(made.status).toBe(201);
        expect((await entries())['shop-db']).toEqual({
          kind: 'mysql',
          managed: 'console',
        });
        await ctx.db
          .update(projectConfigLocation)
          .set({
            text: 'version: 1\nservices:\n  # handed over\n  shop-db:\n    kind: mysql\n    version: "8"\n',
          })
          .where(eq(projectConfigLocation.projectId, projectId));
        expect((await checkForChanges()).status).toBe('unchanged');
        return (made.body as { mysqlId: string }).mysqlId;
      }

      it('keeps it described when its description is edited in the console', async () => {
        const mysqlId = await handedOver();

        const patched = await request(server)
          .patch(`/mysql/${mysqlId}`)
          .set('Cookie', cookie)
          .send({ description: 'Orders' });

        expect(patched.status).toBe(200);
        expect(await storedText()).toBe(
          'version: 1\nservices:\n  # handed over\n  shop-db:\n    kind: mysql\n    version: "8"\n    description: Orders\n',
        );
        const saved = (await savePlans()).at(-1)!;
        expect(saved.steps).toEqual([
          expect.objectContaining({ action: 'change', configName: 'shop-db' }),
        ]);
        const [row] = await ctx.db
          .select({ configPlanId: mysql.configPlanId })
          .from(mysql);
        expect(row.configPlanId).toBe(saved.planId);
        expect(await checkForChanges()).toMatchObject({
          status: 'unchanged',
          notes: [],
        });
      });

      it('keeps it described when its version is edited in the console', async () => {
        const mysqlId = await handedOver();

        const patched = await request(server)
          .patch(`/mysql/${mysqlId}`)
          .set('Cookie', cookie)
          .send({ dockerImage: 'mysql:8.4' });

        expect(patched.status).toBe(200);
        expect((await entries())['shop-db']).toEqual({
          kind: 'mysql',
          version: '8.4',
        });
        expect((await checkForChanges()).status).toBe('unchanged');
      });
    });

    it("leaves caps Cloudgate's while the entry states no size, and rewrites a stated one", async () => {
      const made = await request(server)
        .post('/redis')
        .set('Cookie', cookie)
        .send({ name: 'Cache', environmentId });
      expect(made.status).toBe(201);
      const { redisId } = made.body as { redisId: string };
      const caps = (cpuLimit: string, memoryLimit: string) =>
        request(server)
          .patch(`/redis/${redisId}`)
          .set('Cookie', cookie)
          .send({ cpuLimit, memoryLimit })
          .expect(200);

      const text = await storedText();
      await caps('250000000', '536870912');
      expect(await storedText()).toBe(text);

      // Once the config states a size, the console's caps are its size.
      const saved = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({
          text: 'version: 1\nservices:\n  cache:\n    kind: redis\n    size: xsmall\n',
        });
      expect((saved.body as { stored: boolean }).stored).toBe(true);
      await caps('500000000', '1073741824');

      expect((await entries()).cache).toEqual({ kind: 'redis', size: 'small' });
      expect((await checkForChanges()).status).toBe('unchanged');
    });
  });

  /**
   * On a described Service the seven Swarm settings `native.docker`
   * owns are config-owned, so a console Save of one rewrites the entry's
   * `native.docker`, a default left out; placement, networks, published
   * ports, the mode and the replica count stay Cloudgate's.
   */
  describe('Swarm settings', () => {
    const HEALTH_CHECK = {
      Test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'],
      Interval: 10_000_000_000,
      Retries: 5,
    };

    it("writes a described web's health check into native.docker as an applied save plan, and the next plan finds nothing", async () => {
      const app = await createApplication('Web Shop');
      const commented = (await storedText()).replace(
        '  web-shop:',
        '  # the storefront\n  web-shop:',
      );
      await storeText(commented);

      await patchApplication(app.applicationId, {
        healthCheckSwarm: HEALTH_CHECK,
      }).expect(200);

      expect(await storedText()).toContain('# the storefront\n  web-shop:');
      expect((await entries())['web-shop'].native).toEqual({
        docker: { HealthCheck: HEALTH_CHECK },
      });
      const saved = (await savePlans()).at(-1)!;
      expect(saved.status).toBe('applied');
      expect(saved.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'web-shop',
          fields: expect.arrayContaining([
            expect.objectContaining({
              field: 'native.docker.HealthCheck.Retries',
              to: 5,
              native: true,
            }),
          ]) as unknown,
        }),
      ]);
      expect((await checkForChanges()).status).toBe('unchanged');
    });

    it("takes a setting put back to the kind's default out of the file rather than writing the default", async () => {
      const app = await createApplication('Web Shop');
      await patchApplication(app.applicationId, {
        stopGracePeriodSwarm: 20_000_000_000,
        updateConfigSwarm: { Parallelism: 1, Order: 'start-first', Delay: 5 },
      }).expect(200);
      expect((await entries())['web-shop'].native).toEqual({
        docker: { StopGracePeriod: 20_000_000_000, UpdateConfig: { Delay: 5 } },
      });

      await patchApplication(app.applicationId, {
        stopGracePeriodSwarm: null,
      }).expect(200);
      expect((await entries())['web-shop'].native).toEqual({
        docker: { UpdateConfig: { Delay: 5 } },
      });

      // The kind's own update settings, stated in full, are no setting at all.
      await patchApplication(app.applicationId, {
        updateConfigSwarm: {
          Parallelism: 1,
          Order: 'start-first',
          FailureAction: 'rollback',
        },
      }).expect(200);
      expect((await entries())['web-shop']).not.toHaveProperty('native');
      expect((await checkForChanges()).status).toBe('unchanged');
    });

    it('saves placement, networks, published ports, the mode and replicas directly, leaving the config', async () => {
      const app = await createApplication('Web Shop');
      const text = await storedText();
      const plans = (await savePlans()).length;

      const patched = await patchApplication(app.applicationId, {
        placementSwarm: { Constraints: ['node.role==worker'] },
        networkSwarm: [{ Target: 'shop-net' }],
        endpointSpecSwarm: {
          Ports: [{ TargetPort: 3000, PublishedPort: 8080 }],
        },
        modeSwarm: { Replicated: { Replicas: 2 } },
        replicas: 2,
      });

      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        placementSwarm: { Constraints: ['node.role==worker'] },
        replicas: 2,
      });
      expect(await storedText()).toBe(text);
      expect(await savePlans()).toHaveLength(plans);
      expect((await checkForChanges()).status).toBe('unchanged');
    });

    it('saves a console-managed Service’s Swarm settings as before, leaving its line', async () => {
      const app = await createApplication('Web Shop');
      const text = (await storedText()).replace(
        / {2}web-shop:\n(?: {4}.*\n)*/,
        '  web-shop:\n    kind: web\n    managed: console\n',
      );
      await storeText(text);
      const plans = (await savePlans()).length;

      await patchApplication(app.applicationId, {
        healthCheckSwarm: HEALTH_CHECK,
        stopGracePeriodSwarm: 20_000_000_000,
      }).expect(200);

      expect(await storedText()).toBe(text);
      expect(await savePlans()).toHaveLength(plans);
      const [row] = await ctx.db
        .select({ healthCheckSwarm: application.healthCheckSwarm })
        .from(application)
        .where(eq(application.applicationId, app.applicationId));
      expect(row.healthCheckSwarm).toEqual(HEALTH_CHECK);
    });

    it('still refuses a locked value, writing neither the row nor the config', async () => {
      const app = await createApplication('Web Shop');
      const text = await storedText();

      const refused = await patchApplication(app.applicationId, {
        labelsSwarm: { 'traefik.http.routers.x.rule': 'Host(`a.example`)' },
      });

      expect(refused.status).toBe(400);
      expect(await storedText()).toBe(text);
      const [row] = await ctx.db
        .select({ labelsSwarm: application.labelsSwarm })
        .from(application)
        .where(eq(application.applicationId, app.applicationId));
      expect(row.labelsSwarm).toBeNull();
    });
  });

  describe('creating each kind', () => {
    it.each([
      ['postgres', 'postgres', { databaseName: 'app', databaseUser: 'app' }],
      ['redis', 'redis', {}],
    ])(
      'adds a console-created %s as a described entry',
      async (route, kind, extra) => {
        const made = await request(server)
          .post(`/${route}`)
          .set('Cookie', cookie)
          .send({ name: 'Store', environmentId, ...extra });
        expect(made.status).toBe(201);

        expect((await entries()).store).toMatchObject({ kind });
        expect((await entries()).store.managed).toBeUndefined();
        expect((await savePlans()).at(-1)?.steps).toEqual([
          expect.objectContaining({ action: 'create', configName: 'store' }),
        ]);
        expect((await checkForChanges()).status).toBe('unchanged');
      },
    );

    it.each([
      ['mongo', 'mongo', { databaseUser: 'app' }],
      ['mysql', 'mysql', { databaseName: 'app', databaseUser: 'app' }],
      ['mariadb', 'mariadb', { databaseName: 'app', databaseUser: 'app' }],
      ['libsql', 'libsql', { databaseUser: 'app' }],
      ['compose', 'compose', {}],
    ])(
      'adds a console-created %s as managed: console, recording no plan',
      async (route, kind, extra) => {
        const made = await request(server)
          .post(`/${route}`)
          .set('Cookie', cookie)
          .send({ name: 'Store', environmentId, ...extra });
        expect(made.status).toBe(201);

        expect((await entries()).store).toEqual({ kind, managed: 'console' });
        expect(await savePlans()).toHaveLength(0);
        expect((await checkForChanges()).status).toBe('unchanged');
      },
    );
  });

  describe('deleting', () => {
    it('removes a listed Service through a destroy step, answering its leftovers as before', async () => {
      const made = await request(server)
        .post('/postgres')
        .set('Cookie', cookie)
        .send({
          name: 'Orders DB',
          environmentId,
          databaseName: 'orders',
          databaseUser: 'shop',
        });
      expect(made.status).toBe(201);
      const { postgresId } = made.body as { postgresId: string };
      await createApplication('Web Shop');

      const deleted = await request(server)
        .delete(`/postgres/${postgresId}`)
        .set('Cookie', cookie);

      expect(deleted.status).toBe(200);
      const body = deleted.body as {
        postgresId: string;
        volumeLeftBehind: boolean | null;
        unreclaimedArtifacts?: unknown[];
      };
      expect(body.postgresId).toBe(postgresId);
      expect(body).toHaveProperty('volumeLeftBehind');
      expect(Object.keys(await entries())).toEqual(['web-shop']);
      const saved = (await savePlans()).at(-1)!;
      expect(saved.steps).toEqual([
        expect.objectContaining({ action: 'destroy', configName: 'orders-db' }),
      ]);
      const leftovers: Record<string, unknown> = {};
      if (body.unreclaimedArtifacts) {
        leftovers.unreclaimedArtifacts = body.unreclaimedArtifacts;
      }
      if (body.volumeLeftBehind !== false) {
        leftovers.volumeLeftBehind = body.volumeLeftBehind;
      }
      expect(saved.results).toEqual([
        expect.objectContaining({
          action: 'destroy',
          status: 'applied',
          serviceId: postgresId,
          leftovers: Object.keys(leftovers).length > 0 ? leftovers : null,
        }),
      ]);
      expect((await checkForChanges()).status).toBe('unchanged');
    });

    it('removes a console-managed line with its Service', async () => {
      const made = await request(server)
        .post('/compose')
        .set('Cookie', cookie)
        .send({ name: 'Stack', environmentId });
      expect(made.status).toBe(201);
      const { composeId } = made.body as { composeId: string };

      const deleted = await request(server)
        .delete(`/compose/${composeId}`)
        .set('Cookie', cookie);

      expect(deleted.status).toBe(200);
      expect(await entries()).toEqual({});
      expect((await checkForChanges()).status).toBe('unchanged');
    });

    it('leaves the entry when the Delete refuses', async () => {
      const app = await createApplication('Web Shop');
      const text = await storedText();
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve({
          stdout: isPresenceProbe(command) ? 'present' : '',
          stderr: '',
        }),
      );

      const deleted = await request(server)
        .delete(`/applications/${app.applicationId}`)
        .set('Cookie', cookie);

      expect(deleted.status).toBe(409);
      expect(await storedText()).toBe(text);
    });
  });

  describe('across Environments', () => {
    it('lists a Service in only some Environments as managed: console, saying why, and plans nothing in either', async () => {
      const staging = await createEnvironment('staging');

      await createApplication('Web Shop', staging);

      const text = await storedText();
      expect((await entries())['web-shop']).toEqual({
        kind: 'web',
        managed: 'console',
      });
      expect(text).toMatch(/# It exists only in the staging Environment/);
      expect((await checkForChanges()).status).toBe('unchanged');
      expect((await checkForChanges(staging)).status).toBe('unchanged');
    });

    it('takes a change made in one Environment into the entry, leaving the others to plan it', async () => {
      const staging = await createEnvironment('staging');
      const production = await createApplication('Web Shop');
      await createApplication('Web Shop', staging);
      // The two agree, so the entry is described once both exist.
      expect((await entries())['web-shop'].managed).toBeUndefined();

      const patched = await patchApplication(production.applicationId, {
        command: 'npm start',
      });

      expect(patched.status).toBe(200);
      // The config holds one command for every Environment: the Save's.
      expect((await entries())['web-shop']).toMatchObject({
        kind: 'web',
        command: 'npm start',
      });
      expect((await entries())['web-shop'].managed).toBeUndefined();
      expect((await checkForChanges()).status).toBe('unchanged');
      const other = await checkForChanges(staging);
      expect(other.status).toBe('open');
      expect(other.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'web-shop',
          fields: [{ field: 'command', from: null, to: 'npm start' }],
        }),
      ]);
    });

    it("keeps another Environment's pending difference when a Save rewrites other fields", async () => {
      const staging = await createEnvironment('staging');
      const production = await createApplication('Web Shop');
      await createApplication('Web Shop', staging);
      // A YAML edit of the port, applied in production only.
      const edited = (await storedText()).replace('port: 3000', 'port: 8080');
      expect(edited).toContain('port: 8080');
      const saved = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text: edited });
      expect(saved.status).toBe(201);
      const productionPlan = (saved.body as { plans: PlanBody[] }).plans.find(
        (one) => one.environmentId === environmentId,
      )!;
      const applied = await request(server)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: productionPlan.planId });
      expect(applied.status).toBe(200);

      const patched = await patchApplication(production.applicationId, {
        description: 'The storefront',
      });

      expect(patched.status).toBe(200);
      expect((await entries())['web-shop']).toMatchObject({
        kind: 'web',
        port: 8080,
        description: 'The storefront',
      });
      const other = await checkForChanges(staging);
      expect(other.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'web-shop',
          fields: expect.arrayContaining([
            { field: 'port', from: 3000, to: 8080 },
            { field: 'description', from: null, to: 'The storefront' },
          ]) as unknown,
        }),
      ]);
    });
  });

  describe('without a Cloudgate-kept config', () => {
    it('writes as before configs existed when the Project has no config row', async () => {
      await ctx.db
        .delete(projectConfigLocation)
        .where(eq(projectConfigLocation.projectId, projectId));

      const app = await createApplication('Web Shop');
      const patched = await patchApplication(app.applicationId, {
        command: 'npm start',
      });
      const deleted = await request(server)
        .delete(`/applications/${app.applicationId}`)
        .set('Cookie', cookie);

      expect(patched.status).toBe(200);
      expect(deleted.status).toBe(200);
      expect(await ctx.db.select().from(projectConfigLocation)).toHaveLength(0);
      expect(await savePlans()).toHaveLength(0);
    });
  });

  describe('when the config cannot be written', () => {
    /** Makes every write of a config's text fail, as a database would. */
    async function refuseConfigWrites() {
      await ctx.db.$client.query(`
        create or replace function refuse_config_write() returns trigger
          language plpgsql as $$
          begin raise exception 'config writes refused'; end $$;
        create trigger refuse_config_write before update
          on project_config_location
          for each row execute function refuse_config_write();
      `);
    }

    afterEach(async () => {
      await ctx.db.$client.query(`
        drop trigger if exists refuse_config_write on project_config_location;
        drop function if exists refuse_config_write();
      `);
    });

    const expectNotKept = (res: { status: number; body: unknown }) => {
      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe(
        'PROJECT_CONFIG_NOT_KEPT',
      );
    };

    it('refuses a create, creating nothing', async () => {
      const text = await storedText();
      await refuseConfigWrites();

      const created = await request(server)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'Web Shop', environmentId });

      expectNotKept(created);
      expect(await ctx.db.select().from(application)).toHaveLength(0);
      expect(await savePlans()).toHaveLength(0);
      expect(await storedText()).toBe(text);
    });

    it('refuses a config-owned edit, writing nothing', async () => {
      const app = await createApplication('Web Shop');
      const text = await storedText();
      const plans = (await savePlans()).length;
      await refuseConfigWrites();

      const patched = await patchApplication(app.applicationId, {
        command: 'npm start',
      });

      expectNotKept(patched);
      const [row] = await ctx.db
        .select({ command: application.command })
        .from(application);
      expect(row.command).toBeNull();
      expect(await storedText()).toBe(text);
      expect(await savePlans()).toHaveLength(plans);
    });

    it('still writes a Cloudgate-owned edit, which the config does not hold', async () => {
      const app = await createApplication('Web Shop');
      await refuseConfigWrites();

      const patched = await patchApplication(app.applicationId, {
        autoDeploy: false,
      });

      expect(patched.status).toBe(200);
    });

    it('refuses a Delete, keeping the Service and its entry', async () => {
      const app = await createApplication('Web Shop');
      const text = await storedText();
      await refuseConfigWrites();

      const deleted = await request(server)
        .delete(`/applications/${app.applicationId}`)
        .set('Cookie', cookie);

      expectNotKept(deleted);
      expect(await ctx.db.select().from(application)).toHaveLength(1);
      expect(await storedText()).toBe(text);
    });
  });

  describe('the open plan', () => {
    it('is superseded by a recorded Save, which releases the builds it held', async () => {
      const app = await createApplication('Web Shop');
      // An open plan that changes the Application, holding its build.
      const saved = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({
          text: (await storedText()).replace('port: 3000', 'port: 4000'),
        });
      const [open] = (saved.body as { plans: PlanBody[] }).plans;
      expect(open.status).toBe('open');
      const [held] = await ctx.db
        .insert(deployment)
        .values({
          title: 'push',
          status: 'held',
          logPath: '/tmp/held.log',
          applicationId: app.applicationId,
          heldByPlanId: open.planId,
        })
        .returning();

      await patchApplication(app.applicationId, {
        command: 'npm start',
      }).expect(200);

      const [superseded] = await ctx.db
        .select({ status: planTable.status })
        .from(planTable)
        .where(eq(planTable.planId, open.planId));
      expect(superseded.status).toBe('superseded');
      const [released] = await ctx.db
        .select({ status: deployment.status })
        .from(deployment)
        .where(eq(deployment.deploymentId, held.deploymentId));
      expect(released.status).not.toBe('held');
    });
  });

  describe('applying a plan', () => {
    it('records no save plan of its own for the writes its steps make', async () => {
      const saved = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({
          text: 'version: 1\nservices:\n  cache:\n    kind: redis\n',
        });
      expect(saved.status).toBe(201);
      const [open] = (saved.body as { plans: PlanBody[] }).plans;

      const applied = await request(server)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: open.planId });

      expect(applied.status).toBe(200);
      expect(await savePlans()).toHaveLength(0);
      expect(await storedText()).toBe(
        'version: 1\nservices:\n  cache:\n    kind: redis\n',
      );
    });
  });

  /** Every applied plan moves the version a whole-YAML edit names (ADR-0080). */
  describe('the config version', () => {
    async function version() {
      const config = await request(server)
        .get(`/projects/${projectId}/config`)
        .set('Cookie', cookie);
      expect(config.status).toBe(200);
      return (config.body as { location: { version: number } }).location
        .version;
    }

    it('moves on a console Save', async () => {
      const before = await version();

      await createApplication('Web Shop');

      expect(await version()).not.toBe(before);
    });

    it('moves when a whole-YAML edit is applied', async () => {
      const saved = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({
          text: 'version: 1\nservices:\n  cache:\n    kind: redis\n',
          version: await version(),
        });
      expect(saved.status).toBe(201);
      const [open] = (saved.body as { plans: PlanBody[] }).plans;
      const planned = await version();

      const applied = await request(server)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: open.planId });

      expect(applied.status).toBe(200);
      expect(await version()).not.toBe(planned);
    });

    it('moves when a plan that leaves the text as it is is applied', async () => {
      const app = await createApplication('Web Shop');
      // The saved port drifts from the config's; the plan puts it back.
      await ctx.db
        .update(application)
        .set({ port: 8080 })
        .where(eq(application.applicationId, app.applicationId));
      const open = await checkForChanges();
      expect(open.status).toBe('open');
      const before = await version();
      const text = await storedText();

      const applied = await request(server)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: open.planId });

      expect(applied.status).toBe(200);
      expect(await storedText()).toBe(text);
      expect(await version()).not.toBe(before);
    });
  });
});
