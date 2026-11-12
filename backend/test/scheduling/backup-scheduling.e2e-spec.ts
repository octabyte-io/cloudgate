import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { BackupsService } from '../../src/backups/backups.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

// Phase 37 wiring of the backup/volume-backup `schedule` cron expressions
// (reserved since Phases 35/36): create/update/remove keep a SchedulingService
// cron job in sync with the row, a fired job runs the backup with no user
// session, and boot re-registers every enabled row.

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

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

describe('Backup scheduling (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let scheduling: SchedulingService;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let postgres: PostgresService;
  let destinations: DestinationsService;
  let backups: BackupsService;
  let volumeBackups: VolumeBackupsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    scheduling = ctx.app.get(SchedulingService);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    postgres = ctx.app.get(PostgresService);
    destinations = ctx.app.get(DestinationsService);
    backups = ctx.app.get(BackupsService);
    volumeBackups = ctx.app.get(VolumeBackupsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // Jobs registered by a previous test would leak across resets.
    for (const id of scheduling.ids()) {
      scheduling.unregister(id);
    }
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  /** Polls until the condition holds — fired cron tasks complete async. */
  async function waitFor(
    condition: () => boolean | Promise<boolean>,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** The run's deployment rows once one reached the given status. */
  async function waitForRun(
    fkColumn: 'backup_id' | 'volume_backup_id',
    id: string,
    status: 'done' | 'error',
  ) {
    let rows: unknown[] = [];
    await waitFor(async () => {
      const result = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE ${sql.raw(fkColumn)} = ${id} AND status = ${status}`,
      );
      rows = result.rows;
      return rows.length > 0;
    });
    return rows;
  }

  /** An owner ctx plus a postgres database and a destination to back up to. */
  async function setUpDatabase() {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const database = await postgres.create(ownerCtx, {
      name: 'Main DB',
      appName: 'main-db',
      databaseName: 'shop',
      databaseUser: 'shop_user',
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
    return { organizationId, ownerSession, ownerCtx, database, destination };
  }

  const backupInput = (
    database: { postgresId: string },
    destination: { destinationId: string },
  ) => ({
    schedule: '0 3 * * *',
    prefix: 'daily',
    database: 'shop',
    databaseType: 'postgres' as const,
    backupType: 'database' as const,
    serviceId: database.postgresId,
    destinationId: destination.destinationId,
  });

  const volumeBackupInput = (
    database: { postgresId: string },
    destination: { destinationId: string },
  ) => ({
    name: 'Nightly volume backup',
    volumeName: 'shop-data',
    prefix: 'daily',
    schedule: '0 3 * * *',
    serviceType: 'postgres' as const,
    serviceId: database.postgresId,
    // `turnOff` carries a zod `.default()`, so it is optional on the create
    // schema's input but required on the output `CreateVolumeBackupDto` is
    // typed from. These tests are about cron registration, not the default,
    // so the fixture states it — as its `backupType` sibling above does.
    turnOff: false,
    destinationId: destination.destinationId,
  });

  describe('database backups', () => {
    it('registers a cron job when an enabled backup is created; disabled rows stay unregistered', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();

      const disabled = await backups.create(ownerCtx, {
        ...backupInput(database, destination),
        enabled: false,
      });
      expect(scheduling.has(disabled.backupId)).toBe(false);

      const enabled = await backups.create(ownerCtx, {
        ...backupInput(database, destination),
        enabled: true,
      });
      expect(scheduling.has(enabled.backupId)).toBe(true);
      const job = scheduling.get(enabled.backupId)!;
      expect(job.cronExpression).toBe('0 3 * * *');
    });

    it('re-registers on update and unregisters when disabled or removed', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const created = await backups.create(ownerCtx, {
        ...backupInput(database, destination),
        enabled: true,
      });

      await backups.update(ownerCtx, created.backupId, {
        schedule: '0 5 * * *',
      });
      expect(scheduling.get(created.backupId)!.cronExpression).toBe(
        '0 5 * * *',
      );

      await backups.update(ownerCtx, created.backupId, { enabled: false });
      expect(scheduling.has(created.backupId)).toBe(false);

      await backups.update(ownerCtx, created.backupId, { enabled: true });
      expect(scheduling.has(created.backupId)).toBe(true);

      await backups.remove(ownerCtx, created.backupId);
      expect(scheduling.has(created.backupId)).toBe(false);
    });

    it('a fired job runs the dump pipeline with no user session and records the run', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const created = await backups.create(ownerCtx, {
        ...backupInput(database, destination),
        enabled: true,
      });
      execMock.execAsync.mockClear();

      void scheduling.runNow(created.backupId);
      const recorded = await waitForRun('backup_id', created.backupId, 'done');
      expect(recorded).toHaveLength(1);

      // Same pipeline as the manual run: pg_dump | gzip | rclone rcat into
      // the destination, whose decrypted credentials reach rclone through its
      // own environment rather than the command line.
      const [script, options] = execMock.execAsync.mock.calls[1] as [
        string,
        { env: Record<string, string> },
      ];
      // The `-c` program is one `quote()`d word for the host shell that runs
      // `docker`, and the values inside it are `quote()`d for the shell that
      // runs the program (H-37). `shop` is safe either way, so this is the same
      // argv the old `bash -c "… 'shop' …"` delivered.
      expect(script).toContain(
        `docker exec -i $CONTAINER_ID bash -c 'set -o pipefail; pg_dump -Fc --no-acl --no-owner -h localhost -U shop_user --no-password shop | gzip'`,
      );
      expect(script).toContain('rclone rcat');
      expect(options.env.RCLONE_S3_SECRET_ACCESS_KEY).toBe(
        'wJalrXUtnFEMI-example-secret-key',
      );
      expect(script).not.toContain('wJalrXUtnFEMI-example-secret-key');
      expect(script).toContain('\\:s3\\:cloudgate-backups/main-db/daily/');
    });

    it('a fired job of a Frozen Organization runs nothing on any host and records no run', async () => {
      const { organizationId, ownerCtx, database, destination } =
        await setUpDatabase();
      const created = await backups.create(ownerCtx, {
        ...backupInput(database, destination),
        enabled: true,
      });
      await freezeOrganization(ctx, organizationId);
      execMock.execAsync.mockClear();

      await scheduling.runNow(created.backupId);

      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      const runs = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE backup_id = ${created.backupId}`,
      );
      expect(runs.rows).toEqual([]);
      // Still armed: the next fire time asks again.
      expect(scheduling.has(created.backupId)).toBe(true);
      jest.restoreAllMocks();
    });
  });

  describe('volume backups', () => {
    it('keeps the cron job in sync across create, update and remove', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();

      const created = await volumeBackups.create(ownerCtx, {
        ...volumeBackupInput(database, destination),
        enabled: true,
      });
      expect(scheduling.has(created.volumeBackupId)).toBe(true);

      await volumeBackups.update(ownerCtx, created.volumeBackupId, {
        schedule: '30 4 * * *',
      });
      expect(scheduling.get(created.volumeBackupId)!.cronExpression).toBe(
        '30 4 * * *',
      );

      await volumeBackups.update(ownerCtx, created.volumeBackupId, {
        enabled: false,
      });
      expect(scheduling.has(created.volumeBackupId)).toBe(false);

      const secondEnabled = await volumeBackups.create(ownerCtx, {
        ...volumeBackupInput(database, destination),
        enabled: true,
      });
      await volumeBackups.remove(ownerCtx, secondEnabled.volumeBackupId);
      expect(scheduling.has(secondEnabled.volumeBackupId)).toBe(false);
    });

    it('a fired job tars the volume with no user session and records the run', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const created = await volumeBackups.create(ownerCtx, {
        ...volumeBackupInput(database, destination),
        enabled: true,
      });
      execMock.execAsync.mockClear();

      void scheduling.runNow(created.volumeBackupId);
      const recorded = await waitForRun(
        'volume_backup_id',
        created.volumeBackupId,
        'done',
      );
      expect(recorded).toHaveLength(1);

      const [script, options] = execMock.execAsync.mock.calls[1] as [
        string,
        { env: Record<string, string> },
      ];
      expect(script).toContain('tar cvf /backup/shop-data-');
      expect(script).toContain('rclone copyto');
      expect(options.env).toMatchObject({
        RCLONE_S3_PROVIDER: 'Cloudflare',
        RCLONE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEACCESSKEY',
      });
      expect(script).not.toContain('AKIAEXAMPLEACCESSKEY');
      expect(script).toContain(
        '\\:s3\\:cloudgate-backups/main-db/daily/shop-data-',
      );
    });

    it('a fired job of a Frozen Organization runs nothing on any host and records no run', async () => {
      const { organizationId, ownerCtx, database, destination } =
        await setUpDatabase();
      const created = await volumeBackups.create(ownerCtx, {
        ...volumeBackupInput(database, destination),
        enabled: true,
      });
      await freezeOrganization(ctx, organizationId);
      execMock.execAsync.mockClear();

      await scheduling.runNow(created.volumeBackupId);

      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      const runs = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE volume_backup_id = ${created.volumeBackupId}`,
      );
      expect(runs.rows).toEqual([]);
      expect(scheduling.has(created.volumeBackupId)).toBe(true);
      jest.restoreAllMocks();
    });
  });

  describe('boot initialization', () => {
    it('initializeJobs registers every enabled row and skips disabled ones', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const enabledBackup = await backups.create(ownerCtx, {
        ...backupInput(database, destination),
        enabled: true,
      });
      const disabledBackup = await backups.create(ownerCtx, {
        ...backupInput(database, destination),
        enabled: false,
      });
      const enabledVolume = await volumeBackups.create(ownerCtx, {
        ...volumeBackupInput(database, destination),
        enabled: true,
      });

      // Simulate a fresh process: rows exist, no jobs registered yet.
      for (const id of scheduling.ids()) {
        scheduling.unregister(id);
      }

      await backups.initializeJobs();
      await volumeBackups.initializeJobs();

      expect(scheduling.has(enabledBackup.backupId)).toBe(true);
      expect(scheduling.has(disabledBackup.backupId)).toBe(false);
      expect(scheduling.has(enabledVolume.volumeBackupId)).toBe(true);
    });
  });
});
