import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  licenseKey,
  member,
  mount,
  organizationRole,
} from '../../src/db/schema';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

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

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role: 'member' });
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

/**
 * The permission level, over HTTP. Registering a volume backup, re-pointing one
 * and running a restore reached `PermissionService.checkServiceAccess` with no
 * `action`, so `service: ['read']` on the owning Service authorized all three —
 * while `volumeName` comes off the wire and is charset-checked only. A caller
 * entitled to one Service could therefore have any volume on that Service's
 * host tarred into a Destination they control, or — on the restore path, which
 * runs `docker volume rm` then `create` then untars — destroyed and replaced.
 * The three writes now claim `'update'`; `VolumeBackupsService.create` carries
 * the argument, and `VOLUME_NAME_REGEX` carries why the target itself stays
 * free-form.
 *
 * **Driven through a licensed custom role, because that is who this changes
 * anything for.** All three static roles hold `service: ['update']` — owner and
 * admin outright, `memberRole` too — so the only shape that loses
 * anything is a custom role granted `volumeBackup` actions beside
 * `service: ['read']`. The role is built here the way `test/rbac/rbac.e2e-spec.ts`
 * builds one: a license key so the enterprise-only `volumeBackup` statement
 * counts at all, an `organization_role` row, and the invitee moved onto it.
 *
 * The complement is asserted from the same fixture, so the pair cannot drift:
 * the same role with `service: ['read', 'update']` — which is exactly
 * `memberRole`'s line — is *allowed* every one of the three, and the reads, the
 * manual run and the delete stay open at `['read']`.
 */
describe('Volume backup authorization (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
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
   * One Project, one Environment, two Applications and a Destination — with the
   * invitee entitled to the **first** Application only, and the second one's
   * own volume recorded as a `mount` row. That second volume is what the
   * refusals below are aimed at and what the free-form assertion at the end
   * names: it is a volume this platform knows belongs to a Service the caller
   * was never entitled to.
   *
   * The volume backup the `PATCH` and the run act on is registered by the owner,
   * so those two routes have a row to reach without the caller under test having
   * had to pass the gate that is under test.
   */
  async function setUpFixture() {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: ownerSession.id },
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
    const refused = await applications.create(ownerCtx, {
      name: 'Ledger',
      appName: 'ledger',
      environmentId: environment.environmentId,
    });
    await ctx.db.insert(mount).values({
      type: 'volume',
      volumeName: 'ledger-data',
      mountPath: '/data',
      serviceType: 'application',
      applicationId: refused.applicationId,
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
      .post('/volume-backups')
      .set('Cookie', ownerSession.cookie)
      .send({
        name: 'Nightly volume backup',
        volumeName: 'storefront-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'application',
        serviceId: entitled.applicationId,
        destinationId: destination.destinationId,
      });
    expect(registered.status).toBe(201);

    const invitee = await inviteUser(
      server,
      ownerSession.cookie,
      'ida@example.com',
    );
    const [memberRow] = await ctx.db
      .select()
      .from(member)
      .where(eq(member.userId, invitee.id));
    await permissions.setMemberEntitlements(organizationId, memberRow.id, {
      accessedProjects: [project.projectId],
      accessedEnvironments: [environment.environmentId],
      accessedServices: [entitled.applicationId],
    });

    return {
      organizationId,
      invitee,
      entitledServiceId: entitled.applicationId,
      refusedVolumeName: 'ledger-data',
      // Read back off the rows rather than restated: the prefix a Service's
      // tarballs live under *is* its `appName` column, which is the fact
      // the prefix bound rests on.
      entitledPrefix: entitled.appName,
      refusedPrefix: refused.appName,
      destinationId: destination.destinationId,
      volumeBackupId: (registered.body as { volumeBackupId: string })
        .volumeBackupId,
    };
  }

  /**
   * Moves the invitee onto a licensed custom role holding `serviceActions` and
   * every `volumeBackup` action — so the only variable between the refusal
   * block and the capability block is the `service` line.
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
      role: 'volume-backup-operator',
      permission: {
        ac: ['read'],
        service: serviceActions,
        volumeBackup: ['read', 'create', 'update', 'delete', 'restore'],
      },
    });
    await ctx.db
      .update(member)
      .set({ role: 'volume-backup-operator' })
      .where(eq(member.userId, userId));
  }

  /**
   * The three writes the level fix raised, as one request each against the
   * fixture.
   *
   * **The restore's `backupFileName` names the *entitled* Service's prefix, and
   * that changed with the prefix bound.** It used to be `ledger/daily/…` — the
   * refused Application's own `appName` — which made the capability block below
   * assert that a Member entitled to Storefront may load Ledger's tarball into
   * a Storefront volume. That was never what the level fix was measuring; its
   * variable is the `service` line, and the free-form `volumeName` beside it is
   * what carries its point. The prefix bound closed the key half, so a foreign
   * prefix here would refuse for the wrong reason and hide the level under
   * test. The foreign key gets its own block further down, where it is the
   * variable rather than the noise.
   */
  const writes = (fixture: {
    entitledServiceId: string;
    refusedVolumeName: string;
    entitledPrefix: string;
    destinationId: string;
    volumeBackupId: string;
  }) => [
    {
      route: 'POST /volume-backups',
      send: (cookie: string) =>
        request(server).post('/volume-backups').set('Cookie', cookie).send({
          name: 'Exfiltrating volume backup',
          volumeName: fixture.refusedVolumeName,
          prefix: 'daily',
          schedule: '0 3 * * *',
          serviceType: 'application',
          serviceId: fixture.entitledServiceId,
          destinationId: fixture.destinationId,
        }),
    },
    {
      route: 'PATCH /volume-backups/{id}',
      send: (cookie: string) =>
        request(server)
          .patch(`/volume-backups/${fixture.volumeBackupId}`)
          .set('Cookie', cookie)
          .send({ volumeName: fixture.refusedVolumeName }),
    },
    {
      route: 'POST /volume-backups/restore',
      send: (cookie: string) =>
        request(server)
          .post('/volume-backups/restore')
          .set('Cookie', cookie)
          .send({
            serviceId: fixture.entitledServiceId,
            serviceType: 'application',
            volumeName: fixture.refusedVolumeName,
            backupFileName: `${fixture.entitledPrefix}/daily/${fixture.refusedVolumeName}-2026-01-01.tar`,
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
        'POST /volume-backups -> 403',
        'PATCH /volume-backups/{id} -> 403',
        'POST /volume-backups/restore -> 403',
      ]);
    });

    it('writes nothing and runs nothing on the way to those three refusals', async () => {
      const fixture = await setUpFixture();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'read',
      ]);
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      for (const { send } of writes(fixture)) {
        await send(fixture.invitee.cookie);
      }

      // The owner's row is the only one there is, and it still points where the
      // owner pointed it: no second row was inserted and the `PATCH` did not
      // land.
      const rows = await ctx.db.execute(
        sql`SELECT volume_name FROM volume_backup ORDER BY volume_name`,
      );
      expect(rows.rows).toEqual([{ volume_name: 'storefront-data' }]);
      // And no script reached a run host, so the restore's
      // `docker volume rm` never happened.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });

    /**
     * The half that says raising the level is not a feature removal: the reads
     * and the operate verb are a carve-out and are untouched, so a role built to
     * see its Service and run the backups somebody else registered keeps
     * working. `POST /{id}/run` claims `volumeBackup: ['create']` and executes a
     * *stored* row, which now can only have been written by somebody who
     * held `'update'` on the parent.
     */
    it('leaves the reads, the manual run and the delete open to it', async () => {
      const fixture = await setUpFixture();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'read',
      ]);

      const list = await request(server)
        .get('/volume-backups')
        .query({
          serviceId: fixture.entitledServiceId,
          serviceType: 'application',
        })
        .set('Cookie', fixture.invitee.cookie);
      const read = await request(server)
        .get(`/volume-backups/${fixture.volumeBackupId}`)
        .set('Cookie', fixture.invitee.cookie);
      const run = await request(server)
        .post(`/volume-backups/${fixture.volumeBackupId}/run`)
        .set('Cookie', fixture.invitee.cookie);
      const removed = await request(server)
        .delete(`/volume-backups/${fixture.volumeBackupId}`)
        .set('Cookie', fixture.invitee.cookie);

      expect({
        list: list.status,
        read: read.status,
        run: run.status,
        removed: removed.status,
      }).toEqual({ list: 200, read: 200, run: 204, removed: 200 });
    });
  });

  describe('a licensed custom role holding service read and update', () => {
    it('registers, re-points and restores exactly as it did before', async () => {
      const fixture = await setUpFixture();
      // `['read', 'update']` is `memberRole`'s own service line, so
      // this block is also the base member's behaviour.
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
        'POST /volume-backups -> 201',
        'PATCH /volume-backups/{id} -> 200',
        'POST /volume-backups/restore -> 204',
      ]);
    });

    /**
     * The free-form target, pinned as the decision it is. `ledger-data`
     * is a volume-type `mount` row of the *other* Application, which the caller
     * is not entitled to — and naming it is still accepted, because
     * `VOLUME_NAME_REGEX`'s docblock argues that binding `volumeName` to the
     * parent's own volumes would refuse a restore onto a host where the volume
     * does not exist yet, a compose stack's volumes (which have no mount rows),
     * and a pre-existing volume adopted by hand.
     *
     * So this assertion is not describing a hole that nobody noticed: it is the
     * decision, and anybody who binds the target later has to come here and say
     * why the three cases above are answered. What carries the weight instead is
     * the level in the block above — which is why the caller here needs
     * `service: ['update']` to get this far at all.
     */
    it('accepts a volume the parent Service does not own, and the level is what gates it', async () => {
      const fixture = await setUpFixture();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'read',
        'update',
      ]);

      const registered = await request(server)
        .post('/volume-backups')
        .set('Cookie', fixture.invitee.cookie)
        .send({
          name: 'A volume this service does not mount',
          volumeName: fixture.refusedVolumeName,
          prefix: 'daily',
          schedule: '0 3 * * *',
          serviceType: 'application',
          serviceId: fixture.entitledServiceId,
          destinationId: fixture.destinationId,
        });

      expect(registered.status).toBe(201);
      expect(registered.body).toMatchObject({ volumeName: 'ledger-data' });
    });
  });

  /**
   * The prefix bound's second half, and the reach the level fix left open on
   * purpose. The caller here is a plain Member — `memberRole` holds `service:
   * ['read', 'update']` and every `volumeBackup` action — so the level is not
   * what is being tested: the only thing separating these requests is which
   * Service's prefix the tarball sits under.
   *
   * A Destination's bucket is organization-wide and a tarball lands at
   * `{appName}/{prefix}/{volumeName}-{timestamp}.tar`, so before this a Member
   * entitled to Storefront could name **Ledger's** tarball, untar it into a
   * volume of their own Application and read another Service's data through a
   * Service they are entitled to. `VolumeBackupsService.restore` carries the
   * argument; this drives it through the `accessedServices` column the reach
   * crossed.
   */
  describe('a member entitled to one of two applications in the shared bucket', () => {
    /** A restore into the caller's own Application, varying only the key. */
    const restoreOf = (
      fixture: { entitledServiceId: string; destinationId: string },
      cookie: string,
      backupFileName: string,
    ) =>
      request(server)
        .post('/volume-backups/restore')
        .set('Cookie', cookie)
        .send({
          serviceId: fixture.entitledServiceId,
          serviceType: 'application',
          volumeName: 'storefront-data',
          backupFileName,
          destinationId: fixture.destinationId,
        });

    it('refuses a restore of the other application’s tarball into its own volume', async () => {
      const fixture = await setUpFixture();
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      const res = await restoreOf(
        fixture,
        fixture.invitee.cookie,
        `${fixture.refusedPrefix}/daily/ledger-data-2026-01-01.tar`,
      );

      expect(res.status).toBe(403);
      // Nothing was downloaded and no volume was touched: the refusal is in
      // front of the script, not something the script declined to do.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('allows a restore of its own application’s tarball', async () => {
      const fixture = await setUpFixture();
      execMock.execAsync.mockClear();

      const res = await restoreOf(
        fixture,
        fixture.invitee.cookie,
        `${fixture.entitledPrefix}/daily/storefront-data-2026-01-01.tar`,
      );

      expect(res.status).toBe(204);
      // …and the key it ran with is the one that was asked for, so this passes
      // for the right reason rather than by refusing later.
      const [script] = execMock.execAsync.mock.calls[0] as [string];
      expect(script).toContain(
        'storefront/daily/storefront-data-2026-01-01.tar',
      );
    });

    /**
     * The decision rather than a gap, argued in
     * `VolumeBackupsService.checkTarballAccess`: a prefix no Service claims is
     * the tarball of a Service that was destroyed and recreated — a new
     * `appName`, so its predecessor's tarballs are orphaned — or one uploaded by
     * hand, and refusing those refuses disaster recovery at the moment it is
     * needed.
     */
    it('allows a restore from a prefix no service claims', async () => {
      const fixture = await setUpFixture();

      const res = await restoreOf(
        fixture,
        fixture.invitee.cookie,
        'storefront-before-the-rebuild/storefront-data-2026-01-01.tar',
      );

      expect(res.status).toBe(204);
    });
  });

  /**
   * The `..` segment, and the sink is **the run host's filesystem** rather than
   * the bucket.
   *
   * `buildVolumeRestoreScript` stages the download at
   * `{volumeBackupsDirectory}/{volumeName}/{backupFileName}` and the cleanup
   * `trap … EXIT` removes that path with `rm -f` whether the download happened
   * or not — so a key carrying `..` was an arbitrary-path delete, and the
   * download beside it an arbitrary-path write, on the Server as the account
   * that drives Docker. `S3_KEY_REGEX` refuses a *leading* dot, which is why
   * this needs a segment further in.
   *
   * It is also what makes the prefix bound above well-posed: the segment the key
   * is authorized under and the path it resolves to have to be the same thing.
   * A 400 rather than the 403 above, deliberately — the shape is wrong, and
   * answering 403 would make it an oracle for prefixes that do exist (§2.2).
   */
  describe('a restore key with a .. segment', () => {
    it('refuses it, and stages nothing on the run host', async () => {
      const fixture = await setUpFixture();
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      const res = await request(server)
        .post('/volume-backups/restore')
        .set('Cookie', fixture.invitee.cookie)
        .send({
          serviceId: fixture.entitledServiceId,
          serviceType: 'application',
          volumeName: 'storefront-data',
          backupFileName: 'storefront/../../../../etc/cron.d/pwn.tar',
          destinationId: fixture.destinationId,
        });

      expect(res.status).toBe(400);
      expect((res.body as { message?: string }).message).toContain(
        '".." segment',
      );
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });
  });
});
