import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { server as serverTable } from '../../src/db/schema';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Which **root** a volume backup stages under and takes its lock in
 * (`deployment-engine.paths.ts`' fourth named item, ADR-0018's rule stated for
 * roots).
 *
 * `volumeBackupsDirectory()` and `volumeBackupLockPath()` were
 * `localCloudgateDirectory()` — *this process's* root — while every script that
 * carries them is dispatched by this service to the Service's own Server. With
 * `CLOUDGATE_DIRECTORY` unset the two roots are the *same literal*, so every
 * pre-existing assertion about these scripts passes whichever root is resolved
 * — the paths audit's headline measurement one directory along. So this file
 * sets the variable and every expectation names the *resolved* temp path,
 * because `/etc/cloudgate` exists and is writable on some development hosts and
 * a silent fall back would read as a pass.
 *
 * **The two artifacts fail differently, which is why the lock was the one to
 * think about before converting rather than after.** A staging directory under
 * a root the Server does not own is *created* — `docker run -v`'s bind source
 * and rclone's own download both mint it — so the cost is a tree nothing on
 * that machine owns and nothing reclaims. A lock file's parent is created by
 * nothing: `exec 9>"$LOCK_PATH"` fails outright, and the `mkdir` fallback reads
 * the same missing directory as the **busy** branch, so a host with no `flock`
 * answered 409 "volume is busy" about a lock nobody held.
 *
 * **What was established before any of it was changed, because it decides what
 * the fix is:** whether the three takers of the per-volume lock already
 * resolved *different* roots, which would be a hole in the serialization rather
 * than a cosmetic wrong root. They did not, and structurally so —
 * `volume-lock.ts`' `volumeLockPathFor` is the product's only expression of the
 * path, and all three scripts go to one machine (a backup and a restore to
 * `ServiceParent.serverId`, Remove containers to `compose.serverId`, the same
 * column of the same row for the compose rows that can contend over a volume).
 * `test/deployment-engine/volume-lock.spec.ts` pins that property; this file
 * pins the machine the service actually dispatches to.
 */
describe('The root a volume backup stages and locks under (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let destinations: DestinationsService;
  let volumeBackups: VolumeBackupsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = {
    execAsync: jest.fn<Promise<typeof ok>, [string, ...unknown[]]>(),
    execAsyncRemote: jest.fn<
      Promise<typeof ok>,
      [string, string, ...unknown[]]
    >(),
  };

  /** A real temp directory, so the two roots are genuinely two strings. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-volume-roots-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Before `createTestApp`: `localCloudgateDirectory()` reads `process.env`
    // on every call, but `validateEnv` runs once at boot.
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    destinations = ctx.app.get(DestinationsService);
    volumeBackups = ctx.app.get(VolumeBackupsService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockResolvedValue(ok);
    execMock.execAsyncRemote.mockReset().mockResolvedValue(ok);
  });

  const permissionCtx = (userId: string, organizationId: string) => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  async function signUp(email: string) {
    const res = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email,
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    return {
      cookie: res.headers['set-cookie'],
      id: (res.body as { user: { id: string } }).user.id,
    };
  }

  /** An Application on a named Server (or the platform host) with one
   * registered volume backup pointed at an S3 Destination. */
  async function setUp(appName = 'storefront', { onServer = true } = {}) {
    const session = await signUp(`grace+${appName}@example.com`);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(session.id, organizationId);

    const runServerId = onServer
      ? (
          await ctx.db
            .insert(serverTable)
            .values({
              name: 'runner-us',
              ipAddress: '198.51.100.4',
              port: 22,
              organizationId,
            })
            .returning()
        )[0].serverId
      : null;

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
      deployTarget: { kind: 'platform-host' },
    });
    const application = await applications.create(ownerCtx, {
      name: 'Storefront',
      appName,
      environmentId: environment.environmentId,
      serverId: runServerId,
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
    const registered = await volumeBackups.create(ownerCtx, {
      name: 'Nightly volume backup',
      volumeName: 'shop-data',
      prefix: 'daily',
      schedule: '0 3 * * *',
      serviceType: 'application',
      serviceId: application.applicationId,
      destinationId: destination.destinationId,
      turnOff: false,
    });

    return {
      ownerCtx,
      application,
      destination,
      registered,
      runServerId,
    };
  }

  /** Every command the exec layer was asked for, with the machine it was asked
   * of — `null` being the platform host (ADR-0008). */
  const dispatched = () => [
    ...execMock.execAsync.mock.calls.map(([command]) => ({
      serverId: null as string | null,
      command,
    })),
    ...execMock.execAsyncRemote.mock.calls.map(([serverId, command]) => ({
      serverId,
      command,
    })),
  ];

  const volumeRootOn = (serverId: string | null) =>
    serverId
      ? `${REMOTE_CLOUDGATE_DIRECTORY}/volume-backups`
      : `${configuredRoot}/volume-backups`;

  const lockRootOn = (serverId: string | null) =>
    serverId
      ? `${REMOTE_CLOUDGATE_DIRECTORY}/volume-backup-lock`
      : `${configuredRoot}/volume-backup-lock`;

  describe('the backup run', () => {
    it('stages the tarball and takes the lock on the Service’s own Server', async () => {
      const { ownerCtx, registered, runServerId } = await setUp();

      await volumeBackups.runManual(ownerCtx, registered.volumeBackupId);

      const runs = dispatched().filter(({ command }) =>
        command.includes('tar cvf'),
      );
      expect(runs.map(({ serverId }) => serverId)).toEqual([runServerId]);
      // The staging directory is keyed by `appName`, and the lock by the
      // *volume* — two helpers, one machine.
      // `row.appName` is the volume backup's own minted name, not the
      // Application's — the staging leaf is that column and the root is the
      // machine's, which is the only half this file is about.
      expect(runs[0].command).toContain(
        `${volumeRootOn(runServerId)}/${registered.appName}`,
      );
      expect(runs[0].command).toContain(
        `LOCK_PATH=${lockRootOn(runServerId)}-shop-data`,
      );
      // Not one word of this instance's own layout reaches a machine that has
      // never heard of it.
      expect(runs[0].command).not.toContain(configuredRoot);
    });

    /**
     * The staged tarball's *destroyer*, which runs in the service's own `catch`
     * after the script has exited — so it is a second naming of the same
     * path from a second place, and ADR-0018's rule is exactly that the two
     * must agree. They do by construction: `run` resolves the directory once
     * and hands the same string to the builder and to the cleanup.
     */
    it('cleans the staged tarball up at the path it staged it to', async () => {
      const { ownerCtx, registered, runServerId } = await setUp();
      execMock.execAsyncRemote.mockImplementation((_serverId, command) =>
        command.includes('tar cvf')
          ? Promise.reject(new Error('rclone exploded'))
          : Promise.resolve(ok),
      );

      await expect(
        volumeBackups.runManual(ownerCtx, registered.volumeBackupId),
      ).rejects.toThrow();

      const cleanups = dispatched().filter(({ command }) =>
        command.startsWith('rm -f '),
      );
      expect(cleanups.map(({ serverId }) => serverId)).toEqual([runServerId]);
      expect(cleanups[0].command).toContain(
        `${volumeRootOn(runServerId)}/${registered.appName}/shop-data-`,
      );
      expect(cleanups[0].command).not.toContain(configuredRoot);
    });

    // The branch that has to keep working: a Service on the platform host
    // stages where this process can write, which is the whole reason
    // CLOUDGATE_DIRECTORY exists.
    it('stages a platform-host Service under this instance’s configured root', async () => {
      const { ownerCtx, registered } = await setUp('local-shop', {
        onServer: false,
      });

      await volumeBackups.runManual(ownerCtx, registered.volumeBackupId);

      const runs = dispatched().filter(({ command }) =>
        command.includes('tar cvf'),
      );
      expect(runs.map(({ serverId }) => serverId)).toEqual([null]);
      expect(runs[0].command).toContain(
        `${configuredRoot}/volume-backups/${registered.appName}`,
      );
      expect(runs[0].command).toContain(
        `LOCK_PATH=${configuredRoot}/volume-backup-lock-shop-data`,
      );
      expect(runs[0].command).not.toContain(REMOTE_CLOUDGATE_DIRECTORY);
    });
  });

  describe('the restore', () => {
    /**
     * The restore stages under `{root}/{volumeName}` where the backup stages
     * under `{root}/{appName}` — a pre-existing asymmetry this conversion
     * preserves rather than quietly normalising, because changing *where* a
     * tarball lands is a different ticket from changing which root it lands
     * under. What has to agree is the **lock**, and it does.
     */
    it('downloads into the Service’s own Server’s root and locks the same file', async () => {
      const { ownerCtx, application, destination, runServerId } = await setUp();

      await volumeBackups.restore(ownerCtx, {
        serviceType: 'application',
        serviceId: application.applicationId,
        volumeName: 'shop-data',
        backupFileName: 'storefront/daily/shop-data-2026-07-23.tar',
        destinationId: destination.destinationId,
      });

      const restores = dispatched().filter(({ command }) =>
        command.includes('VOLUME RESTORE'),
      );
      expect(restores.map(({ serverId }) => serverId)).toEqual([runServerId]);
      expect(restores[0].command).toContain(
        `${volumeRootOn(runServerId)}/shop-data`,
      );
      expect(restores[0].command).toContain(
        `LOCK_PATH=${lockRootOn(runServerId)}-shop-data`,
      );
      expect(restores[0].command).not.toContain(configuredRoot);
    });
  });
});
