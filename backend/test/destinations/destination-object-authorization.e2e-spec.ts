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
 * Over HTTP. `GET /destinations/:id/objects` is the volume restore's file
 * picker, and it listed the **whole bucket** to any caller holding
 * `destination: ['read']` — a Destination's bucket is Organization-wide, so the
 * listing enumerated every Service's tarball and dump keys, and with them every
 * other Service's `appName`, backup cadence and retention. Since the
 * backup-authorization fixes bounded the *acting* half it was also offering rows
 * `POST /volume-backups/restore` and `POST /backups/restore` would refuse with a
 * 403, which is the property was recorded for containers: one definition decides
 * which rows a listing may show and which objects a restore may reach.
 *
 * **The caller is a licensed custom role, and that is a correction to the issue
 * rather than a convenience.** The issue says "anyone with `destination: ['read']`",
 * which is true as written and is a smaller set than it sounds: `destination` is
 * in `enterpriseOnlyResources`, `memberRole` holds `destination: []`, and
 * `checkPermission`'s enterprise bypass is owner/admin-only — so a plain static
 * Member is refused this route outright at the guard, and owner and admin are
 * privileged and see everything by design. The shape that both reaches the route
 * and is bounded by the filter is therefore a custom role granted
 * `destination: ['read']`, built the way `test/backups/backup-authorization.e2e-spec.ts`
 * builds one: a license key so an enterprise-only statement counts, an
 * `organization_role` row, and the Member moved onto it.
 *
 * The Member is created with `signUpMember`, which *accepts* the invitation — a
 * fixture that stops at the sign-up hands back a session with no
 * `activeOrganizationId`, so every refusal here would come from the controller's
 * own `toCtx` rather than from the filter under test. Both Services
 * are real rows and both prefixes are read back off their `appName` columns,
 * because the prefix a Service's objects live under *is* that column and a
 * fixture restating it would assert nothing.
 */
describe('Destination object listing authorization (e2e)', () => {
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
      .mockResolvedValue({ stdout: '[]', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '[]', stderr: '', exitCode: 0 });
  });

  /**
   * One Project, one Environment, an Application and a Postgres Service, a
   * Destination, and a Member entitled to the **Application** only — on a
   * licensed custom role holding `destination: ['read']`.
   *
   * The entitled Service is an Application on purpose: a volume tarball's
   * prefix is an Application's `appName` as often as an engine's, and the first
   * six-table resolver answered "unowned" for one, which is the widening a follow-up
   * landed and this filter inherits.
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
    const entitled = await applications.create(ownerCtx, {
      name: 'Storefront',
      appName: 'storefront',
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
    const destination = await destinations.create(ownerCtx, {
      name: 'prod-backups',
      provider: 'Cloudflare',
      accessKey: 'AKIAEXAMPLEACCESSKEY',
      secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
      bucket: 'cloudgate-backups',
      region: 'auto',
      endpoint: 'https://accountid.r2.cloudflarestorage.com',
    });

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
      accessedServices: [entitled.applicationId],
    });
    await ctx.db.insert(licenseKey).values({
      organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values({
      organizationId,
      role: 'restore-operator',
      permission: {
        ac: ['read'],
        service: ['read'],
        destination: ['read'],
        volumeBackup: ['read', 'restore'],
      },
    });
    await ctx.db
      .update(member)
      .set({ role: 'restore-operator' })
      .where(eq(member.userId, invitee.id));

    return {
      organizationId,
      ownerCookie,
      invitee,
      // Read off the rows rather than restated: the prefix a Service's objects
      // live under *is* its `appName` column.
      entitledPrefix: entitled.appName,
      refusedPrefix: refused.appName,
      destinationId: destination.destinationId,
    };
  }

  /**
   * What one bucket holds for two Services, one prefix nobody claims, and two
   * keys in the `{appName}_{serviceName}` shape a *compose* backup writes —
   * `rclone lsjson --recursive`'s own output, keys relative to the listed path.
   *
   * The last two are why the filter expands each segment through
   * `bucketPrefixCandidates` rather than comparing it whole: `appName` admits
   * `_`, so `storefront_web` is genuinely ambiguous between a Service of that
   * name and the Service `storefront` with a stack service `web`. Both readings
   * are resolved and every owner that answers has to be entitled — which is
   * what makes the ambiguity safe instead of exploitable, and here means
   * `ledger-db_pg/` is dropped for the same reason `ledger-db/` is.
   */
  const bucketListing = [
    {
      Path: 'storefront/daily/2026-08-06T02-00-00-000Z.tar',
      Name: '2026-08-06T02-00-00-000Z.tar',
      Size: 2048,
      ModTime: '2026-08-06T02:00:05.000Z',
      IsDir: false,
    },
    {
      Path: 'ledger-db/daily/2026-08-05T02-00-00-000Z.sql.gz',
      Name: '2026-08-05T02-00-00-000Z.sql.gz',
      Size: 4096,
      ModTime: '2026-08-05T02:00:05.000Z',
      IsDir: false,
    },
    {
      Path: 'storefront-before-the-rebuild/2026-08-04T02-00-00-000Z.tar',
      Name: '2026-08-04T02-00-00-000Z.tar',
      Size: 512,
      ModTime: '2026-08-04T02:00:05.000Z',
      IsDir: false,
    },
    {
      Path: 'storefront_web/daily/2026-08-03T02-00-00-000Z.tar',
      Name: '2026-08-03T02-00-00-000Z.tar',
      Size: 256,
      ModTime: '2026-08-03T02:00:05.000Z',
      IsDir: false,
    },
    {
      Path: 'ledger-db_pg/daily/2026-08-02T02-00-00-000Z.sql.gz',
      Name: '2026-08-02T02-00-00-000Z.sql.gz',
      Size: 128,
      ModTime: '2026-08-02T02:00:05.000Z',
      IsDir: false,
    },
  ];

  /**
   * `GET /destinations/:id/objects` against a bucket that really holds every one
   * of those keys, whoever is asking — so what differs between these cases is
   * the caller and never the listing rclone answered with.
   */
  const browse = (
    fixture: Awaited<ReturnType<typeof setUpFixture>>,
    cookie: string,
    query: Record<string, string> = {},
    answered: typeof bucketListing = bucketListing,
  ) => {
    execMock.execAsync.mockResolvedValue({
      stdout: JSON.stringify(answered),
      stderr: '',
      exitCode: 0,
    });
    return request(server)
      .get(`/destinations/${fixture.destinationId}/objects`)
      .query(query)
      .set('Cookie', cookie);
  };

  describe('a licensed custom role holding destination read', () => {
    it('offers only the keys of the service it is entitled to, plus the prefix no service claims', async () => {
      const fixture = await setUpFixture();

      const res = await browse(fixture, fixture.invitee.cookie);

      expect(res.status).toBe(200);
      // `ledger-db/…` and `ledger-db_pg/…` are both gone — one by its own
      // `appName` and one by the `_`-trimmed candidate behind it — and a restore
      // of either would have answered 403. `storefront_web/…` survives by the
      // same trimming, and the unclaimed prefix by the disaster-recovery
      // decision `assertPrefixOwnersEntitled` argues.
      expect((res.body as { key: string }[]).map((row) => row.key)).toEqual([
        `${fixture.entitledPrefix}/daily/2026-08-06T02-00-00-000Z.tar`,
        'storefront-before-the-rebuild/2026-08-04T02-00-00-000Z.tar',
        `${fixture.entitledPrefix}_web/daily/2026-08-03T02-00-00-000Z.tar`,
      ]);
    });

    /**
     * The complement, from the same listing, so the pair cannot drift: the
     * filter is about entitlement and not about the listing having been
     * narrowed for everybody.
     */
    it('offers the owner every key in the bucket', async () => {
      const fixture = await setUpFixture();

      const res = await browse(fixture, fixture.ownerCookie);

      expect(res.status).toBe(200);
      expect((res.body as { key: string }[]).map((row) => row.key)).toEqual(
        bucketListing.map((row) => row.Path),
      );
    });

    /**
     * The point of a filter over a refusal, and the property that makes the
     * picker honest: every row it offers is one the restore accepts. Asked of
     * the *refused* prefix directly rather than of the whole bucket — a caller
     * who already knows another Service's `appName` is exactly who a filter on
     * the listing alone would not stop.
     */
    it('answers an empty listing for a prefix belonging to a service it is not entitled to', async () => {
      const fixture = await setUpFixture();

      // rclone answers a *narrowed* listing with keys relative to the path it
      // was given, which the route puts the prefix back onto — so what the
      // filter decides on is still the top-level segment of the full key.
      const res = await browse(
        fixture,
        fixture.invitee.cookie,
        { prefix: fixture.refusedPrefix },
        [
          {
            Path: 'daily/2026-08-05T02-00-00-000Z.sql.gz',
            Name: '2026-08-05T02-00-00-000Z.sql.gz',
            Size: 4096,
            ModTime: '2026-08-05T02:00:05.000Z',
            IsDir: false,
          },
        ],
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      // The owner, asked the same thing, gets the key — so the empty answer is
      // the filter and not a listing this fixture failed to produce.
      const ownerRes = await browse(
        fixture,
        fixture.ownerCookie,
        { prefix: fixture.refusedPrefix },
        [
          {
            Path: 'daily/2026-08-05T02-00-00-000Z.sql.gz',
            Name: '2026-08-05T02-00-00-000Z.sql.gz',
            Size: 4096,
            ModTime: '2026-08-05T02:00:05.000Z',
            IsDir: false,
          },
        ],
      );
      expect(
        (ownerRes.body as { key: string }[]).map((row) => row.key),
      ).toEqual([
        `${fixture.refusedPrefix}/daily/2026-08-05T02-00-00-000Z.sql.gz`,
      ]);
    });

    /**
     * `query.prefix` went straight into `normalizeS3Path`, which strips leading
     * and trailing slashes and nothing else — so a `..` segment made the
     * segment the filter decides on and the path rclone lists two different
     * things. `bucketKeySegments` is the guard the two backup modules already
     * use on the same shape; its docblock carries what it is and is not worth.
     */
    it('refuses a prefix that climbs out of the segment it is filtered on, and lists nothing', async () => {
      const fixture = await setUpFixture();

      const res = await browse(fixture, fixture.invitee.cookie, {
        prefix: `${fixture.entitledPrefix}/../${fixture.refusedPrefix}`,
      });

      expect(res.status).toBe(400);
      // Refused in front of rclone rather than by rclone: nothing ran.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });
  });
});
