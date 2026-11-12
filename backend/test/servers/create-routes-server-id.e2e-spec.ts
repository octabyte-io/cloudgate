import request from 'supertest';
import { App } from 'supertest/types';
import { server as serverTable } from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(180_000);

/**
 * Nine create routes accepted a `serverId` and never looked at it, so an
 * unknown id reached a foreign key and `DrizzleQueryError` became a 500 for
 * what is a 404 — and because the check was the database's, it could not be
 * organization-scoped: `application.server_id → server.server_id` names no
 * organization column, so any existing `server_id` satisfied the constraint,
 * whoever owned it. Driven over HTTP rather than through the services, because
 * the status code is the subject.
 *
 * One table for all nine, so a tenth create route added later is one row. Six
 * of the nine are the same insertion point — every engine's `create` delegates
 * to `BaseDatabaseService.createDatabase` — but they are driven separately
 * anyway, because the claim being pinned is about the HTTP surface and a later
 * engine that stops delegating would otherwise go unnoticed.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const pem = {
  certificateData:
    '-----BEGIN CERTIFICATE-----\nMIIBszCCAVo=\n-----END CERTIFICATE-----',
  privateKey:
    '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBM=\n-----END PRIVATE KEY-----',
};

/**
 * Every field each route's own `create*Schema` makes required, and nothing
 * else. Filled from the schemas rather than guessed: a validation 400 would
 * satisfy a bare 404-was-not-500 assertion for entirely the wrong reason, which
 * is why every case below asserts the message as well as the status.
 *
 * `environmentScoped: false` is `/certificates`, which takes PEM material and
 * no `environmentId` — it is the one create on this list whose row is scoped by
 * `organizationId` directly.
 */
const routes = [
  {
    path: '/applications',
    table: 'application',
    environmentScoped: true,
    body: { name: 'a', appName: 'a-1' },
  },
  {
    path: '/compose',
    table: 'compose',
    environmentScoped: true,
    body: { name: 'c', appName: 'c-1' },
  },
  {
    path: '/postgres',
    table: 'postgres',
    environmentScoped: true,
    body: { name: 'p', appName: 'p-1', databaseName: 'd', databaseUser: 'u' },
  },
  {
    path: '/mysql',
    table: 'mysql',
    environmentScoped: true,
    body: { name: 'm', appName: 'm-1', databaseName: 'd', databaseUser: 'u' },
  },
  {
    // The original route list omitted /mariadb while its "Where" line named
    // mariadb.service.ts: it was simply never probed, and it is the same
    // createDatabase as the other five.
    path: '/mariadb',
    table: 'mariadb',
    environmentScoped: true,
    body: { name: 'r', appName: 'r-1', databaseName: 'd', databaseUser: 'u' },
  },
  {
    path: '/mongo',
    table: 'mongo',
    environmentScoped: true,
    body: { name: 'g', appName: 'g-1', databaseUser: 'u' },
  },
  {
    path: '/redis',
    table: 'redis',
    environmentScoped: true,
    body: { name: 'e', appName: 'e-1' },
  },
  {
    path: '/libsql',
    table: 'libsql',
    environmentScoped: true,
    body: { name: 'l', appName: 'l-1', databaseUser: 'u' },
  },
  {
    path: '/certificates',
    table: 'certificate',
    environmentScoped: false,
    body: { name: 'wildcard-example-com', ...pem },
  },
] as const;

type Route = (typeof routes)[number];

async function signUp(
  http: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(http).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

describe('Create routes: serverId ownership (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
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
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
  });

  /** The owner's bootstrap organization plus somewhere for services to land. */
  async function setUp() {
    const ownerSession = await signUp(http, owner);
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;

    const ownerCtx = permissionCtx(ownerSession.id, organizationId);
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    return { organizationId, ownerSession, environment };
  }

  /**
   * A **real** `server` row in a **second** organization, not an id nothing
   * owns. `checkServerAccess` runs one `serverId = ? AND organizationId = ?`
   * select and raises the same NotFound whichever predicate misses, so the
   * `serverId: 'server-1'` fixture shape cannot tell a passing organization
   * check from one that never ran — which is how the cross-organization
   * hole survived a green suite. `2925032` fixed the same shape for
   * destinations; this is that helper.
   *
   * The second organization is created by the same owner, as in `2925032`:
   * only the first user bootstraps an organization (`auth.config.ts`'s
   * `bootstrapDefaultOrganization`), so a second signed-up owner is not a
   * shape this suite can reach. What matters is that the row exists and its
   * `organizationId` is not the caller's active one, which is the single
   * predicate under test.
   */
  async function insertForeignServer(cookie: string) {
    const created = await createOrganization(http, ctx.db, cookie, {
      name: 'other-tenant',
      slug: `other-${Date.now()}`,
    });
    const strangerOrgId = (created.body as { id: string }).id;
    expect(strangerOrgId).toEqual(expect.any(String));

    const [row] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'not-yours',
        ipAddress: '203.0.113.31',
        port: 22,
        organizationId: strangerOrgId,
      })
      .returning();
    return row;
  }

  const payload = (
    route: Route,
    environmentId: string,
    serverId?: string | null,
  ) => ({
    ...route.body,
    ...(route.environmentScoped ? { environmentId } : {}),
    ...(serverId === undefined ? {} : { serverId }),
  });

  async function rowCount(table: string): Promise<number> {
    const res = await ctx.db.$client.query<{ count: string }>(
      `select count(*)::text as count from "${table}"`,
    );
    return Number(res.rows[0].count);
  }

  it.each(routes)(
    'POST $path refuses an unknown serverId with 404 rather than 500',
    async (route) => {
      const { ownerSession, environment } = await setUp();

      const res = await request(http)
        .post(route.path)
        .set('Cookie', ownerSession.cookie)
        .send(
          payload(route, environment.environmentId, 'w03nonexistentid00000'),
        );

      expect(res.status).toBe(404);
      // The message, not just the status: a validation 400 cannot fake it, and
      // neither can any other 404 on the way in.
      expect((res.body as { message: string }).message).toBe(
        'Server not found',
      );
      // The pre-fix behaviour was a *failed* insert, so a fix that inserted and
      // then rolled back would also answer 404. Read the table back.
      expect(await rowCount(route.table)).toBe(0);
    },
  );

  it.each(routes)(
    'POST $path refuses a serverId in another organization with the same 404',
    async (route) => {
      const { ownerSession, environment } = await setUp();
      const theirs = await insertForeignServer(ownerSession.cookie);

      const res = await request(http)
        .post(route.path)
        .set('Cookie', ownerSession.cookie)
        .send(payload(route, environment.environmentId, theirs.serverId));

      // The second-order case the original fix offered as mechanism rather than
      // measurement: the foreign key it used to rely on names no organization,
      // so this id satisfied it and the row went in. Identical refusal to the
      // unknown id above, deliberately — the fleet must not be enumerable by
      // the difference.
      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Server not found',
      );
      expect(await rowCount(route.table)).toBe(0);
    },
  );

  it.each(routes)(
    'POST $path creates on the platform host when serverId is omitted',
    async (route) => {
      const { ownerSession, environment } = await setUp();

      const res = await request(http)
        .post(route.path)
        .set('Cookie', ownerSession.cookie)
        .send(payload(route, environment.environmentId));

      expect(res.status).toBe(201);
      expect((res.body as { serverId: string | null }).serverId).toBeNull();
    },
  );

  it.each(routes)(
    'POST $path creates on the platform host when serverId is null',
    async (route) => {
      const { ownerSession, environment } = await setUp();

      // Both spellings, because an earlier sweep widened these DTOs to `.nullish()` so they
      // accept the value the API itself hands out, and `checkServerAccess`'s
      // absent-id branch must not narrow that again.
      const res = await request(http)
        .post(route.path)
        .set('Cookie', ownerSession.cookie)
        .send(payload(route, environment.environmentId, null));

      expect(res.status).toBe(201);
      expect((res.body as { serverId: string | null }).serverId).toBeNull();
    },
  );
});
