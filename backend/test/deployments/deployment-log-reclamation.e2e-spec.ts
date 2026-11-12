import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { quote } from 'shell-quote';
import { z } from 'zod';
import { ApplicationsService } from '../../src/applications/applications.service';
import { BackupsService } from '../../src/backups/backups.service';
import { createBackupSchema } from '../../src/backups/dto/backup.dto';
import { COMPOSE_SETTLE_CLOCK } from '../../src/compose/compose.utils';
import type { SettleClock } from '../../src/compose/compose.utils';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createScheduleSchema } from '../../src/scheduling/schedules/dto/schedule.dto';
import { SchedulesService } from '../../src/scheduling/schedules/schedules.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createVolumeBackupSchema } from '../../src/volume-backups/dto/volume-backup.dto';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * **A delete takes its deployment logs with it**.
 *
 * Every owner of Deployment rows — an Application, a Compose stack, an
 * Application schedule, a database backup and a volume backup — has its logs
 * under `{logs}/{appName}` on the machine that wrote them, and every one of
 * those rows cascades when the owner is deleted. Before this, no delete removed
 * the directory: it sat on the host under an `appName` no row named, readable
 * from no screen, until ADR-0020's sweep aged it out 90 days later.
 *
 * **The directory is real, and so are the writer and the removal.** Everything
 * runs on the platform host under a temp `CLOUDGATE_DIRECTORY`, the logs are
 * written by the product's own writers (`DeploymentsService.create` and each
 * service's `runManual`, through `BackupRunRecorderService.start`) with their
 * `mkdir`/`echo` actually executed, and the delete's `rm -rf` is actually run.
 * So the assertion is the one the ticket asks for — the directory is gone —
 * rather than a command string that could name a path no writer uses. Every
 * other command is a double, and the two exec shims only execute a program
 * that is confined to this suite's own `{root}/logs`.
 *
 * Which machine an Application on a dedicated build Server is reclaimed from is
 * `test/applications/application-delete-machines.e2e-spec.ts`'s question; the
 * helper's argv and report shape are `test/common/teardown-steps.spec.ts`'.
 */
describe('Deployment log reclamation on delete (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let compose: ComposeService;
  let deployments: DeploymentsService;
  let schedules: SchedulesService;
  let postgres: PostgresService;
  let destinations: DestinationsService;
  let backups: BackupsService;
  let volumeBackups: VolumeBackupsService;

  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-log-reclaim-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;
  const logsRoot = `${configuredRoot}/logs`;
  const logDirectory = (appName: string) => `${logsRoot}/${appName}`;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  /** When set, the log removal on the platform host fails the way an `rm`
   * that could not remove the tree does. */
  let refuseLogRemoval = false;

  /**
   * The string arm. A writer's log bootstrap — `mkdir -p {root}/logs/…` and an
   * `echo` into the file — is executed for real, and only that; a presence
   * probe answers `absent` (an empty stdout is `'unknown'` and would 409), and
   * everything else succeeds without running.
   */
  const execAsync = jest.fn((command: string) => {
    if (
      command.startsWith('mkdir -p ') &&
      command.includes(`${logsRoot}/`) &&
      !command.includes('..')
    ) {
      execSync(command, { shell: '/bin/sh' });
      return Promise.resolve(ok);
    }
    return Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    );
  });
  const execAsyncRemote = jest.fn((_serverId: string, command: string) =>
    Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    ),
  );
  /**
   * The argv arm on the platform host. The delete's `rm -rf {root}/logs/{x}`
   * is run for real; any other argv is forwarded to the string arm, the way
   * `test/utils/exec-double.ts` does it, so it is recorded and not executed.
   */
  const execFileAsync = jest.fn((command: string, args: string[]) => {
    const [flag, target] = args;
    if (
      command === 'rm' &&
      flag === '-rf' &&
      args.length === 2 &&
      target.startsWith(`${logsRoot}/`) &&
      !target.includes('..')
    ) {
      if (refuseLogRemoval) {
        return Promise.reject(new Error('rm: cannot remove: Read-only'));
      }
      execFileSync('rm', args);
      return Promise.resolve(ok);
    }
    return execAsync(quote([command, ...args]));
  });
  const execRemote = jest.fn((serverId: string, argv: string[]) =>
    execAsyncRemote(serverId, quote(argv)),
  );
  const execMock = { execAsync, execAsyncRemote, execFileAsync, execRemote };

  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };
  const instantClock: SettleClock = {
    now: () => 0,
    sleep: () => Promise.resolve(),
  };

  beforeAll(async () => {
    // Before `createTestApp`: `localCloudgateDirectory()` reads `process.env`
    // on every call, but `validateEnv` runs once at boot.
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
        { provide: COMPOSE_SETTLE_CLOCK, useValue: instantClock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    compose = ctx.app.get(ComposeService);
    deployments = ctx.app.get(DeploymentsService);
    schedules = ctx.app.get(SchedulesService);
    postgres = ctx.app.get(PostgresService);
    destinations = ctx.app.get(DestinationsService);
    backups = ctx.app.get(BackupsService);
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
    refuseLogRemoval = false;
    Object.values(execMock).forEach((mock) => mock.mockClear());
    Object.values(traefikWriterMock).forEach((mock) =>
      mock.mockReset().mockResolvedValue(undefined),
    );
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });
    queueMock.getJobs.mockReset().mockResolvedValue([]);
    queueMock.cancel.mockReset().mockResolvedValue(false);
  });

  const permissionCtx = (userId: string, organizationId: string) => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  /** An owner, a Project, an Environment, an Application, a Postgres and a
   * Destination, all on the platform host. */
  async function setUp() {
    const res = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    const session = {
      cookie: res.headers['set-cookie'],
      id: (res.body as { user: { id: string } }).user.id,
    };
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(session.id, organizationId);
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const application = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    return { ownerCtx, environment, application };
  }

  async function setUpBackupParents(
    ownerCtx: ReturnType<typeof permissionCtx>,
    environmentId: string,
  ) {
    const database = await postgres.create(ownerCtx, {
      name: 'Main DB',
      appName: 'main-db',
      databaseName: 'shop',
      databaseUser: 'shop_user',
      databasePassword: 'sup3rS3cret',
      environmentId,
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
    return { database, destination };
  }

  /**
   * Runs a writer and swallows whatever the run itself does afterwards: the
   * log bootstrap is the first thing every run does, and what this suite
   * needs from it is only the directory — which is asserted, so a run that
   * failed before writing it cannot pass as one that did.
   */
  async function writeLogsThrough(
    appName: string,
    run: () => Promise<unknown>,
  ) {
    await run().catch(() => undefined);
    expect(fs.readdirSync(logDirectory(appName))).not.toHaveLength(0);
  }

  describe('the directory is gone after the delete', () => {
    it('an Application delete removes {logs}/{appName}', async () => {
      const { ownerCtx, application } = await setUp();
      await writeLogsThrough(application.appName, () =>
        deployments.create({
          kind: 'application',
          applicationId: application.applicationId,
          title: 'Manual deployment',
          description: '',
        }),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      expect(fs.existsSync(logDirectory(application.appName))).toBe(false);
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });

    it('a Compose delete removes {logs}/{appName}', async () => {
      const { ownerCtx, environment } = await setUp();
      const stack = await compose.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
        composeFile: 'services:\n  web:\n    image: nginx:1\n',
      });
      await writeLogsThrough(stack.appName, () =>
        deployments.create({
          kind: 'compose',
          composeId: stack.composeId,
          title: 'Manual deployment',
          description: '',
        }),
      );

      const removed = await compose.remove(ownerCtx, stack.composeId);

      expect(fs.existsSync(logDirectory(stack.appName))).toBe(false);
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });

    it('a schedule delete removes {logs}/{appName}', async () => {
      const { ownerCtx, application } = await setUp();
      const schedule = await schedules.create(
        ownerCtx,
        createScheduleSchema.parse({
          name: 'Clear cache',
          cronExpression: '0 3 * * *',
          scheduleType: 'application',
          serviceId: application.applicationId,
          command: 'rm -rf /tmp/cache',
        } satisfies z.input<typeof createScheduleSchema>),
      );
      await writeLogsThrough(schedule.appName, () =>
        schedules.runManual(ownerCtx, schedule.scheduleId),
      );

      const removed = await schedules.remove(ownerCtx, schedule.scheduleId);

      expect(fs.existsSync(logDirectory(schedule.appName))).toBe(false);
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });

    it('a backup delete removes {logs}/{appName}', async () => {
      const { ownerCtx, environment } = await setUp();
      const { database, destination } = await setUpBackupParents(
        ownerCtx,
        environment.environmentId,
      );
      const backup = await backups.create(
        ownerCtx,
        createBackupSchema.parse({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        } satisfies z.input<typeof createBackupSchema>),
      );
      await writeLogsThrough(backup.appName, () =>
        backups.runManual(ownerCtx, backup.backupId),
      );

      const removed = await backups.remove(ownerCtx, backup.backupId);

      expect(fs.existsSync(logDirectory(backup.appName))).toBe(false);
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });

    it('a volume backup delete removes {logs}/{appName}', async () => {
      const { ownerCtx, environment, application } = await setUp();
      const { destination } = await setUpBackupParents(
        ownerCtx,
        environment.environmentId,
      );
      const volumeBackup = await volumeBackups.create(
        ownerCtx,
        createVolumeBackupSchema.parse({
          name: 'Nightly volume backup',
          volumeName: 'web-data',
          prefix: 'daily',
          schedule: '0 3 * * *',
          serviceType: 'application',
          serviceId: application.applicationId,
          destinationId: destination.destinationId,
        } satisfies z.input<typeof createVolumeBackupSchema>),
      );
      await writeLogsThrough(volumeBackup.appName, () =>
        volumeBackups.runManual(ownerCtx, volumeBackup.volumeBackupId),
      );

      const removed = await volumeBackups.remove(
        ownerCtx,
        volumeBackup.volumeBackupId,
      );

      expect(fs.existsSync(logDirectory(volumeBackup.appName))).toBe(false);
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });

    /**
     * The cascade over the same two Service arms, so a Project or Environment
     * delete does not leave what deleting each Service would have removed.
     */
    it('deleting the Environment removes its Application’s and its stack’s', async () => {
      const { ownerCtx, environment, application } = await setUp();
      const stack = await compose.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
        composeFile: 'services:\n  web:\n    image: nginx:1\n',
      });
      await writeLogsThrough(application.appName, () =>
        deployments.create({
          kind: 'application',
          applicationId: application.applicationId,
          title: 'Manual deployment',
          description: '',
        }),
      );
      await writeLogsThrough(stack.appName, () =>
        deployments.create({
          kind: 'compose',
          composeId: stack.composeId,
          title: 'Manual deployment',
          description: '',
        }),
      );

      await environments.remove(ownerCtx, environment.environmentId);

      expect(fs.existsSync(logDirectory(application.appName))).toBe(false);
      expect(fs.existsSync(logDirectory(stack.appName))).toBe(false);
    });

    /** Only the deleted owner's directory: `rm -rf` on a sibling would be a
     * far worse defect than the leak. */
    it('leaves every other owner’s logs where they are', async () => {
      const { ownerCtx, environment, application } = await setUp();
      const other = await applications.create(ownerCtx, {
        name: 'Worker',
        appName: 'worker',
        environmentId: environment.environmentId,
      });
      for (const { applicationId, appName } of [application, other]) {
        await writeLogsThrough(appName, () =>
          deployments.create({
            kind: 'application',
            applicationId,
            title: 'Manual deployment',
            description: '',
          }),
        );
      }

      await applications.remove(ownerCtx, application.applicationId);

      expect(fs.existsSync(logDirectory(application.appName))).toBe(false);
      expect(fs.readdirSync(logDirectory(other.appName))).not.toHaveLength(0);
    });
  });

  /**
   * The U08 case: a schedule, a backup or a volume backup writes its run logs
   * under its *own* `appName`, and its row cascades from the Service it
   * belongs to — so deleting the Service is also a delete of those, and has to
   * take their directories too.
   */
  describe('a Service delete takes its cascaded run records’ logs too', () => {
    async function createSchedule(
      ownerCtx: ReturnType<typeof permissionCtx>,
      applicationId: string,
    ) {
      return schedules.create(
        ownerCtx,
        createScheduleSchema.parse({
          name: 'Clear cache',
          cronExpression: '0 3 * * *',
          scheduleType: 'application',
          serviceId: applicationId,
          command: 'rm -rf /tmp/cache',
        } satisfies z.input<typeof createScheduleSchema>),
      );
    }

    async function createVolumeBackup(
      ownerCtx: ReturnType<typeof permissionCtx>,
      serviceType: 'application' | 'postgres',
      serviceId: string,
      destinationId: string,
    ) {
      return volumeBackups.create(
        ownerCtx,
        createVolumeBackupSchema.parse({
          name: 'Nightly volume backup',
          volumeName: 'some-data',
          prefix: 'daily',
          schedule: '0 3 * * *',
          serviceType,
          serviceId,
          destinationId,
        } satisfies z.input<typeof createVolumeBackupSchema>),
      );
    }

    it('deleting a database removes its backups’ and volume backups’ run logs', async () => {
      const { ownerCtx, environment } = await setUp();
      const { database, destination } = await setUpBackupParents(
        ownerCtx,
        environment.environmentId,
      );
      const backup = await backups.create(
        ownerCtx,
        createBackupSchema.parse({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        } satisfies z.input<typeof createBackupSchema>),
      );
      const volumeBackup = await createVolumeBackup(
        ownerCtx,
        'postgres',
        database.postgresId,
        destination.destinationId,
      );
      await writeLogsThrough(backup.appName, () =>
        backups.runManual(ownerCtx, backup.backupId),
      );
      await writeLogsThrough(volumeBackup.appName, () =>
        volumeBackups.runManual(ownerCtx, volumeBackup.volumeBackupId),
      );

      const removed = await postgres.remove(ownerCtx, database.postgresId);

      expect(fs.existsSync(logDirectory(backup.appName))).toBe(false);
      expect(fs.existsSync(logDirectory(volumeBackup.appName))).toBe(false);
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });

    it('deleting an Application removes its schedules’ and volume backups’ run logs', async () => {
      const { ownerCtx, environment, application } = await setUp();
      const { destination } = await setUpBackupParents(
        ownerCtx,
        environment.environmentId,
      );
      const schedule = await createSchedule(
        ownerCtx,
        application.applicationId,
      );
      const volumeBackup = await createVolumeBackup(
        ownerCtx,
        'application',
        application.applicationId,
        destination.destinationId,
      );
      await writeLogsThrough(schedule.appName, () =>
        schedules.runManual(ownerCtx, schedule.scheduleId),
      );
      await writeLogsThrough(volumeBackup.appName, () =>
        volumeBackups.runManual(ownerCtx, volumeBackup.volumeBackupId),
      );

      await applications.remove(ownerCtx, application.applicationId);

      expect(fs.existsSync(logDirectory(schedule.appName))).toBe(false);
      expect(fs.existsSync(logDirectory(volumeBackup.appName))).toBe(false);
    });

    it('deleting a Compose stack removes its schedules’ run logs', async () => {
      const { ownerCtx, environment } = await setUp();
      const stack = await compose.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
        composeFile: 'services:\n  web:\n    image: nginx:1\n',
      });
      const schedule = await schedules.create(
        ownerCtx,
        createScheduleSchema.parse({
          name: 'Clear cache',
          cronExpression: '0 3 * * *',
          scheduleType: 'compose',
          serviceId: stack.composeId,
          serviceName: 'web',
          command: 'rm -rf /tmp/cache',
        } satisfies z.input<typeof createScheduleSchema>),
      );
      await writeLogsThrough(schedule.appName, () =>
        schedules.runManual(ownerCtx, schedule.scheduleId),
      );

      await compose.remove(ownerCtx, stack.composeId);

      expect(fs.existsSync(logDirectory(schedule.appName))).toBe(false);
    });

    it('deleting the Environment removes every cascaded run record’s logs', async () => {
      const { ownerCtx, environment, application } = await setUp();
      const { database, destination } = await setUpBackupParents(
        ownerCtx,
        environment.environmentId,
      );
      const schedule = await createSchedule(
        ownerCtx,
        application.applicationId,
      );
      const backup = await backups.create(
        ownerCtx,
        createBackupSchema.parse({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        } satisfies z.input<typeof createBackupSchema>),
      );
      await writeLogsThrough(schedule.appName, () =>
        schedules.runManual(ownerCtx, schedule.scheduleId),
      );
      await writeLogsThrough(backup.appName, () =>
        backups.runManual(ownerCtx, backup.backupId),
      );

      await environments.remove(ownerCtx, environment.environmentId);

      expect(fs.existsSync(logDirectory(schedule.appName))).toBe(false);
      expect(fs.existsSync(logDirectory(backup.appName))).toBe(false);
    });

    it('names a cascaded record’s directory it could not remove', async () => {
      const { ownerCtx, environment } = await setUp();
      const { database, destination } = await setUpBackupParents(
        ownerCtx,
        environment.environmentId,
      );
      const backup = await backups.create(
        ownerCtx,
        createBackupSchema.parse({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        } satisfies z.input<typeof createBackupSchema>),
      );
      refuseLogRemoval = true;

      const removed = await postgres.remove(ownerCtx, database.postgresId);

      expect(removed.unreclaimedArtifacts).toEqual([
        {
          kind: 'deployment-logs',
          appName: backup.appName,
          serverId: null,
          path: logDirectory(backup.appName),
        },
      ]);
    });
  });

  /**
   * The failure half: the machine would not give the directory up, so the
   * delete still succeeds — it is best effort, like every reclamation — and
   * names what it left, because the rows that could have found it are gone.
   */
  describe('a directory the machine would not remove is named in the answer', () => {
    const leftBehind = (appName: string) => [
      {
        kind: 'deployment-logs',
        appName,
        serverId: null,
        path: logDirectory(appName),
      },
    ];

    it('on an Application delete, over HTTP', async () => {
      const { application } = await setUp();
      const login = await request(server).post('/api/auth/sign-in/email').send({
        email: 'grace@example.com',
        password: 'super-secret-password',
      });
      refuseLogRemoval = true;

      const res = await request(server)
        .delete(`/applications/${application.applicationId}`)
        .set('Cookie', login.headers['set-cookie']);

      expect(res.status).toBe(200);
      expect(
        (res.body as { unreclaimedArtifacts: unknown }).unreclaimedArtifacts,
      ).toEqual(leftBehind(application.appName));
    });

    it('on a Compose, schedule, backup and volume backup delete', async () => {
      const { ownerCtx, environment, application } = await setUp();
      const { database, destination } = await setUpBackupParents(
        ownerCtx,
        environment.environmentId,
      );
      const stack = await compose.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
        composeFile: 'services:\n  web:\n    image: nginx:1\n',
      });
      const schedule = await schedules.create(
        ownerCtx,
        createScheduleSchema.parse({
          name: 'Clear cache',
          cronExpression: '0 3 * * *',
          scheduleType: 'application',
          serviceId: application.applicationId,
          command: 'rm -rf /tmp/cache',
        } satisfies z.input<typeof createScheduleSchema>),
      );
      const backup = await backups.create(
        ownerCtx,
        createBackupSchema.parse({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        } satisfies z.input<typeof createBackupSchema>),
      );
      const volumeBackup = await volumeBackups.create(
        ownerCtx,
        createVolumeBackupSchema.parse({
          name: 'Nightly volume backup',
          volumeName: 'web-data',
          prefix: 'daily',
          schedule: '0 3 * * *',
          serviceType: 'application',
          serviceId: application.applicationId,
          destinationId: destination.destinationId,
        } satisfies z.input<typeof createVolumeBackupSchema>),
      );
      refuseLogRemoval = true;

      expect(
        (await compose.remove(ownerCtx, stack.composeId)).unreclaimedArtifacts,
      ).toEqual(leftBehind(stack.appName));
      expect(
        (await schedules.remove(ownerCtx, schedule.scheduleId))
          .unreclaimedArtifacts,
      ).toEqual(leftBehind(schedule.appName));
      expect(
        (await backups.remove(ownerCtx, backup.backupId)).unreclaimedArtifacts,
      ).toEqual(leftBehind(backup.appName));
      expect(
        (await volumeBackups.remove(ownerCtx, volumeBackup.volumeBackupId))
          .unreclaimedArtifacts,
      ).toEqual(leftBehind(volumeBackup.appName));
    });
  });
});
