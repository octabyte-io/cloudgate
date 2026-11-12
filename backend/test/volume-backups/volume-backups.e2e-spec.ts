import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { ApplicationsService } from '../../src/applications/applications.service';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import {
  VOLUME_LOCK_BUSY_EXIT_CODE,
  volumeLockBusyMessage,
} from '../../src/deployment-engine/volume-lock';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionCtx } from '../../src/rbac/permission.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { createVolumeBackupSchema } from '../../src/volume-backups/dto/volume-backup.dto';
import { volumeBackup } from '../../src/volume-backups/volume-backup.schema';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
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

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

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

describe('Volume backups (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let postgres: PostgresService;
  let applications: ApplicationsService;
  let compose: ComposeService;
  let destinations: DestinationsService;
  let volumeBackups: VolumeBackupsService;

  /**
   * Creates a volume backup from a request-shaped fixture. `turnOff` and
   * `serviceType` carry zod `.default()`s, so they are optional on the
   * schema's *input* and required on its output — and
   * `CreateVolumeBackupDto` is typed from the output. Fixtures that omit one
   * stand in for an HTTP caller that omits it, so they are typed from the
   * input and put through the schema here, exactly as the ZodValidationPipe
   * does before a request body reaches the service.
   */
  const createVolumeBackup = (
    permCtx: PermissionCtx,
    data: z.input<typeof createVolumeBackupSchema>,
  ) => volumeBackups.create(permCtx, createVolumeBackupSchema.parse(data));

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  /**
   * The root every staged tarball, lock file and run log in this file sits
   * under, asked of the machine rather than spelled.
   *
   * Every Service here is created without a `serverId`, so each backup,
   * restore and run log is local-exec work on the platform host (ADR-0008) —
   * which is why the assertions read `execAsync` — and the platform host's
   * root is this process's CLOUDGATE_DIRECTORY. These spelled
   * `/etc/cloudgate` once: a Server's root, and the right answer here
   * only while the variable was unset.
   */
  const platformHostRoot = () => cloudgateDirectoryOn(null);

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    postgres = ctx.app.get(PostgresService);
    applications = ctx.app.get(ApplicationsService);
    compose = ctx.app.get(ComposeService);
    destinations = ctx.app.get(DestinationsService);
    volumeBackups = ctx.app.get(VolumeBackupsService);
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

  /** An owner ctx plus a postgres database and a destination to back up to. */
  async function setUpDatabase() {
    const { organizationId, owner: ownerSession } = await setUpOwner(server);
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
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      project,
      environment,
      database,
      destination,
    };
  }

  const SECRET = 'wJalrXUtnFEMI-example-secret-key';
  const ACCESS_KEY = 'AKIAEXAMPLEACCESSKEY';

  /** The credentials reach rclone through its own environment on every
   * route, so no script the run echoes into its log file names one. */
  const expectCredentialsInEnvOnly = (
    call: [string, { env: Record<string, string> }],
  ): void => {
    const [command, options] = call;
    expect(command).not.toContain(SECRET);
    expect(command).not.toContain(ACCESS_KEY);
    expect(command).not.toContain('--s3-');
    expect(options.env).toMatchObject({
      RCLONE_S3_ACCESS_KEY_ID: ACCESS_KEY,
      RCLONE_S3_SECRET_ACCESS_KEY: SECRET,
    });
  };

  describe('manual run', () => {
    it('tars the volume, uploads via rclone copyto and records the run as a done deployment', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const volumeBackup = await createVolumeBackup(ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      await volumeBackups.runManual(ownerCtx, volumeBackup.volumeBackupId);

      // First exec initializes the run's log file under the row's appName.
      const runLogDirectory = `${platformHostRoot()}/logs/${volumeBackup.appName}`;
      const initCall = execMock.execAsync.mock.calls[0] as [string];
      expect(initCall[0]).toContain(`mkdir -p ${runLogDirectory}`);
      expect(initCall[0]).toContain('Initializing volume backup');

      // Second exec is the backup script with all output appended to the
      // run's log file (a `(command) >> logPath 2>&1` wrapper).
      expectCredentialsInEnvOnly(
        execMock.execAsync.mock.calls[1] as [
          string,
          { env: Record<string, string> },
        ],
      );
      const [script] = execMock.execAsync.mock.calls[1] as [string];
      expect(script).toMatch(/^\(\n/);
      // Escaped, because the directory is now whatever root is configured
      // rather than a literal known to hold no regex metacharacter.
      const escapedLogDirectory = runLogDirectory.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );
      expect(script).toMatch(
        new RegExp(`\\) >> ${escapedLogDirectory}/.+\\.log 2>&1$`),
      );

      // The tar runs from a throwaway ubuntu container against the volume,
      // staged under the row's appName…
      const stagingDir = `${platformHostRoot()}/volume-backups/${volumeBackup.appName}`;
      expect(script).toContain(
        `docker run --rm   -v shop-data\\:/volume_data   -v ${stagingDir}\\:/backup   ubuntu:24.04   ` +
          "bash -c 'cd /volume_data && tar cvf /backup/shop-data-",
      );
      // …and uploads into the postgres service's S3 directory, then cleans up
      // the staged tarball.
      expect(script).toContain(`rclone copyto ${stagingDir}/shop-data-`);
      expect(script).toContain(
        '\\:s3\\:cloudgate-backups/main-db/daily/shop-data-',
      );
      expect(script).toContain(`rm ${stagingDir}/shop-data-`);

      // The run is recorded as a done deployment pointing at the volume
      // backup, its log under the shared logs directory.
      const recorded = await ctx.db.execute(
        sql`SELECT status, log_path FROM deployment WHERE volume_backup_id = ${volumeBackup.volumeBackupId}`,
      );
      expect(recorded.rows).toHaveLength(1);
      expect(recorded.rows[0]).toMatchObject({
        status: 'done',
        log_path: expect.stringContaining(`${runLogDirectory}/`) as string,
      });

      // No keepLatestCount → nothing to prune after the run.
      expect(execMock.execAsync).toHaveBeenCalledTimes(2);
    });

    it('prunes all but the newest N tarballs after a successful run', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const volumeBackup = await createVolumeBackup(ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
        keepLatestCount: 7,
      });

      await volumeBackups.runManual(ownerCtx, volumeBackup.volumeBackupId);

      // pruneOldBackups: list this volume's tarballs, drop
      // the newest 7 from the (reverse-sorted) listing, delete the rest.
      expectCredentialsInEnvOnly(
        execMock.execAsync.mock.calls[2] as [
          string,
          { env: Record<string, string> },
        ],
      );
      const [pruneCommand] = execMock.execAsync.mock.calls[2] as [string];
      expect(pruneCommand).toBe(
        // As on the database side (H-36): each value word is `quote()`d, and the
        // escaped `\*` is as unexpandable by the shell as `"*"` was, while
        // `xargs -I{}` still substitutes into `\{\}` because the backslashes are
        // gone by the time xargs reads the argument.
        'rclone lsf --include shop-data-\\*.tar \\:s3\\:cloudgate-backups/main-db/daily/ | ' +
          'sort -r | tail -n +$((7+1)) | xargs -I{} ' +
          'rclone delete \\:s3\\:cloudgate-backups/main-db/daily/\\{\\}',
      );
    });

    it('records a failed run as an error deployment, drops its staged tarball and rethrows', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const volumeBackup = await createVolumeBackup(ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      execMock.execAsync
        .mockReset()
        // Log-file initialization succeeds…
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        // …the backup script itself fails.
        .mockRejectedValueOnce(new Error('volume not found'))
        // …the tarball cleanup succeeds.
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

      await expect(
        volumeBackups.runManual(ownerCtx, volumeBackup.volumeBackupId),
      ).rejects.toThrow('volume not found');

      // The error path removes the one tarball this run staged, by name.
      const [script] = execMock.execAsync.mock.calls[1] as [string];
      const staged = /tar cvf \/backup\/(\S+\.tar)/.exec(script)?.[1];
      const [cleanup] = execMock.execAsync.mock.calls[2] as [string];
      expect(cleanup).toBe(
        `rm -f ${platformHostRoot()}/volume-backups/${volumeBackup.appName}/${staged}`,
      );
      // No glob: that is what reached a concurrent run's tarball. And `-f`, so
      // a run that failed before the tar is not a second failure. The path is
      // one `quote()`d word rather than a `"…"` one (H-19), which is still one
      // word for a path carrying a space — and a glob would come back as `\*.tar`,
      // so this negative still matches the regression it was written for.
      expect(cleanup).not.toContain('*.tar');
      expect(cleanup).not.toContain('rm -rf');

      const recorded = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE volume_backup_id = ${volumeBackup.volumeBackupId}`,
      );
      expect(recorded.rows).toHaveLength(1);
      expect(recorded.rows[0]).toMatchObject({ status: 'error' });
    });

    it('rethrows a failed run with no credential in the message', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const volumeBackup = await createVolumeBackup(ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      execMock.execAsync
        .mockReset()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        // What a shell echoes back when it repeats the line it could not run.
        .mockRejectedValueOnce(
          new Error(
            `Command failed: rclone copyto: SignatureDoesNotMatch for ${ACCESS_KEY} / ${SECRET}`,
          ),
        )
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

      const error = await volumeBackups
        .runManual(ownerCtx, volumeBackup.volumeBackupId)
        .then(
          () => {
            throw new Error('expected the run to reject');
          },
          (e: Error) => e,
        );

      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain(ACCESS_KEY);
      // The diagnosis is why the failure is read at all, so it survives.
      expect(error.message).toContain('SignatureDoesNotMatch');
    });
  });

  describe('restore', () => {
    it('downloads the tarball and untars it into the re-created volume', async () => {
      const { ownerCtx, environment, destination } = await setUpDatabase();
      const application = await applications.create(ownerCtx, {
        name: 'Blog',
        appName: 'main-app',
        environmentId: environment.environmentId,
      });

      await volumeBackups.restore(ownerCtx, {
        serviceId: application.applicationId,
        serviceType: 'application',
        volumeName: 'shop-data',
        backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        destinationId: destination.destinationId,
      });

      expectCredentialsInEnvOnly(
        execMock.execAsync.mock.calls[0] as [
          string,
          { env: Record<string, string> },
        ],
      );
      const [script] = execMock.execAsync.mock.calls[0] as [string];
      const stagingDir = `${platformHostRoot()}/volume-backups/shop-data`;
      expect(script).toContain('=== VOLUME RESTORE FOR APPLICATION ===');
      // The prose `echo`s carry a value too, so they are `quote()`d words like
      // any other (H-32): quoting only the "command" halves would have left the
      // injection reachable through the line that reports the restore.
      expect(script).toContain("echo 'Application: main-app'");
      // The in-use guard runs before any restore. The `tr` is there because a
      // BSD `wc` pads its count, and this capture is compared as a string. The
      // `^`/`$` are docker's own anchors and survive the escaping — the shell
      // strips the backslashes, so docker still receives `name=^shop-data$`.
      expect(script).toContain(
        `VOLUME_EXISTS=$(docker volume ls -q --filter name\\=\\^shop-data\\$ | wc -l | tr -d '[:space:]')`,
      );
      // The endpoint is asked whether it is answering at all before the lock is
      // taken: the download's retry budget is chosen so a
      // degraded-but-moving link still assembles, and the same counter governs a
      // connect that never completes, so an absent endpoint is refused by a
      // listing that fails fast rather than paid for by the transfer.
      expect(script).toContain(
        'rclone lsjson --retries 1 --low-level-retries 1 --timeout 30s --contimeout 5s ' +
          '\\:s3\\:cloudgate-backups/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
      );
      expect(script.indexOf('rclone lsjson')).toBeLessThan(
        script.indexOf('LOCK_PATH='),
      );
      // The tarball downloads from the destination, bounded on idle time *and*
      // on the wall clock (the idle-and-retry flags bound
      // an attempt, not the request), with the retry that restarts at byte zero
      // spent and the one that resumes at the offset kept.
      //
      // The wall clock is the **process** (H-120): `--max-duration` below is
      // accepted and inert on the rclone `deploy/install.sh` installs, so it is
      // the belt and `timeout` is the bound. `command v` rather than an
      // assumption, because this same script runs on a Server over SSH.
      expect(script).toContain(
        "if command -v timeout >/dev/null 2>&1; then RCLONE_WALL_CLOCK='timeout 1800'; else RCLONE_WALL_CLOCK=''; fi",
      );
      expect(script).toContain('$RCLONE_WALL_CLOCK rclone copyto ');
      expect(script).toContain(
        'rclone copyto --retries 1 --low-level-retries 10 --timeout 60s --contimeout 10s ' +
          '--max-duration 30m ' +
          '\\:s3\\:cloudgate-backups/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar ' +
          `${stagingDir}/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar`,
      );
      // …and nothing that replaces the volume is reachable before it.
      expect(script.indexOf('rclone copyto')).toBeLessThan(
        script.indexOf('docker volume rm shop-data --force'),
      );
      // The exited task containers Swarm keeps after Stop are removed rather
      // than refused on — only once the tarball is proved, and ahead of
      // the removal Docker would otherwise refuse while they reference it.
      expect(script).toContain('if [ "$container_owner" = main-app ]; then');
      expect(script).toContain('docker rm $TASK_HISTORY');
      expect(script.indexOf('rclone copyto')).toBeLessThan(
        script.indexOf('docker rm $TASK_HISTORY'),
      );
      expect(script.indexOf('docker rm $TASK_HISTORY')).toBeLessThan(
        script.indexOf('docker volume rm shop-data --force'),
      );
      // …and untars into the volume from a throwaway ubuntu container.
      expect(script).toContain(
        `docker run --rm \t\t-v shop-data\\:/volume_data \t\t-v ${stagingDir}\\:/backup \t\tubuntu:24.04 \t\t` +
          "bash -c 'cd /volume_data && tar xvf /backup/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar .'",
      );
      // The volume is created by name and label rather than conjured by the
      // `-v` above, and the download does not outlive the restore
      // (spelled as a trap so the exit that matters — a
      // failing untar — is covered too). Without either, a restored volume
      // would lose the labels its project owns it by and the tarball would stay
      // on the host for good.
      expect(script).toContain(
        `VOLUME_LABELS=$(docker volume inspect shop-data --format '{{range $k, $v := .Labels}}--label {{$k}}={{$v}} {{end}}')`,
      );
      expect(script).toContain('docker volume create $VOLUME_LABELS shop-data');
      expect(script).toContain(
        `trap 'rm -f ${stagingDir}/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar; echo "Local backup file cleaned up ✅"' EXIT`,
      );
    });

    // The script goes to real trouble over this refusal — it lists every
    // container holding the volume, its state and its type, and prints three
    // numbered steps for freeing it — so the caller is answered that text,
    // not a bare 500 that would leave it alive only in the backend journal.
    it('answers the in-use refusal the script wrote, not a 500', async () => {
      const { ownerCtx, environment, destination } = await setUpDatabase();
      const application = await applications.create(ownerCtx, {
        name: 'Blog',
        appName: 'main-app',
        environmentId: environment.environmentId,
      });

      const refusalText = [
        '⚠️  WARNING: Cannot restore volume as it is currently in use!',
        "📋 The following containers are using volume 'shop-data':",
        '   🐳 Container: main-app-cache-1 (f2f260f7d567)',
        '      Status: running',
        '🔧 To restore this volume, please:',
        '   1. Stop all containers/services using this volume',
        '❌ Volume restore aborted - volume is in use',
      ].join('\n');
      execMock.execAsync.mockReset().mockRejectedValue(
        Object.assign(
          // What an ExecError carries: the message is the script source, and
          // the diagnosis is one field over.
          new Error(
            'Command execution failed: Command failed: <script source>',
          ),
          { stdout: refusalText, stderr: '' },
        ),
      );

      const refusal = volumeBackups.restore(ownerCtx, {
        serviceId: application.applicationId,
        serviceType: 'application',
        volumeName: 'shop-data',
        backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        destinationId: destination.destinationId,
      });
      await expect(refusal).rejects.toThrow(BadRequestException);
      const message = await refusal.catch((error: Error) => error.message);
      expect(message).toBe(refusalText);
      expect(message).not.toContain('<script source>');
    });

    /**
     * The failed-untar message, and the one thing the unit tests cannot pin:
     * that this particular block wins `rcloneFailureMessage`'s selection and
     * reaches the console, rather than losing to `tar`'s line on stderr.
     *
     * It is the only failure in the restore that happens *after* the volume has
     * been removed and re-created, so it is the only one whose message has to
     * describe damage rather than deny it — and once there was no message
     * at all: `set -e` ended the subshell at the failing `tar` and the last line
     * on stdout was "Creating new volume and restoring data...", which reads as
     * progress.
     *
     * **The stdout below is a fixture and it used to be a stale copy (H-128).**
     * It carried the pre-H-116 sentence — "and it is EMPTY" — and asserted
     * `EMPTY` against it, so the test stayed green while pinning a sentence the
     * product had stopped emitting two commits earlier: a mock whose input is
     * the test's own copy of the string under test cannot fail when that string
     * changes. It still has to be a copy, because what this test drives is
     * `rcloneFailureMessage`'s *selection* over a rejected execution, and the
     * script is never run — but `ABORT_SENTENCE` is now checked against the
     * script the builder really emitted on the way past, which is what makes the
     * copy provably the product's rather than merely plausible.
     */
    it('answers a failed untar by saying what the volume now holds', async () => {
      const { ownerCtx, environment, destination } = await setUpDatabase();
      const application = await applications.create(ownerCtx, {
        name: 'Blog',
        appName: 'main-app',
        environmentId: environment.environmentId,
      });

      // The quote-free middle of the failed-untar sentence, as H-116 rewrote
      // it. Quote free on purpose: `quote()` wraps the whole `echo` word once a
      // `'` is in it, and everything between the quoted values survives
      // verbatim — so this much of the fixture can be compared against the
      // emitted script below without unquoting anything.
      const ABORT_SENTENCE =
        'has already been removed and re-created, with its labels, and what it ' +
        'holds now is whatever the archive managed to extract before it failed ' +
        '— not the data it held before this restore, which is gone.';
      const abort = [
        'Creating new volume and restoring data...',
        '❌ Volume restore aborted - the archive would not extract',
        `   Volume 'shop-data' ${ABORT_SENTENCE} Read the 'tar' errors above for why.`,
        "   The downloaded copy of 'main-app/daily/shop-data.tar' has been " +
          `removed from '${platformHostRoot()}/volume-backups/shop-data' as this run ` +
          "exited, so restoring again re-downloads it from bucket 'cloudgate-backups'.",
        'Local backup file cleaned up ✅',
      ].join('\n');
      execMock.execAsync.mockReset().mockRejectedValue(
        Object.assign(
          new Error(
            'Command execution failed: Command failed: <script source>',
          ),
          {
            stdout: abort,
            // What `tar` said, which is the reason and not the consequence —
            // and which would be the whole answer if this block did not win.
            stderr: 'tar: This does not look like a tar archive\n',
          },
        ),
      );

      const refusal = volumeBackups.restore(ownerCtx, {
        serviceId: application.applicationId,
        serviceType: 'application',
        volumeName: 'shop-data',
        backupFileName: 'main-app/daily/shop-data.tar',
        destinationId: destination.destinationId,
      });
      await expect(refusal).rejects.toThrow(BadRequestException);
      const message = await refusal.catch((error: Error) => error.message);

      expect(message).toContain('the archive would not extract');
      expect(message).toContain("Volume 'shop-data' has already been removed");
      expect(message).toContain('whatever the archive managed to extract');
      // H-116's own claim: the volume holds the partial extraction, so the word
      // that used to be here is the one thing the sentence must not say.
      expect(message).not.toContain('EMPTY');
      expect(message).toContain('re-downloads it from bucket');
      // The narration above the marker is not part of the answer, and `tar`'s
      // line did not win over the block written to be read.
      expect(message).not.toContain('Creating new volume and restoring data');
      expect(message).toMatch(/^❌ Volume restore aborted/);

      // H-128: and the fixture is the product's sentence, not a copy that has
      // drifted from it. The rejected execution still received the real script,
      // so the builder's own output is right here to check it against.
      const [script] = execMock.execAsync.mock.calls[0] as [string];
      expect(script).toContain(ABORT_SENTENCE);
    });

    /**
     * F-41's pass condition: **the masked marker present in the answer
     * the caller reads**, on a route that can produce one.
     *
     * The credential assertions elsewhere in this file check an *absence* — no
     * key in the message — and an absence proves nothing about the mask: it
     * holds equally on a route that answers nothing, or on one where nothing
     * named a credential to begin with. This asserts the marker itself, over
     * HTTP, so what is checked is the body the console renders.
     *
     * The stream that carries the leak is **stderr**. The restore's script gets
     * its credentials from rclone's environment and never names one. Unlike the
     * *run* path, which wraps its script as `(…) >> ${run.logPath} 2>&1` and so
     * leaves both streams empty on the `ExecError`, the restore runs
     * unredirected — which is why this is one of the two routes an operator
     * meets a bucket refusal on, and the reason stdout below is only narration:
     * the diagnosis is one stream over, and `rcloneFailureMessage` has to reach
     * it.
     *
     * **What puts a credential into that stderr is the URL rclone dialled, not
     * a provider's error body.** This test used to hand rclone an
     * `InvalidAccessKeyId` body with the key in `<AWSAccessKeyId>`, and rclone
     * cannot produce that: its S3 backend keeps `Code` and `Message` from an
     * error body and discards the remainder before formatting anything —
     * measured against a stub returning AWS's exact XML that `curl` confirmed
     * was on the wire. So the old fixture was green over a population of zero,
     * which is F-41's own defect one layer up.
     *
     * What rclone always echoes is the URL, and `Destination.endpoint` is a free
     * string an operator can paste credentials into. Go renders such a URL
     * through `net/http`'s `stripPassword`: the password becomes `***` and the username
     * survives, so the access key reaches stderr in clear and the secret never
     * can — which is why this fixture masks the key and why asserting the
     * secret's absence here would be vacuous.
     *
     * **This fixture is bound to the rclone `deploy/install.sh` installs, and the
     * version is already load-bearing in this module.** The shape it asserts was
     * read off `rclone v1.60.1-DEV` — apt's, `install.sh:144` — whose S3 backend
     * is aws-sdk-go **v1**. rclone later moved that backend to aws-sdk-go v2,
     * which rebuilds the request URL from the resolved endpoint and drops its
     * userinfo, so on 1.75.0 the dialled URL reaches stderr with no key and no
     * `***` in it at all. A bump to the installed rclone therefore makes this
     * test green over a population of zero — F-41's defect a third time — and
     * H-120 is the neighbour that proves the version moves, since
     * `--max-duration` is inert on this same 1.60.1.
     */
    it('masks the access key the dialled endpoint carries into the 400', async () => {
      const { ownerSession, ownerCtx, environment } = await setUpDatabase();
      const application = await applications.create(ownerCtx, {
        name: 'Blog',
        appName: 'main-app',
        environmentId: environment.environmentId,
      });
      // Its own destination rather than `setUpDatabase`'s, because the endpoint
      // holding the pasted credentials is the whole fixture.
      const destination = await destinations.create(ownerCtx, {
        name: 'pasted-endpoint',
        provider: 'Cloudflare',
        accessKey: ACCESS_KEY,
        secretAccessKey: SECRET,
        bucket: 'cloudgate-backups',
        region: 'auto',
        endpoint: `https://${ACCESS_KEY}:${SECRET}@minio.example.test`,
      });

      const tarball = 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar';
      // `***` is Go's own rendering of a URL password (net/http's stripPassword,
      // measured against rclone v1.60.1 — the version install.sh deploys); the
      // username survives, which is why the access key is the half we must mask.
      const url = `https://${ACCESS_KEY}:***@minio.example.test/cloudgate-backups/${tarball}`;
      const providerBody =
        `2026/07/23 10:20:31 ERROR : ${tarball}: Failed to copy: RequestError: ` +
        'send request failed\n' +
        `caused by: Get "${url}": dial tcp: lookup minio.example.test: no such host\n`;

      execMock.execAsync.mockReset().mockRejectedValue(
        new ExecError(
          'Command execution failed: Command failed: <script source>',
          {
            command: '<script source>',
            // How far the transcript got, which is not what went wrong.
            stdout:
              '=== VOLUME RESTORE FOR APPLICATION ===\n' +
              'Application: main-app\n' +
              'Downloading backup from S3...\n',
            stderr: providerBody,
            // Not 75: that exit code is the lock's, and answers 409.
            exitCode: 1,
          },
        ),
      );

      const res = await request(server)
        .post('/volume-backups/restore')
        .set('Cookie', ownerSession.cookie)
        .send({
          serviceId: application.applicationId,
          serviceType: 'application',
          volumeName: 'shop-data',
          backupFileName: tarball,
          destinationId: destination.destinationId,
        });

      expect(res.status).toBe(400);
      const { message } = res.body as { message: string };
      // Presence, which is the whole point: absence of the key holds equally on
      // a route that answers nothing.
      //
      // Two masks compose here, which is why the secret half reads
      // `[credential elided]` and not this file's own `***`: `ExecError`'s
      // constructor elides URL userinfo by shape before `redactS3Credentials`
      // ever runs, so by the time the known-value mask walks the string there
      // is no secret left in it to substitute for. The access key is
      // still this file's mask, in the user position the shape rule keeps.
      expect(message).toContain(
        'https://••••••:[credential elided]@minio.example.test',
      );
      expect(message).not.toContain(ACCESS_KEY);
      expect(message).not.toContain(SECRET);
      // The diagnosis is the whole reason the body is shown, so it survives the
      // mask intact — and it is rclone's reason, not the narration. The second
      // of these is what makes this the harder of the two tests: stderr beats a
      // stdout that is still narrating.
      expect(message).toContain('dial tcp');
      expect(message).toContain('no such host');
      expect(message).not.toContain('Downloading backup from S3...');
    });
  });

  describe('compose stack backups', () => {
    it('scales the stack service down under the volume lock and uploads into its own S3 directory', async () => {
      const { ownerCtx, environment, destination } = await setUpDatabase();
      const stack = await compose.create(ownerCtx, {
        name: 'Shop Stack',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
        composeType: 'stack',
      });

      const volumeBackup = await createVolumeBackup(ownerCtx, {
        name: 'Stack volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'compose',
        serviceId: stack.composeId,
        serviceName: 'db',
        turnOff: true,
        destinationId: destination.destinationId,
      });
      expect(volumeBackup.composeId).toBe(stack.composeId);

      await volumeBackups.runManual(ownerCtx, volumeBackup.volumeBackupId);

      const [script] = execMock.execAsync.mock.calls[1] as [string];
      // The run serializes on the lock of the volume it backs up, not of the
      // service that mounts it — two rows naming this volume under
      // different services now wait for each other.
      expect(script).toContain(
        `LOCK_PATH=${platformHostRoot()}/volume-backup-lock-shop-data`,
      );
      // The negative is still live across the quoting move (H-32): a lock path
      // is `[a-z0-9_-]` and a `/`, so `quote()` leaves it exactly as written and
      // this string would still appear if the wrong volume were locked.
      expect(script).not.toContain('volume-backup-lock-shop-stack_db');
      // …scales the stack service to 0 while the tar runs…
      expect(script).toContain(
        'docker service update --replicas=0 shop-stack_db',
      );
      // Double-quoted since H-96, when the restart became the body of
      // `restore_workload` and moved into a `trap … EXIT` in front of the stop:
      // the `case` guard that proves the count is digits runs in the outer shell
      // and this use runs inside the trap's subshell.
      expect(script).toContain(
        'docker service update --replicas="$ACTUAL_REPLICAS" --with-registry-auth shop-stack_db',
      );
      // …from a trap, so a tar that fails between the two cannot skip it. The
      // executed proof is in `volume-backup-commands.spec.ts`; what this route
      // adds is that the script the service actually dispatches carries it.
      expect(script).toContain('trap restore_workload EXIT');
      expect(script.indexOf('trap restore_workload EXIT')).toBeLessThan(
        script.indexOf('docker service update --replicas=0 shop-stack_db'),
      );
      // …and the tarball lands in the stack service's own S3 directory.
      expect(script).toContain(
        '\\:s3\\:cloudgate-backups/shop-stack_db/daily/shop-data-',
      );
    });
  });

  // Three operations mutate one Docker volume — a backup of it, a restore
  // of it and Remove containers on a compose stack that backs it up — and only
  // the first serialized against itself. Every synchronous caller now refuses
  // rather than holding an HTTP request open for somebody else's tar.
  describe('volume lock contention', () => {
    /** What a script that could not take the lock exits with. There is no busy
     * marker in the stdout of a *backup* run: `run()` redirects the whole
     * script into the run's log file, so only the status reaches the service. */
    const lockHeld = () =>
      Object.assign(new Error('Command failed with exit code 75'), {
        exitCode: VOLUME_LOCK_BUSY_EXIT_CODE,
        stdout: '',
        stderr: '',
      });

    /** A postgres-owned volume backup of `shop-data`, ready to run. */
    async function setUpVolumeBackup() {
      const context = await setUpDatabase();
      const row = await createVolumeBackup(context.ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres',
        serviceId: context.database.postgresId,
        destinationId: context.destination.destinationId,
      });
      return { ...context, row };
    }

    it('answers a manually triggered run that finds the lock held with 409, naming the volume', async () => {
      const { ownerCtx, row } = await setUpVolumeBackup();
      const dispatch = jest.spyOn(
        ctx.app.get(NotificationDispatcherService),
        'dispatch',
      );

      execMock.execAsync
        .mockReset()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        .mockRejectedValueOnce(lockHeld())
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const run = volumeBackups.runManual(ownerCtx, row.volumeBackupId);
      await expect(run).rejects.toThrow(ConflictException);
      const message = await run.catch((error: Error) => error.message);
      expect(message).toBe(volumeLockBusyMessage('shop-data'));

      // A 409'd run is still a run that was asked for and did not happen, so it
      // is recorded and notified exactly like any other failure.
      const recorded = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE volume_backup_id = ${row.volumeBackupId}`,
      );
      expect(recorded.rows[0]).toMatchObject({ status: 'error' });
      expect(dispatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'volume-backup',
          volumeName: 'shop-data',
          status: 'error',
        }),
      );
      dispatch.mockRestore();
    });

    it('answers POST /volume-backups/:id/run with 409 when the lock is held', async () => {
      const { ownerSession, row } = await setUpVolumeBackup();

      execMock.execAsync
        .mockReset()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        .mockRejectedValueOnce(lockHeld())
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const ran = await request(server)
        .post(`/volume-backups/${row.volumeBackupId}/run`)
        .set('Cookie', ownerSession.cookie);

      expect(ran.status).toBe(409);
      expect(ran.body).toMatchObject({
        statusCode: 409,
        message: volumeLockBusyMessage('shop-data'),
      });
    });

    it('a scheduled run waits on a held lock where a manual run refuses it', async () => {
      const { ownerCtx, row } = await setUpVolumeBackup();

      await volumeBackups.runScheduled(row.volumeBackupId);
      const [scheduledScript] = execMock.execAsync.mock.calls[1] as [string];
      expect(scheduledScript).toContain('flock 9');
      // Nobody is holding a request open on the cron path, and the next tick is
      // a day away, so giving up would mean skipping the backup outright.
      expect(scheduledScript).not.toContain('exit 75');

      execMock.execAsync.mockClear();
      await volumeBackups.runManual(ownerCtx, row.volumeBackupId);
      const [manualScript] = execMock.execAsync.mock.calls[1] as [string];
      expect(manualScript).toContain('if ! flock -n 9; then');
      expect(manualScript).toContain(`exit ${VOLUME_LOCK_BUSY_EXIT_CODE}`);
    });

    it('answers a restore that finds the lock held with 409, and removes no volume', async () => {
      const { ownerCtx, environment, destination } = await setUpDatabase();
      const application = await applications.create(ownerCtx, {
        name: 'Blog',
        appName: 'main-app',
        environmentId: environment.environmentId,
      });

      execMock.execAsync.mockReset().mockRejectedValue(
        Object.assign(new Error('Command failed with exit code 75'), {
          exitCode: VOLUME_LOCK_BUSY_EXIT_CODE,
          stdout:
            'Waiting for volume lock: shop-data\nVolume lock busy: shop-data\n',
          stderr: '',
        }),
      );

      const restore = volumeBackups.restore(ownerCtx, {
        serviceId: application.applicationId,
        serviceType: 'application',
        volumeName: 'shop-data',
        backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        destinationId: destination.destinationId,
      });
      await expect(restore).rejects.toThrow(ConflictException);
      const message = await restore.catch((error: Error) => error.message);
      expect(message).toBe(volumeLockBusyMessage('shop-data'));
      // Not the stdout-first message: a script stopped by its own lock
      // preamble has no diagnosis to relay, and "try again" is not "you asked
      // for something wrong".
      expect(message).not.toContain('Waiting for volume lock');

      // The script exited before its own guard, so nothing removed or
      // re-created the volume.
      const [script] = execMock.execAsync.mock.calls[0] as [string];
      expect(script.indexOf('exit 75')).toBeLessThan(
        script.indexOf('docker volume rm shop-data --force'),
      );
    });

    it('keeps a restore that fails for any other reason a 400 with the script text', async () => {
      const { ownerCtx, environment, destination } = await setUpDatabase();
      const application = await applications.create(ownerCtx, {
        name: 'Blog',
        appName: 'main-app',
        environmentId: environment.environmentId,
      });

      execMock.execAsync.mockReset().mockRejectedValue(
        Object.assign(new Error('Command failed: <script source>'), {
          exitCode: 1,
          stdout: '❌ Volume restore aborted - volume is in use',
          stderr: '',
        }),
      );

      const restore = volumeBackups.restore(ownerCtx, {
        serviceId: application.applicationId,
        serviceType: 'application',
        volumeName: 'shop-data',
        backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        destinationId: destination.destinationId,
      });
      await expect(restore).rejects.toThrow(BadRequestException);
      const message = await restore.catch((error: Error) => error.message);
      expect(message).toBe('❌ Volume restore aborted - volume is in use');
      // The 409 belongs to one exit code and not to failure in general.
      expect(message).not.toContain('is busy');
    });
  });

  // The error path used to remove staged tarballs with a `*.tar` glob
  // against the run's staging directory. `runManual` and `runScheduled` share
  // one run core with no in-flight guard, so one row can be running twice at
  // once — and the glob then deleted the healthy run's tarball mid-flight,
  // failing it at upload on a missing local file. The volume lock does not close
  // this: the lock is inside the script and the cleanup runs in the service's
  // `catch`, after the script exited and released it.
  describe("a failed run's cleanup", () => {
    const stagedTarballOf = (command: string) =>
      /tar cvf \/backup\/(\S+\.tar)/.exec(command)?.[1];

    /** Resolves once `predicate` holds, so a run can be held mid-script while
     * a second one is started against the same row. */
    const waitFor = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        'timed out waiting for the first run to reach its script',
      );
    };

    it('removes only its own tarball, leaving a concurrent run of the same row staged', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const row = await createVolumeBackup(ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      const staged: string[] = [];
      let failFirst: (() => void) | undefined;
      execMock.execAsync.mockReset().mockImplementation((command: string) => {
        if (command.includes('tar cvf')) {
          staged.push(stagedTarballOf(command) as string);
          if (staged.length === 1) {
            return new Promise((_resolve, reject) => {
              failFirst = () =>
                reject(new Error('rclone: connection reset by peer'));
            });
          }
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      });

      // The first run reaches its script and is held there…
      const first = volumeBackups.runManual(ownerCtx, row.volumeBackupId).then(
        () => {
          throw new Error('expected the first run to reject');
        },
        (raised: Error) => raised,
      );
      await waitFor(() => failFirst !== undefined);
      // …while a second run of the same row stages a tarball beside it and
      // completes.
      await volumeBackups.runManual(ownerCtx, row.volumeBackupId);
      failFirst?.();
      const error = await first;

      expect(staged).toHaveLength(2);
      expect(staged[1]).not.toBe(staged[0]);

      const stagingDir = `${platformHostRoot()}/volume-backups/${row.appName}`;
      const cleanups = execMock.execAsync.mock.calls
        .map(([command]) => command as string)
        .filter((command) => command.startsWith('rm '));
      expect(cleanups).toEqual([`rm -f ${stagingDir}/${staged[0]}`]);
      // The healthy run's tarball is not in the command that fired, and no
      // glob is either. Both needles survive the H-19 quoting move: a tarball
      // name is `[A-Za-z0-9.-]`, and a `*` that came back would come back as
      // `\*`, which still contains the `*` this looks for.
      expect(cleanups[0]).not.toContain(staged[1]);
      expect(cleanups[0]).not.toContain('*');

      // The second run is recorded done, not dragged down with the first.
      const recorded = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE volume_backup_id = ${row.volumeBackupId} ORDER BY created_at`,
      );
      expect(
        recorded.rows.map((r) => (r as { status: string }).status).sort(),
      ).toEqual(['done', 'error']);
      expect(error.message).toContain('connection reset by peer');
    });

    it('records and notifies the original failure when the cleanup itself fails', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const row = await createVolumeBackup(ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });
      const dispatch = jest.spyOn(
        ctx.app.get(NotificationDispatcherService),
        'dispatch',
      );

      execMock.execAsync
        .mockReset()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        // The run fails before the tar was ever written…
        .mockRejectedValueOnce(new Error('volume not found'))
        // …and the cleanup of a file that is not there fails too.
        .mockRejectedValueOnce(new Error('rm: Read-only file system'));

      const error = await volumeBackups
        .runManual(ownerCtx, row.volumeBackupId)
        .then(
          () => {
            throw new Error('expected the run to reject');
          },
          (raised: Error) => raised,
        );

      // The cleanup is best-effort: what surfaces, what is recorded and what is
      // notified are all the original failure.
      expect(error.message).toBe('volume not found');
      expect(error.message).not.toContain('Read-only file system');
      expect(dispatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 'error',
          errorMessage: 'volume not found',
        }),
      );
      const recorded = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE volume_backup_id = ${row.volumeBackupId}`,
      );
      expect(recorded.rows[0]).toMatchObject({ status: 'error' });
      dispatch.mockRestore();
    });
  });

  /**
   * `create` inserted the row and *then* called `syncJob`, which builds
   * the `CronJob` — and `cron` throws synchronously on an expression it cannot
   * parse. `schedule` was validated as `z.string().min(1)`, so
   * `{"schedule":"not a cron"}` answered 500 with the backup committed and
   * nothing ever running it: verbatim the hole closed for schedules, still
   * open here. The refusal is a 400 now, and the insert is last regardless.
   */
  describe('a create whose cron cannot be registered', () => {
    /** Registration only happens for an enabled backup — `syncJob` branches. */
    const enabledBackup = (serviceId: string, destinationId: string) => ({
      name: 'Nightly volume backup',
      volumeName: 'shop-data',
      prefix: 'daily',
      schedule: '0 3 * * *',
      serviceType: 'postgres' as const,
      serviceId,
      destinationId,
      enabled: true,
    });

    /**
     * The ordering pin, and the one that cannot be satisfied by accident.
     *
     * The schedules fix's shape reads the target table from *inside* the write
     * mock, because an `await`ed write leaves a moment to read under.
     * `SchedulingService .register` is synchronous — `syncJob` does not await
     * it, and there is no such moment. Throwing out of it is the equivalent: it
     * freezes the create at exactly the instant the registration happens, and
     * what the table holds then is what an insert-then-register create would
     * already have committed. `cron`'s own `CronError: Unknown alias: not` is
     * the failure being stood in for.
     */
    it('registers the cron job before the row exists', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const register = jest
        .spyOn(ctx.app.get(SchedulingService), 'register')
        .mockImplementationOnce(() => {
          throw new Error('CronError: Unknown alias: not');
        });

      await expect(
        volumeBackups.create(
          ownerCtx,
          createVolumeBackupSchema.parse(
            enabledBackup(database.postgresId, destination.destinationId),
          ),
        ),
      ).rejects.toThrow('Unknown alias');

      // Nothing was written on the way to being refused.
      expect(await ctx.db.select().from(volumeBackup)).toHaveLength(0);
      register.mockRestore();
    });

    it('keys the cron job by the id the row lands with', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      let registeredId: string | undefined;
      const register = jest
        .spyOn(ctx.app.get(SchedulingService), 'register')
        .mockImplementationOnce((id: string) => {
          registeredId = id;
        });

      const created = await volumeBackups.create(
        ownerCtx,
        createVolumeBackupSchema.parse(
          enabledBackup(database.postgresId, destination.destinationId),
        ),
      );

      // The registration happens first, so the id has to be minted in the
      // service rather than by the column default — otherwise the job and the
      // row would be keyed differently and `remove` would unregister nothing.
      expect(registeredId).toBe(created.volumeBackupId);
      expect(await ctx.db.select().from(volumeBackup)).toHaveLength(1);
      register.mockRestore();
    });

    it('refuses a cron expression the scheduler cannot parse, writing nothing', async () => {
      const { ownerSession, database, destination } = await setUpDatabase();
      const body = {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      };

      const refused = await request(server)
        .post('/volume-backups')
        .set('Cookie', ownerSession.cookie)
        .send({ ...body, schedule: 'not a cron' });
      expect(refused.status).toBe(400);

      // No Server is involved: the row is the whole defect.
      expect(await ctx.db.select().from(volumeBackup)).toHaveLength(0);

      // And the same expression is refused on the update shape.
      const created = await request(server)
        .post('/volume-backups')
        .set('Cookie', ownerSession.cookie)
        .send({ ...body, schedule: '0 3 * * *' });
      expect(created.status).toBe(201);
      const { volumeBackupId } = created.body as { volumeBackupId: string };

      const patched = await request(server)
        .patch(`/volume-backups/${volumeBackupId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ schedule: '0 0 32 * *' });
      expect(patched.status).toBe(400);

      const [row] = await ctx.db.select().from(volumeBackup);
      expect(row.schedule).toBe('0 3 * * *');
    });
  });

  describe('CRUD', () => {
    it('creates, reads, lists by service, updates and removes a volume backup', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const created = await createVolumeBackup(ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });
      expect(created.volumeBackupId).toEqual(expect.any(String));
      expect(created.postgresId).toBe(database.postgresId);
      expect(created.serviceType).toBe('postgres');
      expect(created.turnOff).toBe(false);
      expect(created.appName).toMatch(/^volume-backup-/);

      const found = await volumeBackups.findOne(
        ownerCtx,
        created.volumeBackupId,
      );
      expect(found).toMatchObject({
        volumeBackupId: created.volumeBackupId,
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
      });

      const listed = await volumeBackups.listByService(ownerCtx, {
        serviceId: database.postgresId,
        serviceType: 'postgres',
      });
      expect(listed).toHaveLength(1);
      expect(listed[0].volumeBackupId).toBe(created.volumeBackupId);

      const updated = await volumeBackups.update(
        ownerCtx,
        created.volumeBackupId,
        { prefix: 'weekly', keepLatestCount: 3, turnOff: true, enabled: true },
      );
      expect(updated).toMatchObject({
        volumeBackupId: created.volumeBackupId,
        prefix: 'weekly',
        keepLatestCount: 3,
        turnOff: true,
        enabled: true,
      });

      await volumeBackups.remove(ownerCtx, created.volumeBackupId);
      await expect(
        volumeBackups.findOne(ownerCtx, created.volumeBackupId),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a destination belonging to another organization', async () => {
      const { ownerSession, ownerCtx, database } = await setUpDatabase();
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );
      const foreignDestination = await destinations.create(secondOrgCtx, {
        name: 'other-backups',
        accessKey: 'AKIAOTHER',
        secretAccessKey: 'other-secret',
        bucket: 'other-bucket',
        region: 'auto',
        endpoint: 'https://example.com',
      });

      await expect(
        createVolumeBackup(ownerCtx, {
          name: 'Nightly volume backup',
          volumeName: 'shop-data',
          prefix: 'daily',
          schedule: '0 3 * * *',
          serviceType: 'postgres',
          serviceId: database.postgresId,
          destinationId: foreignDestination.destinationId,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('row-level access', () => {
    it('denies a member without row access to the owning service', async () => {
      const { organizationId, ownerSession, ownerCtx, database, destination } =
        await setUpDatabase();
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);

      const input = {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres' as const,
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      };
      await expect(createVolumeBackup(memberCtx, input)).rejects.toThrow(
        ForbiddenException,
      );

      const created = await createVolumeBackup(ownerCtx, input);
      await expect(
        volumeBackups.findOne(memberCtx, created.volumeBackupId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        volumeBackups.listByService(memberCtx, {
          serviceId: database.postgresId,
          serviceType: 'postgres',
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        volumeBackups.update(memberCtx, created.volumeBackupId, {
          prefix: 'weekly',
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        volumeBackups.runManual(memberCtx, created.volumeBackupId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        volumeBackups.remove(memberCtx, created.volumeBackupId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hides volume backups and their services from other organizations', async () => {
      const { ownerSession, ownerCtx, database, destination } =
        await setUpDatabase();
      const created = await createVolumeBackup(ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        volumeBackups.findOne(secondOrgCtx, created.volumeBackupId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        volumeBackups.runManual(secondOrgCtx, created.volumeBackupId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        volumeBackups.remove(secondOrgCtx, created.volumeBackupId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('HTTP surface', () => {
    it('creates, reads, lists, runs, updates and deletes a volume backup through the controller', async () => {
      const { ownerSession, database, destination } = await setUpDatabase();

      const invalid = await request(server)
        .post('/volume-backups')
        .set('Cookie', ownerSession.cookie)
        .send({ schedule: '0 3 * * *' });
      expect(invalid.status).toBe(400);

      const created = await request(server)
        .post('/volume-backups')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Nightly volume backup',
          volumeName: 'shop-data',
          prefix: 'daily',
          schedule: '0 3 * * *',
          serviceType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        });
      expect(created.status).toBe(201);
      const { volumeBackupId } = created.body as { volumeBackupId: string };

      const found = await request(server)
        .get(`/volume-backups/${volumeBackupId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({
        volumeName: 'shop-data',
        prefix: 'daily',
      });

      const listed = await request(server)
        .get('/volume-backups')
        .query({ serviceId: database.postgresId, serviceType: 'postgres' })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);

      const ran = await request(server)
        .post(`/volume-backups/${volumeBackupId}/run`)
        .set('Cookie', ownerSession.cookie);
      expect(ran.status).toBe(204);

      const restored = await request(server)
        .post('/volume-backups/restore')
        .set('Cookie', ownerSession.cookie)
        .send({
          serviceId: database.postgresId,
          serviceType: 'application',
          volumeName: 'shop-data',
          backupFileName: 'main-db/daily/shop-data-x.tar',
          destinationId: destination.destinationId,
        });
      // The postgres id is not an application, so the restore target reads
      // as absent — the endpoint itself is wired.
      expect(restored.status).toBe(404);

      const updated = await request(server)
        .patch(`/volume-backups/${volumeBackupId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ prefix: 'weekly' });
      expect(updated.status).toBe(200);
      expect((updated.body as { prefix: string }).prefix).toBe('weekly');

      const removed = await request(server)
        .delete(`/volume-backups/${volumeBackupId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/volume-backups/${volumeBackupId}`)
        .set('Cookie', ownerSession.cookie);
      expect(gone.status).toBe(404);
    });
  });
});
