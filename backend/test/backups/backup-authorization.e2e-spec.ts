import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { licenseKey, member, organizationRole } from '../../src/db/schema';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * The backup-authorization fix, over HTTP, in two halves.
 *
 * **The level.** `POST /backups`, `PATCH /backups/:id` and
 * `POST /backups/restore` reached `PermissionService.checkServiceAccess` with
 * no `action`, so `service: ['read']` on the backed-up Service authorized all
 * three — while a restore's effect is to overwrite that Service's database. The
 * three now claim `'update'`; `BackupsService.create` carries the argument.
 * That half is driven through a **licensed custom role**, because that is who
 * it changes anything for: all three static roles hold `service: ['update']`
 * (owner and admin outright, `memberRole`), so the only shape that
 * loses anything is a custom role granted `backup` actions beside
 * `service: ['read']`. The role is built the way `test/rbac/rbac.e2e-spec.ts`
 * builds one — a license key so an enterprise-only statement counts, an
 * `organization_role` row, and the Member moved onto it.
 *
 * **The prefix, which the level cannot reach.** A Destination's bucket is
 * organization-wide, and `memberRole` holds `service: ['read', 'update']` — so
 * a base Member entitled to Service A still passes the raised gate and, before
 * this, could name **Service B's** dump as `backupFile` and read B's data
 * through A. That half is driven through a plain Member with `accessedServices`
 * naming one of two Postgres Services, which is the entitlement column the
 * reach crossed.
 *
 * The Member is created with `signUpMember`, which *accepts* the invitation:
 * a fixture that stops at the sign-up hands back a session with no
 * `activeOrganizationId`, so every refusal asserted here would come from the
 * controller's own `toCtx` rather than from the gate under test.
 * Both Services are real rows with real `appName`s, for the same reason — a
 * `serviceId` with nothing behind it is refused by `findParentService` before
 * any gate is reached.
 */
describe('Backup authorization (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let postgres: PostgresService;
  let applications: ApplicationsService;
  let destinations: DestinationsService;
  let permissions: PermissionService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    postgres = ctx.app.get(PostgresService);
    applications = ctx.app.get(ApplicationsService);
    destinations = ctx.app.get(DestinationsService);
    permissions = ctx.app.get(PermissionService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  /**
   * One Project, one Environment, two Postgres Services and a Destination —
   * with the Member entitled to the **first** Service only. The second one's
   * `appName` is what the cross-Service assertions aim at: `ledger-db` is the
   * prefix its dumps live under, and it belongs to a Service this caller was
   * never entitled to.
   *
   * The backup the `PATCH` acts on is registered by the owner, so that route
   * has a row to reach without the caller under test having had to pass the
   * gate that is under test.
   */
  async function setUpFixture() {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);
    const ownerCookie = signUp.headers['set-cookie'];
    const ownerId = (signUp.body as { user: { id: string } }).user.id;

    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerCookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: ownerId },
      session: { activeOrganizationId: organizationId },
    };

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const entitled = await postgres.create(ownerCtx, {
      name: 'Main DB',
      appName: 'main-db',
      databaseName: 'shop',
      databaseUser: 'shop_user',
      databasePassword: 'sup3rS3cret',
      environmentId: environment.environmentId,
    });
    const refused = await postgres.create(ownerCtx, {
      name: 'Ledger DB',
      appName: 'ledger-db',
      databaseName: 'ledger',
      databaseUser: 'ledger_user',
      databasePassword: 'sup3rS3cret',
      environmentId: environment.environmentId,
    });
    // An Application, so the resolver's table set is under test and not only
    // its rule: the fix resolved six tables — the five engines plus compose — so
    // this `appName` read as *unowned* and a dump parked under it was
    // restorable by anyone the level let through. A follow-up widened it to
    // `serviceScope`'s eight, because a volume tarball's prefix is an
    // Application's as often as an engine's.
    const refusedApplication = await applications.create(ownerCtx, {
      name: 'Storefront',
      appName: 'storefront',
      environmentId: environment.environmentId,
    });
    const destination = await destinations.create(ownerCtx, {
      name: 'prod-backups',
      provider: 'Cloudflare',
      accessKey: 'AKIAEXAMPLEACCESSKEY',
      secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
      bucket: 'cloudgate-backups',
      region: 'auto',
      endpoint: 'https://accountid.r2.cloudflarestorage.com',
    });

    const registered = await request(server)
      .post('/backups')
      .set('Cookie', ownerCookie)
      .send({
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        destinationId: destination.destinationId,
        databaseType: 'postgres',
        serviceId: entitled.postgresId,
      });
    expect(registered.status).toBe(201);

    const invitee = await signUpMember(server, ownerCookie, {
      email: 'ida@example.com',
    });
    const [memberRow] = await ctx.db
      .select()
      .from(member)
      .where(eq(member.userId, invitee.id));
    await permissions.setMemberEntitlements(organizationId, memberRow.id, {
      accessedProjects: [project.projectId],
      accessedEnvironments: [environment.environmentId],
      accessedServices: [entitled.postgresId],
    });

    return {
      organizationId,
      ownerCookie,
      invitee,
      entitledServiceId: entitled.postgresId,
      entitledPrefix: entitled.appName,
      // Read back off the row rather than restated: the prefix a Service's
      // dumps live under *is* its `appName` column, which is the fact the
      // bound rests on.
      refusedPrefix: refused.appName,
      refusedApplicationPrefix: refusedApplication.appName,
      destinationId: destination.destinationId,
      backupId: (registered.body as { backupId: string }).backupId,
    };
  }

  /**
   * Moves the Member onto a licensed custom role holding `serviceActions` and
   * every `backup` action — so the only variable between the refusal block and
   * the capability block is the `service` line.
   */
  async function assignServiceRole(
    organizationId: string,
    userId: string,
    serviceActions: string[],
  ) {
    await ctx.db.insert(licenseKey).values({
      organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values({
      organizationId,
      role: 'backup-operator',
      permission: {
        ac: ['read'],
        service: serviceActions,
        backup: ['read', 'create', 'update', 'delete', 'restore'],
      },
    });
    await ctx.db
      .update(member)
      .set({ role: 'backup-operator' })
      .where(eq(member.userId, userId));
  }

  type Fixture = Awaited<ReturnType<typeof setUpFixture>>;

  /** The three writes the fix raised, as one request each against the fixture. */
  const writes = (fixture: Fixture) => [
    {
      route: 'POST /backups',
      send: (cookie: string) =>
        request(server).post('/backups').set('Cookie', cookie).send({
          schedule: '0 4 * * *',
          prefix: 'hourly',
          database: 'shop',
          destinationId: fixture.destinationId,
          databaseType: 'postgres',
          serviceId: fixture.entitledServiceId,
        }),
    },
    {
      route: 'PATCH /backups/{id}',
      send: (cookie: string) =>
        request(server)
          .patch(`/backups/${fixture.backupId}`)
          .set('Cookie', cookie)
          .send({ prefix: 'weekly' }),
    },
    {
      route: 'POST /backups/restore',
      send: (cookie: string) =>
        request(server)
          .post('/backups/restore')
          .set('Cookie', cookie)
          .send({
            databaseId: fixture.entitledServiceId,
            databaseType: 'postgres',
            databaseName: 'shop',
            backupFile: `${fixture.entitledPrefix}/daily/2026-07-23.sql.gz`,
            destinationId: fixture.destinationId,
          }),
    },
  ];

  describe('a licensed custom role holding service read', () => {
    it('refuses the register, the re-point and the restore', async () => {
      const fixture = await setUpFixture();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'read',
      ]);

      const answered: string[] = [];
      for (const { route, send } of writes(fixture)) {
        const res = await send(fixture.invitee.cookie);
        answered.push(`${route} -> ${res.status}`);
      }

      expect(answered).toEqual([
        'POST /backups -> 403',
        'PATCH /backups/{id} -> 403',
        'POST /backups/restore -> 403',
      ]);
    });

    it('reaches no host on the way to those three refusals', async () => {
      const fixture = await setUpFixture();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'read',
      ]);
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      for (const { send } of writes(fixture)) {
        await send(fixture.invitee.cookie);
      }

      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });
  });

  /**
   * The complement, from the same fixture so the pair cannot drift: the same
   * role with `service: ['read', 'update']` — which is exactly `memberRole`'s
   * line — is allowed every one of the three.
   */
  describe('the same role holding service read and update', () => {
    it('allows the register, the re-point and the restore', async () => {
      const fixture = await setUpFixture();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'read',
        'update',
      ]);

      const answered: string[] = [];
      for (const { route, send } of writes(fixture)) {
        const res = await send(fixture.invitee.cookie);
        answered.push(`${route} -> ${res.status}`);
      }

      expect(answered).toEqual([
        'POST /backups -> 201',
        'PATCH /backups/{id} -> 200',
        'POST /backups/restore -> 204',
      ]);
    });
  });

  /**
   * The fix's second half. The caller here is a plain Member — `memberRole` holds
   * `service: ['read', 'update']` and every `backup` action — so the level is
   * not what is being tested: the only thing separating these three requests is
   * which Service's prefix the key sits under.
   */
  describe('a member entitled to one of two services in the shared bucket', () => {
    it('refuses a restore of the other service’s dump into its own engine', async () => {
      const fixture = await setUpFixture();

      const res = await request(server)
        .post('/backups/restore')
        .set('Cookie', fixture.invitee.cookie)
        .send({
          databaseId: fixture.entitledServiceId,
          databaseType: 'postgres',
          databaseName: 'shop',
          backupFile: `${fixture.refusedPrefix}/daily/2026-07-23.sql.gz`,
          destinationId: fixture.destinationId,
        });

      expect(res.status).toBe(403);
      // The dump was never fetched and the engine never ran: the refusal is in
      // front of the script, not something the script declined to do.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('refuses a restore of a dump under an application’s prefix', async () => {
      const fixture = await setUpFixture();

      const res = await request(server)
        .post('/backups/restore')
        .set('Cookie', fixture.invitee.cookie)
        .send({
          databaseId: fixture.entitledServiceId,
          databaseType: 'postgres',
          databaseName: 'shop',
          backupFile: `${fixture.refusedApplicationPrefix}/daily/2026-07-23.sql.gz`,
          destinationId: fixture.destinationId,
        });

      expect(res.status).toBe(403);
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('allows a restore of its own service’s dump', async () => {
      const fixture = await setUpFixture();

      const res = await request(server)
        .post('/backups/restore')
        .set('Cookie', fixture.invitee.cookie)
        .send({
          databaseId: fixture.entitledServiceId,
          databaseType: 'postgres',
          databaseName: 'shop',
          backupFile: `${fixture.entitledPrefix}/daily/2026-07-23.sql.gz`,
          destinationId: fixture.destinationId,
        });

      expect(res.status).toBe(204);
      // …and the key it ran with is the one that was asked for, so this passes
      // for the right reason rather than by refusing later.
      const [script] = execMock.execAsync.mock.calls[0] as [string];
      expect(script).toContain('main-db/daily/2026-07-23.sql.gz');
    });

    /**
     * The decision `BackupsService.checkBackupFileAccess` argues: a prefix no
     * Service claims is the dump of a Service that was destroyed and recreated
     * — a new `appName`, so its predecessor's dumps are orphaned — or one
     * uploaded by hand, and refusing those refuses disaster recovery at the
     * moment it is needed.
     */
    it('allows a restore from a prefix no service claims', async () => {
      const fixture = await setUpFixture();

      const res = await request(server)
        .post('/backups/restore')
        .set('Cookie', fixture.invitee.cookie)
        .send({
          databaseId: fixture.entitledServiceId,
          databaseType: 'postgres',
          databaseName: 'shop',
          backupFile: 'main-db-before-the-rebuild/2026-07-23.sql.gz',
          destinationId: fixture.destinationId,
        });

      expect(res.status).toBe(204);
    });

    /**
     * The listing is the same reach in read-only form, and it is filtered
     * rather than refused — `BackupsService.visibleBackupFiles` says why. The
     * bucket answers with both Services' dumps; only one of them is this
     * caller's to see.
     */
    it('lists only its own service’s dumps out of the shared bucket', async () => {
      const fixture = await setUpFixture();
      const listing = [
        {
          Path: 'main-db/daily/2026-07-23.sql.gz',
          Name: '2026-07-23.sql.gz',
          Size: 1024,
          IsDir: false,
        },
        {
          Path: 'ledger-db/daily/2026-07-23.sql.gz',
          Name: '2026-07-23.sql.gz',
          Size: 2048,
          IsDir: false,
        },
        {
          Path: 'restored-by-hand/2026-07-23.sql.gz',
          Name: '2026-07-23.sql.gz',
          Size: 512,
          IsDir: false,
        },
      ];
      execMock.execAsync.mockResolvedValue({
        stdout: JSON.stringify(listing),
        stderr: '',
        exitCode: 0,
      });

      const member = await request(server)
        .get('/backups/files')
        .query({ destinationId: fixture.destinationId })
        .set('Cookie', fixture.invitee.cookie);
      const ownerListing = await request(server)
        .get('/backups/files')
        .query({ destinationId: fixture.destinationId })
        .set('Cookie', fixture.ownerCookie);

      expect(member.status).toBe(200);
      // The Member sees its own Service's dump and the unclaimed one; the owner
      // sees all three, so the filter is about entitlement and not about the
      // listing having been narrowed for everybody.
      expect(
        (member.body as { Path: string }[]).map((row) => row.Path),
      ).toEqual([
        'main-db/daily/2026-07-23.sql.gz',
        'restored-by-hand/2026-07-23.sql.gz',
      ]);
      expect(
        (ownerListing.body as { Path: string }[]).map((row) => row.Path),
      ).toEqual(listing.map((row) => row.Path));
    });
  });

  /**
   * The write side of the same prefix, and a finding rather than a precaution:
   * `normalizeS3Path` strips slashes and nothing else, so `prefix` used to be
   * able to climb out of the Service's own directory — putting its dumps, and
   * `pruneOldBackups`' `rclone delete`, under a sibling's.
   * `bucketKeySegments` carries it.
   */
  describe('a prefix that climbs out of the service’s own directory', () => {
    it('refuses it on the register and on the re-point', async () => {
      const fixture = await setUpFixture();

      const registered = await request(server)
        .post('/backups')
        .set('Cookie', fixture.ownerCookie)
        .send({
          schedule: '0 3 * * *',
          prefix: '../ledger-db/daily',
          database: 'shop',
          destinationId: fixture.destinationId,
          databaseType: 'postgres',
          serviceId: fixture.entitledServiceId,
        });
      const repointed = await request(server)
        .patch(`/backups/${fixture.backupId}`)
        .set('Cookie', fixture.ownerCookie)
        .send({ prefix: '../ledger-db/daily' });

      expect([registered.status, repointed.status]).toEqual([400, 400]);
    });
  });
});
