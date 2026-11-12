import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  deployment,
  licenseKey,
  member,
  organizationRole,
  server,
} from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';

jest.setTimeout(180_000);

/** The last migration before an Environment had a Deploy target. */
const MIGRATION_BEFORE_DEPLOY_TARGET = '0095_service-config-name';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PLATFORM_HOST = { kind: 'platform-host' };
const onServer = (serverId: string) => ({ kind: 'server', serverId });

const idOf = (res: request.Response) =>
  (res.body as { environmentId: string }).environmentId;
const messageOf = (res: request.Response) =>
  (res.body as { message: string }).message;

/**
 * Each Environment has a Deploy target — a Server or the platform host —
 * that decides where a Service a plan creates will run, and nothing else. It is
 * asked for only when the organization has a Server to choose, changing it
 * moves no Service and queues no Deployment, and the Server it names cannot be
 * deleted from under it.
 */
describe('Environment Deploy target (e2e)', () => {
  describe('backfill', () => {
    let legacy: LegacyDatabase;

    beforeAll(async () => {
      legacy = await startLegacyDatabase(
        'i748',
        MIGRATION_BEFORE_DEPLOY_TARGET,
      );
    });

    afterAll(async () => {
      await legacy?.drop();
    });

    it('takes the run Server most Services use, the most recent on a tie, and the platform host with no Services', async () => {
      await legacy.pool.query(`
        insert into "user" (id, email, updated_at)
          values ('user-1', 'grace@example.com', now());
        insert into organization (id, name, created_at, owner_id)
          values ('org-1', 'Acme', now(), 'user-1');
        insert into project (project_id, name, created_at, organization_id)
          values ('p-1', 'shop', '2026-01-01T00:00:00.000Z', 'org-1');
        insert into server (server_id, name, ip_address, port, created_at, organization_id) values
          ('s-a', 'alpha', '10.0.0.1', 22, '2026-01-01T00:00:00.000Z', 'org-1'),
          ('s-b', 'bravo', '10.0.0.2', 22, '2026-01-01T00:00:00.000Z', 'org-1');
        insert into environment (environment_id, name, created_at, project_id) values
          ('e-most',   'most',   '2026-01-01T00:00:00.000Z', 'p-1'),
          ('e-tie',    'tie',    '2026-01-01T00:00:00.000Z', 'p-1'),
          ('e-host',   'host',   '2026-01-01T00:00:00.000Z', 'p-1'),
          ('e-hosttie','hosttie','2026-01-01T00:00:00.000Z', 'p-1'),
          ('e-empty',  'empty',  '2026-01-01T00:00:00.000Z', 'p-1');
        -- e-most: two Services on bravo (one of them a database) beat one on
        -- alpha and one on the platform host, though alpha's is the newest.
        insert into application (application_id, name, app_name, config_name, created_at, environment_id, server_id) values
          ('a-1', 'web',    'most-web', 'web',    '2026-01-02T00:00:00.000Z', 'e-most', 's-b'),
          ('a-2', 'api',    'most-api', 'api',    '2026-01-09T00:00:00.000Z', 'e-most', 's-a'),
          ('a-3', 'admin',  'most-admin', 'admin',  '2026-01-08T00:00:00.000Z', 'e-most', null),
          -- e-tie: one each, and alpha's is the more recent.
          ('a-4', 'web',    'tie-web', 'web',     '2026-01-02T00:00:00.000Z', 'e-tie',  's-b'),
          ('a-5', 'api',    'tie-api', 'api',     '2026-01-03T00:00:00.000Z', 'e-tie',  's-a'),
          -- e-host: most of its Services are on the platform host.
          ('a-6', 'web',    'host-web', 'web',    '2026-01-02T00:00:00.000Z', 'e-host', null),
          ('a-7', 'api',    'host-api', 'api',    '2026-01-03T00:00:00.000Z', 'e-host', null),
          ('a-8', 'admin',  'host-admin', 'admin',  '2026-01-04T00:00:00.000Z', 'e-host', 's-a'),
          -- e-hosttie: one each, and the platform host's is the more recent.
          ('a-9', 'web',    'hosttie-web', 'web', '2026-01-02T00:00:00.000Z', 'e-hosttie', 's-a'),
          ('a-10','api',    'hosttie-api', 'api', '2026-01-05T00:00:00.000Z', 'e-hosttie', null);
        insert into redis (redis_id, name, app_name, config_name, database_password, created_at, environment_id, server_id)
          values ('r-1', 'cache', 'most-cache', 'cache', 'pw', '2026-01-03T00:00:00.000Z', 'e-most', 's-b');
      `);

      await legacy.migrateToHead();

      const { rows } = await legacy.pool.query<{
        environment_id: string;
        deploy_target: unknown;
      }>(
        `select environment_id, deploy_target from environment order by environment_id`,
      );
      expect(
        Object.fromEntries(
          rows.map((row) => [row.environment_id, row.deploy_target]),
        ),
      ).toEqual({
        'e-most': onServer('s-b'),
        'e-tie': onServer('s-a'),
        'e-host': PLATFORM_HOST,
        'e-hosttie': PLATFORM_HOST,
        'e-empty': PLATFORM_HOST,
      });

      // And every Service kept its own run Server.
      const services = await legacy.pool.query<{ server_id: string | null }>(
        `select server_id from application where environment_id = 'e-most' order by application_id`,
      );
      expect(services.rows.map((row) => row.server_id)).toEqual([
        's-b',
        's-a',
        null,
      ]);
    });
  });

  describe('over the API', () => {
    let ctx: TestAppContext;
    let http: App;

    const ok = { stdout: '', stderr: '', exitCode: 0 };
    const execMock = withArgvExec({
      execAsync: jest.fn<Promise<typeof ok>, [string]>(),
      execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
    });
    const traefikWriterMock = {
      loadOrCreateConfig: jest.fn(),
      writeConfig: jest.fn(),
      removeConfig: jest.fn(),
      writeCertificate: jest.fn(),
      removeCertificate: jest.fn(),
    };

    beforeAll(async () => {
      ctx = await createTestApp({
        overrideProviders: [
          { provide: RemoteExecService, useValue: execMock },
          { provide: TraefikWriterService, useValue: traefikWriterMock },
        ],
      });
      http = ctx.app.getHttpServer() as App;
    });

    afterAll(async () => {
      await ctx.teardown();
    });

    let cookie: string;
    let organizationId: string;
    let projectId: string;

    beforeEach(async () => {
      await ctx.resetDb();
      execMock.execAsync.mockReset().mockResolvedValue(ok);
      execMock.execAsyncRemote.mockReset().mockResolvedValue(ok);
      traefikWriterMock.loadOrCreateConfig
        .mockReset()
        .mockResolvedValue({ http: { routers: {}, services: {} } });
      traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);

      const res = await request(http)
        .post('/api/auth/sign-up/email')
        .send(owner);
      expect(res.status).toBe(200);
      cookie = res.headers['set-cookie'];
      const orgs = await request(http)
        .get('/organizations')
        .set('Cookie', cookie);
      organizationId = (orgs.body as { id: string }[])[0].id;

      const project = await request(http)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'shop' });
      expect(project.status).toBe(201);
      projectId = (project.body as { projectId: string }).projectId;
    });

    async function addServer(
      name: string,
      options: {
        organizationId?: string;
        serverType?: 'deploy' | 'build';
      } = {},
    ): Promise<string> {
      const [row] = await ctx.db
        .insert(server)
        .values({
          name,
          ipAddress: '10.0.0.5',
          port: 22,
          organizationId: options.organizationId ?? organizationId,
          serverType: options.serverType ?? 'deploy',
        })
        .returning();
      return row.serverId;
    }

    const createEnvironment = (body: Record<string, unknown>, as = cookie) =>
      request(http)
        .post('/environments')
        .set('Cookie', as)
        .send({ projectId, ...body });

    const patchEnvironment = (
      environmentId: string,
      body: Record<string, unknown>,
      as = cookie,
    ) =>
      request(http)
        .patch(`/environments/${environmentId}`)
        .set('Cookie', as)
        .send(body);

    describe('a new Environment', () => {
      it('takes the platform host without asking when the organization has no Server', async () => {
        const created = await createEnvironment({ name: 'production' });

        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ deployTarget: PLATFORM_HOST });
        const read = await request(http)
          .get(`/environments/${idOf(created)}`)
          .set('Cookie', cookie);
        expect(read.body).toMatchObject({ deployTarget: PLATFORM_HOST });
      });

      it('is not asked by a build Server, which runs nothing', async () => {
        await addServer('builder', { serverType: 'build' });

        const created = await createEnvironment({ name: 'production' });

        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ deployTarget: PLATFORM_HOST });
      });

      it('refuses a missing choice once the organization has a Server, and creates nothing', async () => {
        await addServer('worker-1');

        const refused = await createEnvironment({ name: 'production' });

        expect(refused.status).toBe(400);
        expect(messageOf(refused)).toBe(
          'Choose a Deploy target: this organization has a Server, so a new Environment needs a Server or the platform host chosen',
        );
        const list = await request(http)
          .get('/environments')
          .query({ projectId })
          .set('Cookie', cookie);
        expect(list.body).toEqual([]);
      });

      it('takes the Server or the platform host it is given', async () => {
        const worker = await addServer('worker-1');

        const placed = await createEnvironment({
          name: 'production',
          deployTarget: onServer(worker),
        });
        const local = await createEnvironment({
          name: 'staging',
          deployTarget: PLATFORM_HOST,
        });

        expect(placed.status).toBe(201);
        expect(placed.body).toMatchObject({ deployTarget: onServer(worker) });
        expect(local.status).toBe(201);
        expect(local.body).toMatchObject({ deployTarget: PLATFORM_HOST });
      });

      it("refuses another organization's Server as not found, and a build Server", async () => {
        const mallory = await secondOrganizationOwner(http, ctx.db, cookie);
        const theirs = await addServer('their-worker', {
          organizationId: mallory.organizationId,
        });
        const builder = await addServer('builder', { serverType: 'build' });

        const foreign = await createEnvironment({
          name: 'production',
          deployTarget: onServer(theirs),
        });
        const build = await createEnvironment({
          name: 'production',
          deployTarget: onServer(builder),
        });

        expect(foreign.status).toBe(404);
        expect(messageOf(foreign)).toBe('Server not found');
        expect(build.status).toBe(400);
        expect(messageOf(build)).toBe(
          'Server "builder" is a build Server, so it cannot be a Deploy target',
        );
      });

      it('refuses a Deploy target of a kind it does not know', async () => {
        const refused = await createEnvironment({
          name: 'production',
          deployTarget: { kind: 'cloud', region: 'eu-west-1' },
        });

        expect(refused.status).toBe(400);
      });
    });

    describe('changing the Deploy target', () => {
      it('moves no Service and queues no Deployment', async () => {
        const first = await addServer('worker-1');
        const second = await addServer('worker-2');
        const environment = await createEnvironment({
          name: 'production',
          deployTarget: onServer(first),
        });
        const environmentId = idOf(environment);
        const web = await request(http)
          .post('/applications')
          .set('Cookie', cookie)
          .send({ name: 'web', environmentId, serverId: first });
        const admin = await request(http)
          .post('/applications')
          .set('Cookie', cookie)
          .send({ name: 'admin', environmentId });
        expect(web.status).toBe(201);
        expect(admin.status).toBe(201);
        const deploymentsBefore = await ctx.db.select().from(deployment);

        const changed = await patchEnvironment(environmentId, {
          deployTarget: onServer(second),
        });

        expect(changed.status).toBe(200);
        expect(changed.body).toMatchObject({ deployTarget: onServer(second) });
        const services = await ctx.db
          .select({ name: application.name, serverId: application.serverId })
          .from(application)
          .where(eq(application.environmentId, environmentId))
          .orderBy(application.name);
        // `admin` named no Server, so it landed on the Deploy target it was
        // created under — and stays there when the target changes.
        expect(services).toEqual([
          { name: 'admin', serverId: first },
          { name: 'web', serverId: first },
        ]);
        expect(await ctx.db.select().from(deployment)).toEqual(
          deploymentsBefore,
        );

        const back = await patchEnvironment(environmentId, {
          deployTarget: PLATFORM_HOST,
        });
        expect(back.status).toBe(200);
        expect(back.body).toMatchObject({ deployTarget: PLATFORM_HOST });
      });

      it("refuses another organization's Server and leaves the target as it was", async () => {
        const environment = await createEnvironment({ name: 'production' });
        const mallory = await secondOrganizationOwner(http, ctx.db, cookie);
        const theirs = await addServer('their-worker', {
          organizationId: mallory.organizationId,
        });

        const refused = await patchEnvironment(idOf(environment), {
          deployTarget: onServer(theirs),
        });

        expect(refused.status).toBe(404);
        const read = await request(http)
          .get(`/environments/${idOf(environment)}`)
          .set('Cookie', cookie);
        expect(read.body).toMatchObject({ deployTarget: PLATFORM_HOST });
      });

      it('needs environment: update', async () => {
        const worker = await addServer('worker-1');
        const environment = await createEnvironment({
          name: 'production',
          deployTarget: PLATFORM_HOST,
        });
        const environmentId = idOf(environment);
        const ida = await signUpMember(http, cookie);
        await ctx.db.insert(licenseKey).values({
          organizationId,
          key: 'test-license-key',
          status: 'active',
          enableEnterpriseFeatures: true,
        });
        await ctx.db.insert(organizationRole).values({
          organizationId,
          role: 'environment-reader',
          permission: { environment: ['read'] },
        });
        await ctx.db
          .update(member)
          .set({
            role: 'environment-reader',
            accessedEnvironments: [environmentId],
          })
          .where(
            and(
              eq(member.userId, ida.id),
              eq(member.organizationId, organizationId),
            ),
          );

        const refused = await patchEnvironment(
          environmentId,
          { deployTarget: onServer(worker) },
          ida.cookie,
        );

        expect(refused.status).toBe(403);
        const read = await request(http)
          .get(`/environments/${environmentId}`)
          .set('Cookie', cookie);
        expect(read.body).toMatchObject({ deployTarget: PLATFORM_HOST });
      });
    });

    describe('the Server it names', () => {
      it('cannot be deleted while it is an Environment’s Deploy target, and can once it is not', async () => {
        const worker = await addServer('worker-1');
        const environment = await createEnvironment({
          name: 'production',
          deployTarget: onServer(worker),
        });

        const refused = await request(http)
          .delete(`/servers/${worker}`)
          .set('Cookie', cookie);

        expect(refused.status).toBe(409);
        expect(messageOf(refused)).toBe(
          'Server "worker-1" is the Deploy target of 1 Environment (shop / production). ' +
            'Choose another Deploy target in its settings first',
        );

        await patchEnvironment(idOf(environment), {
          deployTarget: PLATFORM_HOST,
        });
        const deleted = await request(http)
          .delete(`/servers/${worker}`)
          .set('Cookie', cookie);
        expect(deleted.status).toBe(200);
      });
    });
  });
});
