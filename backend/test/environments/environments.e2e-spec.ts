import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  application,
  compose,
  libsql,
  mariadb,
  member,
  mongo,
  mysql,
  postgres,
  redis,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import type { EnvironmentServiceSummary } from '../../src/environments/environment-services';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { seededConfigName } from '../utils/seeded-config-name';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
}

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
  const cookie = su.headers['set-cookie'];
  const id = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

describe('Environments (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  /** An owner ctx plus a project for environments to attach to. */
  async function setUpProject(name = 'cloudgate') {
    const { organizationId, owner: ownerSession } = await setUpOwner(server);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);
    const project = await projects.create(ownerCtx, { name });
    return { organizationId, ownerSession, ownerCtx, project };
  }

  describe('create → findOne', () => {
    it('creates an environment under a project retrievable by id', async () => {
      const { ownerCtx, project } = await setUpProject();

      const created = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });

      expect(created.environmentId).toEqual(expect.any(String));
      expect(created.projectId).toBe(project.projectId);

      const found = await environments.findOne(ownerCtx, created.environmentId);
      expect(found).toMatchObject({
        environmentId: created.environmentId,
        name: 'production',
        projectId: project.projectId,
      });
    });

    it('carries the description it was created with', async () => {
      const { ownerCtx, project } = await setUpProject();

      const created = await environments.create(ownerCtx, {
        name: 'blue',
        projectId: project.projectId,
        description: 'the idle half of the blue/green pair',
      });
      expect(created.description).toBe('the idle half of the blue/green pair');

      const found = await environments.findOne(ownerCtx, created.environmentId);
      expect(found.description).toBe('the idle half of the blue/green pair');
    });

    it('an environment created without a description has none', async () => {
      const { ownerCtx, project } = await setUpProject();

      const created = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      expect(created.description).toBeNull();

      const found = await environments.findOne(ownerCtx, created.environmentId);
      expect(found.description).toBeNull();
    });

    it('stores env encrypted at rest and returns it decrypted', async () => {
      const { ownerCtx, project } = await setUpProject();

      const created = await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
        env: 'DB_PASSWORD=super-secret',
      });

      const found = await environments.findOne(ownerCtx, created.environmentId);
      expect(found.env).toBe('DB_PASSWORD=super-secret');

      const raw = await ctx.db.$client.query<{ env: string }>(
        'select env from environment where environment_id = $1',
        [created.environmentId],
      );
      expect(raw.rows[0].env).not.toContain('super-secret');
      expect(raw.rows[0].env.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('listByProject', () => {
    it('owner sees every environment in the project, and only that project', async () => {
      const { ownerCtx, project } = await setUpProject('alpha');
      const other = await projects.create(ownerCtx, { name: 'beta' });

      await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      await environments.create(ownerCtx, {
        name: 'elsewhere',
        projectId: other.projectId,
      });

      const listed = await environments.listByProject(
        ownerCtx,
        project.projectId,
      );
      expect(listed.map((e) => e.name).sort()).toEqual([
        'production',
        'staging',
      ]);
    });

    it('a member sees only environments granted in accessedEnvironments', async () => {
      const { ownerSession, ownerCtx, organizationId, project } =
        await setUpProject();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const granted = await environments.create(ownerCtx, {
        name: 'granted',
        projectId: project.projectId,
      });
      await environments.create(ownerCtx, {
        name: 'hidden',
        projectId: project.projectId,
      });

      expect(
        await environments.listByProject(inviteeCtx, project.projectId),
      ).toEqual([]);

      const permissions = ctx.app.get(PermissionService);
      await permissions.addNewEnvironment(inviteeCtx, granted.environmentId);

      const listed = await environments.listByProject(
        inviteeCtx,
        project.projectId,
      );
      expect(listed.map((e) => e.environmentId)).toEqual([
        granted.environmentId,
      ]);
    });

    it('create grants the creator row-level access', async () => {
      const { ownerSession, organizationId, project } = await setUpProject();
      const admin = await inviteUser(
        server,
        ownerSession.cookie,
        'admin@example.com',
        'admin',
      );
      const adminCtx = permissionCtx(admin.id, organizationId);

      const own = await environments.create(adminCtx, {
        name: 'admins-env',
        projectId: project.projectId,
      });

      // Downgrade the creator to a plain member: only the row-level grant
      // made at create time can keep their environment visible.
      await ctx.db
        .update(member)
        .set({ role: 'member' })
        .where(eq(member.userId, admin.id));

      const listed = await environments.listByProject(
        adminCtx,
        project.projectId,
      );
      expect(listed.map((e) => e.environmentId)).toEqual([own.environmentId]);
    });
  });

  describe('findOne carries the services deployed in the environment', () => {
    /** Applications are seeded directly: the read is what's under test, not
     * whichever lifecycle routes the service modules happen to expose. */
    async function seedApplication(environmentId: string, name: string) {
      const [row] = await ctx.db
        .insert(application)
        .values({ name, environmentId, configName: seededConfigName() })
        .returning();
      return row;
    }

    /** One service of every kind, named so that alphabetical order is known. */
    async function seedOneOfEachKind(environmentId: string) {
      const secret = 'super-secret-database-password';
      const [app] = await ctx.db
        .insert(application)
        .values({
          name: 'app',
          environmentId,
          configName: seededConfigName(),
          env: 'APP_TOKEN=secret-env',
        })
        .returning();
      const [stack] = await ctx.db
        .insert(compose)
        .values({
          name: 'compose',
          environmentId,
          configName: seededConfigName(),
        })
        .returning();
      const [sqld] = await ctx.db
        .insert(libsql)
        .values({
          name: 'libsql',
          environmentId,
          configName: seededConfigName(),
          databaseUser: 'sqld',
          databasePassword: secret,
        })
        .returning();
      const [maria] = await ctx.db
        .insert(mariadb)
        .values({
          name: 'mariadb',
          environmentId,
          configName: seededConfigName(),
          databaseName: 'maria',
          databaseUser: 'maria',
          databasePassword: secret,
          databaseRootPassword: secret,
        })
        .returning();
      const [documents] = await ctx.db
        .insert(mongo)
        .values({
          name: 'mongo',
          environmentId,
          configName: seededConfigName(),
          databaseUser: 'mongo',
          databasePassword: secret,
        })
        .returning();
      const [my] = await ctx.db
        .insert(mysql)
        .values({
          name: 'mysql',
          environmentId,
          configName: seededConfigName(),
          databaseName: 'my',
          databaseUser: 'my',
          databasePassword: secret,
          databaseRootPassword: secret,
        })
        .returning();
      const [pg] = await ctx.db
        .insert(postgres)
        .values({
          name: 'postgres',
          environmentId,
          configName: seededConfigName(),
          databaseName: 'pg',
          databaseUser: 'pg',
          databasePassword: secret,
        })
        .returning();
      const [cache] = await ctx.db
        .insert(redis)
        .values({
          name: 'redis',
          environmentId,
          configName: seededConfigName(),
          databasePassword: secret,
        })
        .returning();

      return {
        secret,
        // In the alphabetical order the read reports them.
        expected: [
          { serviceType: 'application', serviceId: app.applicationId },
          { serviceType: 'compose', serviceId: stack.composeId },
          { serviceType: 'libsql', serviceId: sqld.libsqlId },
          { serviceType: 'mariadb', serviceId: maria.mariadbId },
          { serviceType: 'mongo', serviceId: documents.mongoId },
          { serviceType: 'mysql', serviceId: my.mysqlId },
          { serviceType: 'postgres', serviceId: pg.postgresId },
          { serviceType: 'redis', serviceId: cache.redisId },
        ],
      };
    }

    it('names each application in the environment', async () => {
      const { ownerSession, ownerCtx, project } = await setUpProject();
      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const api = await seedApplication(env.environmentId, 'api');

      const res = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      const body = res.body as { services: EnvironmentServiceSummary[] };
      expect(body.services).toEqual([
        {
          serviceType: 'application',
          serviceId: api.applicationId,
          name: 'api',
          appName: api.appName,
          configName: api.configName,
          description: null,
          status: 'idle',
          serverId: null,
          createdAt: api.createdAt,
        },
      ]);
    });

    it('names applications, compose stacks and all six database engines', async () => {
      const { ownerSession, ownerCtx, project } = await setUpProject();
      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const { expected } = await seedOneOfEachKind(env.environmentId);

      const res = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      const body = res.body as { services: EnvironmentServiceSummary[] };
      expect(
        body.services.map((s) => ({
          serviceType: s.serviceType,
          serviceId: s.serviceId,
        })),
      ).toEqual(expected);
      // Each summary is complete enough to render a row and follow the id.
      expect(body.services.map((s) => s.name)).toEqual([
        'app',
        'compose',
        'libsql',
        'mariadb',
        'mongo',
        'mysql',
        'postgres',
        'redis',
      ]);
      for (const service of body.services) {
        expect(service.appName).toEqual(expect.any(String));
        expect(service.status).toBe('idle');
        expect(service.serverId).toBeNull();
        expect(service.createdAt).toEqual(expect.any(String));
      }
    });

    it('an environment with nothing deployed reports an empty list', async () => {
      const { ownerSession, ownerCtx, project } = await setUpProject();
      const env = await environments.create(ownerCtx, {
        name: 'empty',
        projectId: project.projectId,
      });

      const res = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);
      expect((res.body as { services: unknown[] }).services).toEqual([]);
    });

    it('only the services of the environment asked for', async () => {
      const { ownerSession, ownerCtx, project } = await setUpProject();
      const here = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const elsewhere = await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      await seedApplication(here.environmentId, 'mine');
      await seedApplication(elsewhere.environmentId, 'theirs');

      const res = await request(server)
        .get(`/environments/${here.environmentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(
        (res.body as { services: EnvironmentServiceSummary[] }).services.map(
          (s) => s.name,
        ),
      ).toEqual(['mine']);
    });

    it('carries no credential of any service it names', async () => {
      const { ownerSession, ownerCtx, project } = await setUpProject();
      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const { secret } = await seedOneOfEachKind(env.environmentId);

      const res = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      const body = res.body as { services: EnvironmentServiceSummary[] };
      expect(JSON.stringify(body.services)).not.toContain(secret);
      expect(JSON.stringify(body.services)).not.toContain('secret-env');
      // A summary is exactly these keys, so no column can arrive unnoticed.
      for (const service of body.services) {
        expect(Object.keys(service).sort()).toEqual([
          'appName',
          'configName',
          'createdAt',
          'description',
          'name',
          'serverId',
          'serviceId',
          'serviceType',
          'status',
        ]);
      }
    });

    it('an environment in another organization reads as absent, services and all', async () => {
      const { ownerSession } = await setUpProject();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const orgBProject = await projects.create(secondOrgCtx, {
        name: 'org-b',
      });
      const orgBEnv = await environments.create(secondOrgCtx, {
        name: 'org-b-only',
        projectId: orgBProject.projectId,
      });
      await seedApplication(orgBEnv.environmentId, 'org-b-app');

      // The session's active organization is still the first one.
      const res = await request(server)
        .get(`/environments/${orgBEnv.environmentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('org-b-app');
    });

    // This test used to grant the Environment alone and expect its
    // service back — the leak itself, written down as the contract. The
    // Environment grant decides whether the read answers at all; the service
    // grants decide which services it names.
    it('a member reads an environment granted to them, naming only the services granted', async () => {
      const { ownerSession, ownerCtx, organizationId, project } =
        await setUpProject();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      await seedApplication(env.environmentId, 'api');
      const worker = await seedApplication(env.environmentId, 'worker');

      const refused = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', invitee.cookie);
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).not.toContain('api');

      const permissions = ctx.app.get(PermissionService);
      await permissions.addNewEnvironment(inviteeCtx, env.environmentId);

      // The Environment but no service: an empty list, not every service.
      const noServices = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', invitee.cookie);
      expect(noServices.status).toBe(200);
      expect(
        (noServices.body as { services: EnvironmentServiceSummary[] }).services,
      ).toEqual([]);

      await permissions.addNewService(inviteeCtx, worker.applicationId);

      const granted = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', invitee.cookie);
      expect(granted.status).toBe(200);
      expect(
        (
          granted.body as { services: EnvironmentServiceSummary[] }
        ).services.map((s) => s.name),
      ).toEqual(['worker']);
      expect(JSON.stringify(granted.body)).not.toContain('"api"');
    });

    it('an admin reads every service in the environment without a grant', async () => {
      const { ownerSession, ownerCtx, project } = await setUpProject();
      const admin = await inviteUser(
        server,
        ownerSession.cookie,
        'admin@example.com',
        'admin',
      );

      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      await seedApplication(env.environmentId, 'api');
      await seedApplication(env.environmentId, 'worker');

      const res = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', admin.cookie);
      expect(res.status).toBe(200);
      expect(
        (res.body as { services: EnvironmentServiceSummary[] }).services.map(
          (s) => s.name,
        ),
      ).toEqual(['api', 'worker']);
    });
  });

  describe('update', () => {
    it('changes the given fields and leaves the rest untouched', async () => {
      const { ownerCtx, project } = await setUpProject();

      const created = await environments.create(ownerCtx, {
        name: 'before',
        projectId: project.projectId,
        env: 'API_KEY=old',
      });

      const updated = await environments.update(
        ownerCtx,
        created.environmentId,
        { name: 'after', env: 'API_KEY=new' },
      );
      expect(updated).toMatchObject({
        environmentId: created.environmentId,
        name: 'after',
        env: 'API_KEY=new',
        projectId: project.projectId,
      });

      const renamedOnly = await environments.update(
        ownerCtx,
        created.environmentId,
        { name: 'final' },
      );
      expect(renamedOnly.env).toBe('API_KEY=new');

      const found = await environments.findOne(ownerCtx, created.environmentId);
      expect(found.name).toBe('final');
      expect(found.env).toBe('API_KEY=new');
    });

    it('writes a description onto an environment created without one', async () => {
      const { ownerCtx, project } = await setUpProject();

      const created = await environments.create(ownerCtx, {
        name: 'canary-eu',
        projectId: project.projectId,
      });
      expect(created.description).toBeNull();

      const updated = await environments.update(
        ownerCtx,
        created.environmentId,
        { description: 'EU traffic, 5% of production' },
      );
      expect(updated.description).toBe('EU traffic, 5% of production');

      const found = await environments.findOne(ownerCtx, created.environmentId);
      expect(found.description).toBe('EU traffic, 5% of production');
    });

    it('a rename leaves the description untouched', async () => {
      const { ownerCtx, project } = await setUpProject();

      const created = await environments.create(ownerCtx, {
        name: 'demo-acme',
        projectId: project.projectId,
        description: 'kept as-is',
      });

      const renamed = await environments.update(
        ownerCtx,
        created.environmentId,
        { name: 'demo-acme-2' },
      );
      expect(renamed).toMatchObject({
        name: 'demo-acme-2',
        description: 'kept as-is',
      });
    });
  });

  describe('remove', () => {
    it('deletes the environment', async () => {
      const { ownerCtx, project } = await setUpProject();

      const created = await environments.create(ownerCtx, {
        name: 'doomed',
        projectId: project.projectId,
      });

      const removed = await environments.remove(
        ownerCtx,
        created.environmentId,
      );
      expect(removed.environmentId).toBe(created.environmentId);

      await expect(
        environments.findOne(ownerCtx, created.environmentId),
      ).rejects.toThrow(NotFoundException);
    });

    it('removing the parent project cascades its environments', async () => {
      const { ownerCtx, project } = await setUpProject();

      await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });

      await projects.remove(ownerCtx, project.projectId);

      const raw = await ctx.db.$client.query(
        'select environment_id from environment where project_id = $1',
        [project.projectId],
      );
      expect(raw.rows).toEqual([]);
    });
  });

  describe('cross-project/org isolation', () => {
    it('an environment is invisible outside its own organization', async () => {
      const { ownerSession, organizationId } = await setUpProject();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const orgBProject = await projects.create(secondOrgCtx, {
        name: 'org-b',
      });
      const orgBEnv = await environments.create(secondOrgCtx, {
        name: 'org-b-only',
        projectId: orgBProject.projectId,
      });

      // Same user, but acting in the first organization: the environment
      // from the second organization must not resolve, even for its creator.
      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        environments.findOne(firstOrgCtx, orgBEnv.environmentId),
      ).rejects.toThrow(NotFoundException);
      expect(
        await environments.listByProject(firstOrgCtx, orgBProject.projectId),
      ).toEqual([]);
    });

    it('a member without a row-level grant cannot read an environment in their own organization', async () => {
      const { ownerSession, ownerCtx, organizationId, project } =
        await setUpProject();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const created = await environments.create(ownerCtx, {
        name: 'ungranted',
        projectId: project.projectId,
      });

      await expect(
        environments.findOne(inviteeCtx, created.environmentId),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('a name is unique in its Project', () => {
    const conflict =
      'An Environment with this name already exists in this Project';

    it('POST /environments refuses a name already in the Project, in any letter case', async () => {
      const { ownerSession, project } = await setUpProject();
      const cookie = ownerSession.cookie;
      const first = await request(server)
        .post('/environments')
        .set('Cookie', cookie)
        .send({ name: 'staging', projectId: project.projectId });
      expect(first.status).toBe(201);

      for (const name of ['staging', 'Staging', ' STAGING ']) {
        const res = await request(server)
          .post('/environments')
          .set('Cookie', cookie)
          .send({ name, projectId: project.projectId });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ message: conflict });
      }
      const listed = await request(server)
        .get(`/environments?projectId=${project.projectId}`)
        .set('Cookie', cookie);
      expect((listed.body as { name: string }[]).map((e) => e.name)).toEqual([
        'staging',
      ]);
    });

    it('PATCH /environments/:id refuses a rename onto another Environment, in any letter case', async () => {
      const { ownerCtx, ownerSession, project } = await setUpProject();
      await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      const other = await environments.create(ownerCtx, {
        name: 'qa',
        projectId: project.projectId,
      });

      const res = await request(server)
        .patch(`/environments/${other.environmentId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'Staging' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ message: conflict });
      expect(
        (await environments.findOne(ownerCtx, other.environmentId)).name,
      ).toBe('qa');
    });

    it('an Environment may be renamed to a new letter case of its own name', async () => {
      const { ownerCtx, project } = await setUpProject();
      const created = await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      await expect(
        environments.update(ownerCtx, created.environmentId, {
          name: 'Staging',
        }),
      ).resolves.toMatchObject({ name: 'Staging' });
    });

    it('the same name in another Project is still allowed', async () => {
      const { ownerCtx, project } = await setUpProject();
      const second = await projects.create(ownerCtx, { name: 'second' });
      await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      await expect(
        environments.create(ownerCtx, {
          name: 'Staging',
          projectId: second.projectId,
        }),
      ).resolves.toMatchObject({ name: 'Staging' });
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD round-trip over HTTP', async () => {
      const { ownerSession, project } = await setUpProject();
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/environments')
        .set('Cookie', cookie)
        .send({
          name: 'production',
          projectId: project.projectId,
          description: 'serves customers',
          env: 'A=1',
        });
      expect(created.status).toBe(201);
      const id = (created.body as { environmentId: string }).environmentId;

      const listed = await request(server)
        .get(`/environments?projectId=${project.projectId}`)
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(
        (listed.body as { environmentId: string }[]).map(
          (e) => e.environmentId,
        ),
      ).toEqual([id]);
      // The list is what the Project screen renders a sub-line from.
      expect(listed.body).toMatchObject([{ description: 'serves customers' }]);

      const one = await request(server)
        .get(`/environments/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        name: 'production',
        description: 'serves customers',
        env: 'A=1',
      });

      const patched = await request(server)
        .patch(`/environments/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'prod', description: 'now documented' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        name: 'prod',
        description: 'now documented',
        env: 'A=1',
      });

      const removed = await request(server)
        .delete(`/environments/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/environments/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });

    it('POST /environments returns 403 for a member and 201 for the owner', async () => {
      const { ownerSession, project } = await setUpProject();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      const denied = await request(server)
        .post('/environments')
        .set('Cookie', invitee.cookie)
        .send({ name: 'not-allowed', projectId: project.projectId });
      expect(denied.status).toBe(403);

      const allowed = await request(server)
        .post('/environments')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'allowed', projectId: project.projectId });
      expect(allowed.status).toBe(201);
      expect(allowed.body).toMatchObject({ name: 'allowed' });
    });
  });
});
