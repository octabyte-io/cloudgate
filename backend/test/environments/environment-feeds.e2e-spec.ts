import { getTableColumns } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  application,
  compose,
  destination,
  domain,
  postgres,
  schedule,
  volumeBackup,
} from '../../src/db/schema';
import { deployment } from '../../src/deployments/deployment.schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { seededConfigName } from '../utils/seeded-config-name';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

// an Environment's Deployments and Domains tabs were stated
// absences. Both feeds are keyed by a *service* id, so a client composing
// either one means a request per service on every open — the fan-out an
// earlier design refused to ship undecided. These two routes are the decision: one
// Environment-scoped read per tab, over the same service → environment →
// project join `GET /deployments` already writes for the Organization.

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

interface FeedRow {
  deploymentId: string;
  title: string;
  status: string;
  createdAt: string;
  owner: { type: string; id: string; name: string };
  service: { serviceType: string; serviceId: string; name: string };
}

interface DomainRow {
  domainId: string;
  host: string;
  service: { serviceType: string; serviceId: string; name: string };
}

describe("An Environment's Deployments and Domains feeds (e2e)", () => {
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

  /** An owner acting in their bootstrap organization, with a project. */
  async function setUpProject(name = 'cloudgate') {
    const session = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(session.id, organizationId);
    const project = await projects.create(ownerCtx, { name });
    return { session, organizationId, ownerCtx, project };
  }

  /** Services are seeded directly: the reads are what is under test, not
   * whichever lifecycle routes the service modules happen to expose. */
  const seedApplication = async (environmentId: string, name: string) => {
    const [row] = await ctx.db
      .insert(application)
      .values({ name, environmentId, configName: seededConfigName() })
      .returning();
    return row;
  };

  const seedCompose = async (environmentId: string, name: string) => {
    const [row] = await ctx.db
      .insert(compose)
      .values({ name, environmentId, configName: seededConfigName() })
      .returning();
    return row;
  };

  /** A recorded attempt with an explicit timestamp, so ordering assertions
   * never depend on clock resolution. */
  const record = (values: {
    createdAt: string;
    title?: string;
    status?: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
    applicationId?: string;
    composeId?: string;
  }) =>
    ctx.db
      .insert(deployment)
      .values({
        title: values.title ?? 'Manual deployment',
        logPath: '/etc/cloudgate/logs/x.log',
        status: values.status ?? 'done',
        ...values,
      })
      .returning();

  describe('GET /environments/:id/deployments', () => {
    it("names every build of the Environment's own services, newest first", async () => {
      const { session, ownerCtx, project } = await setUpProject();
      const here = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const elsewhere = await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });

      const api = await seedApplication(here.environmentId, 'api');
      const stack = await seedCompose(here.environmentId, 'edge');
      const other = await seedApplication(elsewhere.environmentId, 'theirs');

      await record({
        applicationId: api.applicationId,
        title: 'first',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await record({
        composeId: stack.composeId,
        title: 'second',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      await record({
        applicationId: other.applicationId,
        title: 'not here',
        createdAt: '2026-01-03T00:00:00.000Z',
      });

      const res = await request(server)
        .get(`/environments/${here.environmentId}/deployments`)
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);

      const rows = res.body as FeedRow[];
      expect(rows.map((row) => row.title)).toEqual(['second', 'first']);
      expect(rows[0].service).toEqual({
        serviceType: 'compose',
        serviceId: stack.composeId,
        name: 'edge',
      });
      expect(rows[0].owner).toEqual({
        type: 'compose',
        id: stack.composeId,
        name: 'edge',
      });
      expect(rows[1].service.serviceId).toBe(api.applicationId);
    });

    it('resolves a scheduled run to its own cron entry and to the service under it', async () => {
      const { session, ownerCtx, organizationId, project } =
        await setUpProject();
      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const api = await seedApplication(env.environmentId, 'api');

      const [nightly] = await ctx.db
        .insert(schedule)
        .values({
          name: 'prune sessions',
          cronExpression: '0 3 * * *',
          command: 'rails db:sessions:trim',
          scheduleType: 'application',
          applicationId: api.applicationId,
        })
        .returning();

      // A cloudgate-server schedule owns no service at all, so it belongs to
      // the Organization rather than to any Environment.
      const [host] = await ctx.db
        .insert(schedule)
        .values({
          name: 'vacuum the host',
          cronExpression: '0 4 * * *',
          command: '',
          script: 'docker system prune -f',
          scheduleType: 'cloudgate-server',
          organizationId,
        })
        .returning();

      await ctx.db.insert(deployment).values({
        title: 'scheduled run',
        logPath: '/etc/cloudgate/logs/s.log',
        status: 'done',
        scheduleId: nightly.scheduleId,
        createdAt: '2026-02-01T00:00:00.000Z',
      });
      await ctx.db.insert(deployment).values({
        title: 'host run',
        logPath: '/etc/cloudgate/logs/h.log',
        status: 'done',
        scheduleId: host.scheduleId,
        createdAt: '2026-02-02T00:00:00.000Z',
      });

      const res = await request(server)
        .get(`/environments/${env.environmentId}/deployments`)
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);

      const rows = res.body as FeedRow[];
      expect(rows.map((row) => row.title)).toEqual(['scheduled run']);
      expect(rows[0].owner).toEqual({
        type: 'schedule',
        id: nightly.scheduleId,
        name: 'prune sessions',
      });
      // The owner names the cron entry; the service is why it is in this feed.
      expect(rows[0].service).toEqual({
        serviceType: 'application',
        serviceId: api.applicationId,
        name: 'api',
      });
    });

    it("resolves a volume backup's run to the database it backs up", async () => {
      const { session, ownerCtx, organizationId, project } =
        await setUpProject();
      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const [db] = await ctx.db
        .insert(postgres)
        .values({
          name: 'orders',
          environmentId: env.environmentId,
          configName: seededConfigName(),
          databaseName: 'orders',
          databaseUser: 'orders',
          databasePassword: 'super-secret-database-password',
        })
        .returning();
      const [store] = await ctx.db
        .insert(destination)
        .values({
          name: 'backups',
          accessKey: 'key',
          secretAccessKey: 'secret',
          bucket: 'bucket',
          region: 'eu-west-1',
          endpoint: 'https://s3.example.com',
          organizationId,
        })
        .returning();
      const [snapshot] = await ctx.db
        .insert(volumeBackup)
        .values({
          name: 'orders data',
          volumeName: 'orders-data',
          prefix: 'orders/',
          serviceType: 'postgres',
          postgresId: db.postgresId,
          schedule: '0 2 * * *',
          destinationId: store.destinationId,
        })
        .returning();

      await ctx.db.insert(deployment).values({
        title: 'volume backup run',
        logPath: '/etc/cloudgate/logs/v.log',
        status: 'done',
        volumeBackupId: snapshot.volumeBackupId,
        createdAt: '2026-03-01T00:00:00.000Z',
      });

      const res = await request(server)
        .get(`/environments/${env.environmentId}/deployments`)
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);

      const rows = res.body as FeedRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0].owner).toEqual({
        type: 'volumeBackup',
        id: snapshot.volumeBackupId,
        name: 'orders data',
      });
      expect(rows[0].service).toEqual({
        serviceType: 'postgres',
        serviceId: db.postgresId,
        name: 'orders',
      });
    });

    it('an Environment with nothing deployed reports an empty feed', async () => {
      const { session, ownerCtx, project } = await setUpProject();
      const env = await environments.create(ownerCtx, {
        name: 'empty',
        projectId: project.projectId,
      });

      const res = await request(server)
        .get(`/environments/${env.environmentId}/deployments`)
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /environments/:id/domains', () => {
    /** A host on a service, seeded directly like the services themselves. */
    const seedDomain = (
      host: string,
      parent: { applicationId?: string; composeId?: string },
    ) =>
      ctx.db
        .insert(domain)
        .values({ host, ...parent })
        .returning();

    it('gathers the hosts of every service here, and names which answers each', async () => {
      const { session, ownerCtx, project } = await setUpProject();
      const here = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const elsewhere = await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });

      const api = await seedApplication(here.environmentId, 'api');
      const stack = await seedCompose(here.environmentId, 'edge');
      const other = await seedApplication(elsewhere.environmentId, 'theirs');

      await seedDomain('api.example.com', { applicationId: api.applicationId });
      await seedDomain('edge.example.com', { composeId: stack.composeId });
      await seedDomain('staging.example.com', {
        applicationId: other.applicationId,
      });

      const res = await request(server)
        .get(`/environments/${here.environmentId}/domains`)
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);

      const rows = res.body as DomainRow[];
      expect(rows.map((row) => row.host)).toEqual([
        'api.example.com',
        'edge.example.com',
      ]);
      expect(rows[0].service).toEqual({
        serviceType: 'application',
        serviceId: api.applicationId,
        name: 'api',
      });
      expect(rows[1].service).toEqual({
        serviceType: 'compose',
        serviceId: stack.composeId,
        name: 'edge',
      });
    });

    it("carries the whole domain row, including the domain's own serviceName", async () => {
      const { session, ownerCtx, project } = await setUpProject();
      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const stack = await seedCompose(env.environmentId, 'edge');
      // `domain.serviceName` is which service *inside the stack* answers, and it
      // is the one column a feed joining a "service" relation can lose by
      // accident — a Compose domain that does not name one makes the next deploy
      // throw, so a screen reading this feed has to see it.
      await ctx.db.insert(domain).values({
        host: 'edge.example.com',
        composeId: stack.composeId,
        serviceName: 'web',
        domainType: 'compose',
        port: 8080,
      });

      const res = await request(server)
        .get(`/environments/${env.environmentId}/domains`)
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);

      const [row] = res.body as DomainRow[];
      expect(row).toMatchObject({
        host: 'edge.example.com',
        serviceName: 'web',
        port: 8080,
        composeId: stack.composeId,
      });
      // Every column of the row plus exactly two added keys — the answering
      // `service`, and the `storedCertificate` Traefik serves for the host
      // — so neither a lost column nor a smuggled one passes unnoticed.
      expect(Object.keys(row).sort()).toEqual(
        [
          ...Object.keys(getTableColumns(domain)),
          'service',
          'storedCertificate',
        ].sort(),
      );
    });

    it('an Environment whose services have no host reports an empty feed', async () => {
      const { session, ownerCtx, project } = await setUpProject();
      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      // A managed database has no domains at all — nothing routes to one from
      // outside — so an Environment holding only one is genuinely empty here.
      await ctx.db.insert(postgres).values({
        name: 'orders',
        environmentId: env.environmentId,
        configName: seededConfigName(),
        databaseName: 'orders',
        databaseUser: 'orders',
        databasePassword: 'super-secret-database-password',
      });

      const res = await request(server)
        .get(`/environments/${env.environmentId}/domains`)
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('both feeds and the Environment read are scoped to the grant', () => {
    /** An Environment in a second organization of the same owner, holding one
     * Application with one deployment and one host. The second organization is
     * created through `POST /organizations` rather than a second sign-up,
     * because a second `POST /api/auth/sign-up/email` answers 400. */
    async function setUpOtherOrganization(ownerCookie: string, userId: string) {
      const created = await createOrganization(server, ctx.db, ownerCookie, {
        name: 'Second Org',
      });
      const organizationId = (created.body as { id: string }).id;

      const otherCtx = permissionCtx(userId, organizationId);
      const otherProject = await projects.create(otherCtx, { name: 'org-b' });
      const env = await environments.create(otherCtx, {
        name: 'org-b-only',
        projectId: otherProject.projectId,
      });
      const app = await seedApplication(env.environmentId, 'org-b-app');
      await record({
        applicationId: app.applicationId,
        title: 'org-b deployment',
        createdAt: '2026-04-01T00:00:00.000Z',
      });
      await ctx.db.insert(domain).values({
        host: 'org-b.example.com',
        applicationId: app.applicationId,
      });
      return { environmentId: env.environmentId };
    }

    it('an Environment in another organization reads as absent on both feeds', async () => {
      const { session } = await setUpProject();
      const other = await setUpOtherOrganization(session.cookie, session.id);

      // The session's active organization is still the first one.
      for (const feed of ['deployments', 'domains']) {
        const res = await request(server)
          .get(`/environments/${other.environmentId}/${feed}`)
          .set('Cookie', session.cookie);
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('org-b');
      }
    });

    it('a member is refused until the Environment is granted, then the read and both feeds name only the services granted', async () => {
      const { session, ownerCtx, organizationId, project } =
        await setUpProject();
      const invitee = await inviteUser(
        server,
        session.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const env = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const granted = await seedApplication(env.environmentId, 'granted');
      const hidden = await seedApplication(env.environmentId, 'hidden');
      await record({
        applicationId: granted.applicationId,
        title: 'granted build',
        createdAt: '2026-05-01T00:00:00.000Z',
      });
      await record({
        applicationId: hidden.applicationId,
        title: 'hidden build',
        createdAt: '2026-05-02T00:00:00.000Z',
      });
      await ctx.db.insert(domain).values([
        { host: 'granted.example.com', applicationId: granted.applicationId },
        { host: 'hidden.example.com', applicationId: hidden.applicationId },
      ]);

      // No grant on the Environment: refused before any history is touched,
      // exactly as `GET /environments/:id` is.
      for (const feed of ['deployments', 'domains']) {
        const refused = await request(server)
          .get(`/environments/${env.environmentId}/${feed}`)
          .set('Cookie', invitee.cookie);
        expect(refused.status).toBe(403);
        expect(JSON.stringify(refused.body)).not.toContain('hidden');
      }

      const permissions = ctx.app.get(PermissionService);
      await permissions.addNewEnvironment(inviteeCtx, env.environmentId);

      // Granted the Environment but no service: an empty feed, not every row.
      const noServices = await request(server)
        .get(`/environments/${env.environmentId}/deployments`)
        .set('Cookie', invitee.cookie);
      expect(noServices.status).toBe(200);
      expect(noServices.body).toEqual([]);

      // …and the Environment read beside them names no service either.
      const noneListed = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', invitee.cookie);
      expect(noneListed.status).toBe(200);
      expect((noneListed.body as { services: unknown[] }).services).toEqual([]);

      await permissions.addNewService(inviteeCtx, granted.applicationId);

      // The read the Services screen draws from was the one that skipped
      // the grant, listing `hidden` beside `granted`.
      const read = await request(server)
        .get(`/environments/${env.environmentId}`)
        .set('Cookie', invitee.cookie);
      expect(read.status).toBe(200);
      expect(
        (read.body as { services: { serviceId: string }[] }).services.map(
          (service) => service.serviceId,
        ),
      ).toEqual([granted.applicationId]);
      expect(JSON.stringify(read.body)).not.toContain(hidden.applicationId);

      const feed = await request(server)
        .get(`/environments/${env.environmentId}/deployments`)
        .set('Cookie', invitee.cookie);
      expect(feed.status).toBe(200);
      expect((feed.body as FeedRow[]).map((row) => row.title)).toEqual([
        'granted build',
      ]);

      const hosts = await request(server)
        .get(`/environments/${env.environmentId}/domains`)
        .set('Cookie', invitee.cookie);
      expect(hosts.status).toBe(200);
      expect((hosts.body as DomainRow[]).map((row) => row.host)).toEqual([
        'granted.example.com',
      ]);
    });
  });
});
