import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { BackupsService } from '../../src/backups/backups.service';
import { createBackupSchema } from '../../src/backups/dto/backup.dto';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { ComposeService } from '../../src/compose/compose.service';
import { MongoService } from '../../src/databases/mongo/mongo.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionCtx } from '../../src/rbac/permission.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
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

describe('Backups (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let mongo: MongoService;
  let postgres: PostgresService;
  let compose: ComposeService;
  let destinations: DestinationsService;
  let backups: BackupsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  /**
   * Creates a backup from a request-shaped fixture. `backupType` carries a
   * zod `.default()`, so it is optional on the schema's *input* and required
   * on its output — and `CreateBackupDto` is typed from the output. Fixtures
   * that omit it are standing in for an HTTP caller that omits it, so they
   * are typed from the input and put through the schema here, exactly as the
   * ZodValidationPipe does before a request body reaches the service.
   */
  const createBackup = (
    permCtx: PermissionCtx,
    data: z.input<typeof createBackupSchema>,
  ) => backups.create(permCtx, createBackupSchema.parse(data));

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    mongo = ctx.app.get(MongoService);
    postgres = ctx.app.get(PostgresService);
    compose = ctx.app.get(ComposeService);
    destinations = ctx.app.get(DestinationsService);
    backups = ctx.app.get(BackupsService);
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

  describe('manual run', () => {
    it('streams pg_dump | gzip through rclone rcat to the destination and records success', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const backup = await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      await backups.runManual(ownerCtx, backup.backupId);

      // The database has no `serverId`, so the run is local-exec work on the
      // platform host and its log lives under this process's
      // CLOUDGATE_DIRECTORY — asked of the machine rather than spelled as a
      // Server's `/etc/cloudgate`, which matched only while the variable was
      // unset.
      const runLogDirectory = `${cloudgateDirectoryOn(null)}/logs/${backup.appName}`;

      // First exec initializes the run's log file under the backup's appName.
      const initCall = execMock.execAsync.mock.calls[0] as [string];
      expect(initCall[0]).toContain(`mkdir -p ${runLogDirectory}`);

      // Second exec is the wrapper script: container search for the swarm
      // service, the postgres dump pipeline, and the rclone upload — run under
      // bash for pipefail, with the destination's credentials in rclone's own
      // environment rather than in the command line.
      const [script, options] = execMock.execAsync.mock.calls[1] as [
        string,
        { shell: string; env: Record<string, string> },
      ];
      expect(options.shell).toBe('/bin/bash');
      expect(options.env).toMatchObject({
        RCLONE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEACCESSKEY',
        RCLONE_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-example-secret-key',
      });
      expect(script).not.toContain('wJalrXUtnFEMI-example-secret-key');
      expect(script).not.toContain('AKIAEXAMPLEACCESSKEY');
      expect(script).toContain(
        'CONTAINER_ID=$(docker ps -q --filter "status=running" --filter label\\=com.docker.swarm.service.name\\=main-db | head -n 1)',
      );
      // The dump's own `|| { … }` sits between the two halves of the pipe so the
      // failure branch can say which one broke.
      expect(script).toContain(
        "docker exec -i $CONTAINER_ID bash -c 'set -o pipefail; pg_dump -Fc --no-acl --no-owner -h localhost -U shop_user --no-password shop | gzip'" +
          ' || { echo "$DUMP_FAILED" >&2; exit 1; }; } | ' +
          'rclone rcat \\:s3\\:cloudgate-backups/main-db/daily/',
      );
      // The failure branch's cleanup names the very object the rcat writes
      // — the destination the caller handed the builder and the one the
      // `rcat` uses are the same word, which is what this pins. The "could not
      // be named" line is the branch taken when the caller names none (H-36
      // replaced the regex that used to recover it from the built command; the
      // `null` branch and its loud log line stayed).
      expect(script).toMatch(
        /rclone deletefile --retries 1 --low-level-retries 1 --timeout 10s --contimeout 5s \\:s3\\:cloudgate-backups\/main-db\/daily\/\S+\.sql\.gz/,
      );
      expect(script).not.toContain('could not be named');

      // The run is recorded as a done deployment pointing at the backup.
      const recorded = await ctx.db.execute(
        sql`SELECT status, log_path FROM deployment WHERE backup_id = ${backup.backupId}`,
      );
      expect(recorded.rows).toHaveLength(1);
      expect(recorded.rows[0]).toMatchObject({
        status: 'done',
        log_path: expect.stringContaining(`${runLogDirectory}/`) as string,
      });

      // No keepLatestCount → nothing to prune after the run.
      expect(execMock.execAsync).toHaveBeenCalledTimes(2);
    });

    it('prunes all but the newest N dumps after a successful run', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const backup = await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
        keepLatestCount: 7,
      });

      await backups.runManual(ownerCtx, backup.backupId);

      // Retention (keepLatestCount): list the dump files, drop the newest 7
      // from the (reverse-sorted) listing, delete the rest.
      const [pruneCommand, pruneOptions] = execMock.execAsync.mock.calls[2] as [
        string,
        { env: Record<string, string> },
      ];
      expect(pruneCommand).toBe(
        // Every value word is one `quote()`d word (H-36), which is the same argv
        // the old `"…"` spelling produced: `\{`…`\}` is as unexpandable as
        // `"{…}"` was, and `xargs -I{}` still finds its placeholder inside the
        // escaped word because the shell strips the backslashes before xargs
        // sees the argument.
        'rclone lsf --include \\*.\\{sql.gz\\,bson.gz\\,tar.gz\\} \\:s3\\:cloudgate-backups/main-db/daily/ | ' +
          'sort -r | tail -n +$((7+1)) | xargs -I{} ' +
          'rclone delete \\:s3\\:cloudgate-backups/main-db/daily/\\{\\}',
      );
      // Both rclone calls in the line get their credentials from the
      // environment; neither names one.
      expect(pruneOptions.env.RCLONE_S3_SECRET_ACCESS_KEY).toBe(
        'wJalrXUtnFEMI-example-secret-key',
      );
    });

    it('records a failed run as an error deployment and rethrows', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const backup = await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      execMock.execAsync
        .mockReset()
        // Log-file initialization succeeds…
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        // …the backup script itself fails, saying why on its stderr.
        .mockRejectedValueOnce(
          new ExecError('Command execution failed: Command failed: …', {
            command: '…',
            stdout: '',
            stderr: '❌ Error: Container not found\n',
            exitCode: 1,
          }),
        );

      await expect(
        backups.runManual(ownerCtx, backup.backupId),
      ).rejects.toThrow(
        'Dumping shop to prod-backups did not start: the database has no running container.',
      );

      const recorded = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE backup_id = ${backup.backupId}`,
      );
      expect(recorded.rows).toHaveLength(1);
      expect(recorded.rows[0]).toMatchObject({ status: 'error' });
    });

    it('rethrows a failed run with no credential in the message', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const backup = await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      // What a tool echoes back when it repeats what it was given — the
      // leak this once was. The script's stderr is what the answer is built from,
      // so that is where the credentials are planted.
      execMock.execAsync
        .mockReset()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        .mockRejectedValueOnce(
          new ExecError('Command execution failed: Command failed: …', {
            command: '…',
            stdout: '',
            stderr:
              '❌ Error: Upload to S3 failed\n' +
              'Failed to rcat: SignatureDoesNotMatch for ' +
              'AKIAEXAMPLEACCESSKEY / wJalrXUtnFEMI-example-secret-key\n',
            exitCode: 1,
          }),
        );

      const error = await backups.runManual(ownerCtx, backup.backupId).then(
        () => {
          throw new Error('expected the run to reject');
        },
        (e: Error) => e,
      );

      expect(error.message).not.toContain('wJalrXUtnFEMI-example-secret-key');
      expect(error.message).not.toContain('AKIAEXAMPLEACCESSKEY');
      // The diagnosis is why the failure is read at all, so it survives.
      expect(error.message).toContain('SignatureDoesNotMatch');
    });

    /**
     * A destination that refuses the upload used to answer Run now with
     * a bare 500, which the console rendered as "…so nothing changed" — while a
     * failed run sat on Deployments with the reason in its log. The console
     * renders a 400's `message` as the toast, so this pins both.
     */
    it('answers a refused upload with a 400 naming the step, the destination and the run log', async () => {
      const { ownerSession, database, destination } = await setUpDatabase();
      const created = await request(server)
        .post('/backups')
        .set('Cookie', ownerSession.cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        });
      expect(created.status).toBe(201);
      const { backupId } = created.body as { backupId: string };

      // The shape the generated script's upload branch leaves on the exec seam:
      // its heading and rclone's own words on stderr, and Node's
      // `Command failed: <the whole script>` as the message.
      execMock.execAsync
        .mockReset()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        .mockRejectedValueOnce(
          new ExecError(
            'Command execution failed: Command failed: \n\tset -eo pipefail;\n\techo "[$(date)] Starting backup process..."',
            {
              command:
                '\n\tset -eo pipefail;\n\techo "[$(date)] Starting backup process..."',
              stdout: '',
              stderr:
                '❌ Error: Upload to S3 failed\n' +
                'Failed to rcat: SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check your key and signing method.\n',
              exitCode: 1,
            },
          ),
        );

      const res = await request(server)
        .post(`/backups/${backupId}/run`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        message:
          'Uploading the dump of shop to prod-backups failed. ' +
          'The run is listed on Deployments as a failed Database backup, and its log has the full output. ' +
          'The upload stopped with: Failed to rcat: SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check your key and signing method.',
      });
      expect((res.body as { message: string }).message).not.toContain(
        'set -eo pipefail',
      );

      // The run the answer points at is there, and failed.
      const recorded = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE backup_id = ${backupId}`,
      );
      expect(recorded.rows).toEqual([{ status: 'error' }]);
    });
  });

  describe('run history', () => {
    it('records a cron-fired run as a scheduled one and a pressed one as manual', async () => {
      // `runManual` and `runScheduled` share `run`, which hard-coded
      // `title: 'Manual backup'` — so every night's run said somebody pressed
      // the button. The title is what the console's run table shows and sorts
      // on, and this table is where an operator goes to find out what a
      // schedule has been doing.
      const { ownerCtx, database, destination } = await setUpDatabase();
      const backup = await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      await backups.runScheduled(backup.backupId);

      const afterCron = await ctx.db.execute(
        sql`SELECT title, description, status FROM deployment
            WHERE backup_id = ${backup.backupId}`,
      );
      expect(afterCron.rows).toEqual([
        {
          title: 'Scheduled backup',
          description: 'Backup of shop',
          status: 'done',
        },
      ]);

      await backups.runManual(ownerCtx, backup.backupId);

      // Ordered by title rather than by `started_at`, which is an ISO string
      // written a millisecond apart and is not the claim being made.
      const both = await ctx.db.execute(
        sql`SELECT title FROM deployment
            WHERE backup_id = ${backup.backupId} ORDER BY title`,
      );
      expect(both.rows).toEqual([
        { title: 'Manual backup' },
        { title: 'Scheduled backup' },
      ]);
    });
  });

  describe('restore', () => {
    it('pipes the rclone download through gunzip into pg_restore', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();

      await backups.restore(ownerCtx, {
        databaseId: database.postgresId,
        databaseType: 'postgres',
        backupType: 'database',
        databaseName: 'shop',
        backupFile: 'main-db/daily/2026-07-23T10-20-30-456Z.sql.gz',
        destinationId: destination.destinationId,
      });

      const [script, options] = execMock.execAsync.mock.calls[0] as [
        string,
        { env: Record<string, string>; shell: string },
      ];
      expect(script).toBe(
        'set -eo pipefail; CONTAINER_ID=$(docker ps -q --filter "status=running" --filter label\\=com.docker.swarm.service.name\\=main-db | head -n 1) && ' +
          // Reachability first, and only its status is read: a probe that
          // printed into this pipeline would be the first thing pg_restore saw.
          'rclone lsjson --retries 1 --low-level-retries 1 --timeout 30s --contimeout 5s \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz > /dev/null && ' +
          'rclone cat --retries 1 --low-level-retries 1 --timeout 5m --contimeout 10s \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz | gunzip | ' +
          // One `-c` argument, `quote()`d for the host shell that runs `docker`
          // rather than left in a `"…"` that shell had already stripped of
          // meaning (H-37). `shop_user` is safe, so it arrives as the same word
          // the old `-U 'shop_user'` delivered.
          "docker exec -i $CONTAINER_ID sh -c 'pg_restore -U shop_user -d shop -O --clean --if-exists'",
      );
      // The `pipefail` above is only real under bash: without this the
      // shell is whichever `sh` the host defaults to, and a failed download is
      // reported as whatever the engine's import made of an empty stream.
      expect(options.shell).toBe('/bin/bash');
      expect(options.env.RCLONE_S3_SECRET_ACCESS_KEY).toBe(
        'wJalrXUtnFEMI-example-secret-key',
      );
    });

    // The two rclone shapes take **different** low-level retry budgets, and the
    // asymmetry is measured rather than reasoned (reopened). A low-level
    // retry resumes at the offset already read, which is what lets a degraded
    // link assemble a download to a file — 181 s and every byte at
    // `--retries 1 --low-level-retries 10`, against 1083 s and nothing at the
    // `2 × 3` this shipped with. On `rclone cat` it is inert: the same object
    // through the same stalling proxy stopped at 60 s with 39 997 344 bytes and
    // rc=5 at *both* 1 and 10, because a stream already written to stdout cannot
    // be rewound. So mongo's `copy` takes the 10 and the piped shapes keep 1 —
    // raising theirs would buy nothing and lengthen the unreachable case, since
    // the same counter governs a connect that never completes.
    it('mongo: downloads to a temp dir on the resuming retry budget the piped shapes cannot use', async () => {
      const { ownerCtx, environment, destination } = await setUpDatabase();
      const database = await mongo.create(ownerCtx, {
        name: 'Main Mongo',
        appName: 'main-mongo',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });

      await backups.restore(ownerCtx, {
        databaseId: database.mongoId,
        databaseType: 'mongo',
        backupType: 'database',
        databaseName: 'shop',
        backupFile: 'main-mongo/daily/2026-07-23T10-20-30-456Z.bson.gz',
        destinationId: destination.destinationId,
      });

      const [script] = execMock.execAsync.mock.calls[0] as [string];
      expect(script).toContain(
        'rclone copy --retries 1 --low-level-retries 10 --timeout 60s ' +
          '--contimeout 10s --max-duration 30m ' +
          '\\:s3\\:cloudgate-backups/main-mongo/daily/2026-07-23T10-20-30-456Z.bson.gz "$RESTORE_DIR"',
      );
      // …under the wall clock that actually bounds it (H-120). `--max-duration`
      // above is accepted and inert on the rclone this product installs, so the
      // bound is the process — and this call site takes it from the same
      // `bulkDownloadCommand` the volume restore does, which is the whole point
      // of there being one (§1.4).
      expect(script).toContain(
        "if command -v timeout >/dev/null 2>&1; then RCLONE_WALL_CLOCK='timeout 1800'; else RCLONE_WALL_CLOCK=''; fi\n" +
          '$RCLONE_WALL_CLOCK rclone copy --retries 1',
      );
      // The probe is in front of `mktemp`, so an endpoint that is not answering
      // costs this host no directory.
      expect(script.indexOf('rclone lsjson')).toBeLessThan(
        script.indexOf('mktemp -d'),
      );
    });

    // The engine's or rclone's own refusal is the caller's to act on —
    // a missing dump, a bucket that is not there, an import that the engine
    // rejected — so it is answered rather than left to the exception filter.
    it('answers a failed restore with the script\u2019s own output', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      execMock.execAsync.mockReset().mockRejectedValue(
        Object.assign(
          new Error(
            'Command execution failed: Command failed: <4.6 KB of script source>',
          ),
          {
            stdout:
              'pg_restore: error: could not open input file: No such file',
            stderr: '',
          },
        ),
      );

      const refusal = backups.restore(ownerCtx, {
        databaseId: database.postgresId,
        databaseType: 'postgres',
        backupType: 'database',
        databaseName: 'shop',
        backupFile: 'main-db/daily/2026-07-23T10-20-30-456Z.sql.gz',
        destinationId: destination.destinationId,
      });
      await expect(refusal).rejects.toThrow(BadRequestException);
      const message = await refusal.catch((error: Error) => error.message);
      // The script's stdout, not `err.message` — which is the script source.
      expect(message).toBe(
        'pg_restore: error: could not open input file: No such file',
      );
      expect(message).not.toContain('4.6 KB of script source');
    });

    it('refuses a failed restore with no credential in the message', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      execMock.execAsync
        .mockReset()
        .mockRejectedValue(
          new Error(
            'Command failed: rclone cat: 403 for AKIAEXAMPLEACCESSKEY ' +
              'wJalrXUtnFEMI-example-secret-key',
          ),
        );

      const error = await backups
        .restore(ownerCtx, {
          databaseId: database.postgresId,
          databaseType: 'postgres',
          backupType: 'database',
          databaseName: 'shop',
          backupFile: 'main-db/daily/2026-07-23T10-20-30-456Z.sql.gz',
          destinationId: destination.destinationId,
        })
        .then(
          () => {
            throw new Error('expected the restore to reject');
          },
          (e: Error) => e,
        );

      // Now a 400 rather than a rethrow — and still masked, so
      // the sentence the caller reads carries neither credential.
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).not.toContain('wJalrXUtnFEMI-example-secret-key');
      expect(error.message).not.toContain('AKIAEXAMPLEACCESSKEY');
    });
  });

  describe('compose backups', () => {
    it('runs the dump inside the stack service with metadata credentials', async () => {
      const { ownerCtx, environment, destination } = await setUpDatabase();
      const stack = await compose.create(ownerCtx, {
        name: 'Shop Stack',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
      });

      const backup = await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'mysql',
        backupType: 'compose',
        serviceId: stack.composeId,
        serviceName: 'db',
        metadata: { mysql: { databaseRootPassword: 'r00t-secret' } },
        destinationId: destination.destinationId,
      });
      expect(backup.composeId).toBe(stack.composeId);

      await backups.runManual(ownerCtx, backup.backupId);

      const [script] = execMock.execAsync.mock.calls[1] as [string];
      // The container is found by compose-project labels…
      expect(script).toContain(
        'CONTAINER_ID=$(docker ps -q --filter "status=running" --filter label\\=com.docker.compose.project\\=shop-stack --filter label\\=com.docker.compose.service\\=db | head -n 1)',
      );
      // …the dump runs with the metadata credentials, and the dumps land in
      // the stack service's own S3 directory. The `database` word is bare
      // rather than `'…'` because `quote()` leaves an already-safe value alone
      // (H-37) — `shop` is the same argv `'shop'` delivered, and an unsafe one
      // would be escaped instead of substituted by the host shell before
      // `docker` ever ran.
      //
      // The **password** is not in this string at all: it is named,
      // passed through with `docker exec -e`, and carried in the environment
      // the script is executed with. That the operator's own value still
      // reaches the host is asserted below and in
      // `backup-metadata-at-rest.e2e-spec.ts`, which is the half a proof of
      // absence on its own would not distinguish from a broken backup.
      expect(script).toContain(
        'docker exec -e CLOUDGATE_DB_PASSWORD -i $CONTAINER_ID bash -c \'set -o pipefail; mysqldump --default-character-set=utf8mb4 -u root --password="$CLOUDGATE_DB_PASSWORD" --single-transaction --no-tablespaces --quick shop | gzip\'' +
          ' || { echo "$DUMP_FAILED" >&2; exit 1; }; } | rclone rcat',
      );
      expect(script).not.toContain('r00t-secret');
      const [, dumpOptions] = execMock.execAsync.mock.calls[1] as [
        string,
        { env: Record<string, string> },
      ];
      expect(dumpOptions.env.CLOUDGATE_DB_PASSWORD).toBe('r00t-secret');
      expect(script).toContain(
        '\\:s3\\:cloudgate-backups/shop-stack_db/daily/',
      );
      // A compose backup's failed run cleans up its own object too.
      expect(script).toMatch(
        /rclone deletefile --retries 1 --low-level-retries 1 --timeout 10s --contimeout 5s \\:s3\\:cloudgate-backups\/shop-stack_db\/daily\/\S+\.sql\.gz/,
      );
    });
  });

  describe('CRUD', () => {
    it('creates, reads, updates and removes a backup', async () => {
      const { ownerCtx, database, destination } = await setUpDatabase();
      const created = await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });
      expect(created.backupId).toEqual(expect.any(String));
      expect(created.postgresId).toBe(database.postgresId);
      expect(created.backupType).toBe('database');

      const found = await backups.findOne(ownerCtx, created.backupId);
      expect(found).toMatchObject({
        backupId: created.backupId,
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'postgres',
      });

      const updated = await backups.update(ownerCtx, created.backupId, {
        prefix: 'weekly',
        keepLatestCount: 3,
        enabled: true,
      });
      expect(updated).toMatchObject({
        backupId: created.backupId,
        prefix: 'weekly',
        keepLatestCount: 3,
        enabled: true,
      });

      await backups.remove(ownerCtx, created.backupId);
      await expect(backups.findOne(ownerCtx, created.backupId)).rejects.toThrow(
        NotFoundException,
      );
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
        createBackup(ownerCtx, {
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: foreignDestination.destinationId,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('list by service', () => {
    it('lists the schedules of one service only', async () => {
      const { ownerCtx, environment, database, destination } =
        await setUpDatabase();
      const other = await postgres.create(ownerCtx, {
        name: 'Reporting DB',
        appName: 'reporting-db',
        databaseName: 'reports',
        databaseUser: 'reports_user',
        databasePassword: 'r3ports',
        environmentId: environment.environmentId,
      });
      const common = {
        database: 'shop',
        databaseType: 'postgres' as const,
        destinationId: destination.destinationId,
      };
      await createBackup(ownerCtx, {
        ...common,
        schedule: '0 3 * * *',
        prefix: 'daily',
        serviceId: database.postgresId,
      });
      await createBackup(ownerCtx, {
        ...common,
        schedule: '0 4 * * 0',
        prefix: 'weekly',
        serviceId: database.postgresId,
      });
      await createBackup(ownerCtx, {
        ...common,
        schedule: '0 5 * * *',
        prefix: 'reporting',
        serviceId: other.postgresId,
      });

      const listed = await backups.listByService(ownerCtx, {
        serviceId: database.postgresId,
        serviceType: 'postgres',
      });

      expect(listed.map((row) => row.prefix).sort()).toEqual([
        'daily',
        'weekly',
      ]);
      expect(
        listed.every((row) => row.postgresId === database.postgresId),
      ).toBe(true);
    });

    it('lists a compose stack’s schedules by its compose id', async () => {
      const { ownerCtx, environment, database, destination } =
        await setUpDatabase();
      const stack = await compose.create(ownerCtx, {
        name: 'Shop Stack',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
      });
      await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'stack-daily',
        database: 'shop',
        databaseType: 'mysql',
        backupType: 'compose',
        serviceId: stack.composeId,
        serviceName: 'db',
        destinationId: destination.destinationId,
      });
      // The engine row's own schedule must not show up under the stack.
      await createBackup(ownerCtx, {
        schedule: '0 4 * * *',
        prefix: 'engine-daily',
        database: 'shop',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      const listed = await backups.listByService(ownerCtx, {
        serviceId: stack.composeId,
        serviceType: 'compose',
      });

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        prefix: 'stack-daily',
        backupType: 'compose',
        composeId: stack.composeId,
        serviceName: 'db',
      });
    });

    it('carries the destination without its secret, and no row credentials', async () => {
      const { ownerCtx, environment, destination } = await setUpDatabase();
      const stack = await compose.create(ownerCtx, {
        name: 'Shop Stack',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
      });
      await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'mysql',
        backupType: 'compose',
        serviceId: stack.composeId,
        serviceName: 'db',
        // A compose backup's row carries the stack engine's credentials.
        metadata: { mysql: { databaseRootPassword: 'r00t-secret' } },
        destinationId: destination.destinationId,
      });

      const listed = await backups.listByService(ownerCtx, {
        serviceId: stack.composeId,
        serviceType: 'compose',
      });

      // The destination is named so the list can say where dumps go…
      expect(listed[0].destination).toMatchObject({
        destinationId: destination.destinationId,
        name: 'prod-backups',
        bucket: 'cloudgate-backups',
        provider: 'Cloudflare',
      });
      // …but neither its secret nor the row's engine credentials travel.
      expect(listed[0].destination).not.toHaveProperty('secretAccessKey');
      expect(listed[0]).not.toHaveProperty('metadata');
      expect(JSON.stringify(listed)).not.toContain('r00t-secret');
      expect(JSON.stringify(listed)).not.toContain(
        'wJalrXUtnFEMI-example-secret-key',
      );
    });
  });

  describe('row-level access', () => {
    it('denies a member without row access to the backed-up service', async () => {
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
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'postgres' as const,
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      };
      await expect(createBackup(memberCtx, input)).rejects.toThrow(
        ForbiddenException,
      );

      const created = await createBackup(ownerCtx, input);
      await expect(
        backups.findOne(memberCtx, created.backupId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        backups.update(memberCtx, created.backupId, { prefix: 'weekly' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        backups.runManual(memberCtx, created.backupId),
      ).rejects.toThrow(ForbiddenException);
      await expect(backups.remove(memberCtx, created.backupId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        backups.restore(memberCtx, {
          databaseId: database.postgresId,
          databaseType: 'postgres',
          backupType: 'database',
          databaseName: 'shop',
          backupFile: 'main-db/daily/x.sql.gz',
          destinationId: destination.destinationId,
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        backups.listByService(memberCtx, {
          serviceId: database.postgresId,
          serviceType: 'postgres',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hides backups and their services from other organizations', async () => {
      const { ownerSession, ownerCtx, database, destination } =
        await setUpDatabase();
      const created = await createBackup(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        databaseType: 'postgres',
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
        backups.findOne(secondOrgCtx, created.backupId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        backups.runManual(secondOrgCtx, created.backupId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        backups.remove(secondOrgCtx, created.backupId),
      ).rejects.toThrow(NotFoundException);
      // The list is scoped through the same join, so another organization's
      // service reads as absent rather than as an empty schedule list.
      await expect(
        backups.listByService(secondOrgCtx, {
          serviceId: database.postgresId,
          serviceType: 'postgres',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('backup files listing', () => {
    it('lists the destination dump files through rclone lsjson', async () => {
      const { ownerCtx, destination } = await setUpDatabase();
      execMock.execAsync.mockResolvedValue({
        stdout: JSON.stringify([
          {
            Path: 'daily/2026-07-23T10-20-30-456Z.sql.gz',
            Name: '2026-07-23T10-20-30-456Z.sql.gz',
            Size: 1024,
            IsDir: false,
          },
        ]),
        stderr: '',
        exitCode: 0,
      });

      const files = await backups.listBackupFiles(ownerCtx, {
        destinationId: destination.destinationId,
        search: 'main-db/',
      });

      const [command, options] = execMock.execAsync.mock.calls[0] as [
        string,
        { env: Record<string, string> },
      ];
      // No `2>/dev/null`: rclone's complaint is the whole answer when a
      // listing fails, and stdout is a separate stream from it. And
      // bounded, with the flags the destination listing next door already
      // carried: rclone's defaults held this request open for 95 s
      // against a stopped MinIO while the bounded one answered in 0.0 s.
      expect(command).toBe(
        'rclone lsjson --retries 1 --low-level-retries 1 --timeout 30s --contimeout 5s ' +
          // `query.search` comes straight off a browse box, so the search path
          // is `quote()`d rather than double-quoted (H-36): `"…"` never stopped
          // a `$(…)`. The safe path here comes out as the same single word.
          '\\:s3\\:cloudgate-backups/main-db/ --no-mimetype --no-modtime',
      );
      expect(options.env.RCLONE_S3_SECRET_ACCESS_KEY).toBe(
        'wJalrXUtnFEMI-example-secret-key',
      );
      // Listed paths come back destination-relative (search prefix restored).
      expect(files).toEqual([
        expect.objectContaining({
          Path: 'main-db/daily/2026-07-23T10-20-30-456Z.sql.gz',
        }),
      ]);
    });

    // A bucket that is unreachable, a destination whose credentials no
    // longer work — all of it used to reach the console as one
    // `500 Internal server error`, with rclone's own words alive only in this
    // instance's journal.
    it('answers a failed listing with rclone\u2019s words, not a 500', async () => {
      const { ownerCtx, destination } = await setUpDatabase();
      execMock.execAsync.mockReset().mockRejectedValue(
        Object.assign(
          new Error('Command execution failed: Command failed: rclone lsjson'),
          {
            stdout: '',
            stderr:
              'ERROR : : error listing: RequestError: send request failed\n' +
              'caused by: Get "https://minio.example:9000/backups": dial tcp: connection refused',
          },
        ),
      );

      const refusal = backups.listBackupFiles(ownerCtx, {
        destinationId: destination.destinationId,
        search: 'main-db/',
      });
      await expect(refusal).rejects.toThrow(BadRequestException);
      const message = await refusal.catch((error: Error) => error.message);
      expect(message).toContain('connection refused');
    });

    /**
     * F-41's pass condition: **the masked marker present in the answer
     * the caller reads**, on a route that can produce one.
     *
     * Every other credential assertion in this file checks an *absence* — no
     * key in the message — and an absence is not evidence the mask ran: it
     * passes just as well on a route that answers nothing, or on one where
     * nothing named a credential in the first place. This asserts the marker
     * itself, over HTTP, so what is checked is the body the console renders.
     *
     * The stream that carries the leak here is **stderr**, not the command.
     * `execRclone` hands rclone its credentials in rclone's own environment, so
     * nothing this route builds names one. `GET /backups/files` is one of the
     * routes that does not redirect its command into a run log, so that stderr
     * survives on the `ExecError`, wins `rcloneFailureMessage`'s precedence
     * over an empty stdout, and becomes the 400.
     *
     * **What puts a credential into that stderr is the URL rclone dialled, not
     * a provider's error body.** This test used to hand rclone an
     * `InvalidAccessKeyId` body with the key in `<AWSAccessKeyId>`, and that is
     * a wire shape rclone cannot produce: its S3 backend keeps `Code` and
     * `Message` and discards the remainder before formatting anything, measured
     * against a stub returning AWS's exact XML that `curl` confirmed was on the
     * wire. No S3 provider can leak a credential that way, so the old fixture
     * was green over a population of zero — F-41's own defect, one layer up.
     *
     * What rclone *does* echo, in every transport failure, is the URL — the
     * own measured transcript is `caused by: Get "http://127.0.0.1:9000/…":
     * dial tcp … connection refused`. `Destination.endpoint` is a free string,
     * and an operator pasting credentials into it is a real mistake rather than
     * a contrivance. Go's `net/http` renders such a URL through
     * `net/http`'s `stripPassword`, which replaces the *password* with `***` and keeps the
     * *username* — so the access key survives into stderr in clear and the
     * secret does not, which is why this fixture masks the key and why an
     * assertion about the secret here would be vacuous.
     *
     * **This fixture is bound to the rclone `deploy/install.sh` installs, and the
     * version is already load-bearing in this module.** The shape above was read
     * off `rclone v1.60.1-DEV` — apt's, `install.sh:144` — whose S3 backend is
     * aws-sdk-go **v1**, and which produces `RequestError: send request failed` /
     * `caused by: Get "https://KEY:***@host/…"` verbatim. rclone later moved that
     * backend to aws-sdk-go v2, which rebuilds the request URL from the resolved
     * endpoint and drops its userinfo: the same invocation on 1.75.0 answers
     * `operation error S3: ListObjectsV2 … Get "https://host/…"` with no key and
     * no `***` in it. So a bump to the installed rclone makes this test green
     * over a population of zero again, which is F-41's defect a third time — and
     * H-120 is the neighbour that proves the version moves, since
     * `--max-duration` is inert on this same 1.60.1.
     *
     * Nothing refuses the request first: `assertCredentialFreeCommand` scans the
     * *command*, and the endpoint travels in the environment, never in argv.
     */
    it('masks the access key the dialled endpoint carries into the 400', async () => {
      const { ownerSession, ownerCtx } = await setUpDatabase();
      const accessKey = 'AKIAEXAMPLEACCESSKEY';
      const secret = 'wJalrXUtnFEMI-example-secret-key';
      // The mistake this test is a transcript of: the credentials pasted into
      // the endpoint field. Its own destination rather than `setUpDatabase`'s,
      // on the precedent already in this file, because the endpoint is the
      // whole fixture.
      const destination = await destinations.create(ownerCtx, {
        name: 'pasted-endpoint',
        provider: 'Cloudflare',
        accessKey,
        secretAccessKey: secret,
        bucket: 'cloudgate-backups',
        region: 'auto',
        endpoint: `https://${accessKey}:${secret}@minio.example.test`,
      });

      // `***` is Go's own rendering: net/http's stripPassword replaces the password
      // and keeps the username, which is why only the key needs masking here.
      const url =
        `https://${accessKey}:***@minio.example.test/cloudgate-backups` +
        '?delimiter=%2F&list-type=2&prefix=main-db%2F';
      const providerBody =
        '2026/07/23 10:20:31 ERROR : : error listing: RequestError: send request failed\n' +
        `caused by: Get "${url}": dial tcp: lookup minio.example.test: no such host\n` +
        '2026/07/23 10:20:31 Failed to lsjson: error in ListJSON: RequestError: ' +
        'send request failed\n' +
        `caused by: Get "${url}": dial tcp: lookup minio.example.test: no such host\n`;

      execMock.execAsync.mockReset().mockRejectedValue(
        new ExecError(
          'Command execution failed: Command failed: rclone lsjson',
          {
            command:
              'rclone lsjson --retries 1 --low-level-retries 1 --timeout 30s ' +
              '--contimeout 5s ":s3:cloudgate-backups/main-db/" --no-mimetype --no-modtime',
            stdout: '',
            stderr: providerBody,
            exitCode: 1,
          },
        ),
      );

      const res = await request(server)
        .get('/backups/files')
        .query({ destinationId: destination.destinationId, search: 'main-db/' })
        .set('Cookie', ownerSession.cookie);

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
      expect(message).not.toContain(accessKey);
      // The diagnosis is the whole reason the body is shown, so it survives the
      // mask intact — this is not a route that answers a redacted blank.
      expect(message).toContain('dial tcp');
      expect(message).toContain('no such host');
    });

    /**
     * At the altitude that matters: the cap is on the path an operator's
     * browser actually receives, not only on the pure function.
     *
     * The input is real — a stalling-but-alive endpoint narrates one `ERROR :`
     * line per low-level retry for as long as it keeps the connection alive, and
     * 18 minutes of that was measured on one restore. Nothing between rclone's
     * stderr and this 400 bounded it.
     */
    it('bounds the 400 a hundred-kilobyte retry narration would otherwise be', async () => {
      const { ownerSession, destination } = await setUpDatabase();
      execMock.execAsync.mockReset().mockRejectedValue(
        new ExecError(
          'Command execution failed: Command failed: rclone lsjson',
          {
            command: 'rclone lsjson ":s3:cloudgate-backups/main-db/"',
            stdout: '',
            stderr:
              '2026/07/23 10:20:31 ERROR : : error listing: RequestError: send request failed\n'.repeat(
                1300,
              ) +
              'Failed to lsjson: error in ListJSON: dial tcp 127.0.0.1:9000: connect: connection refused',
            exitCode: 1,
          },
        ),
      );

      const res = await request(server)
        .get('/backups/files')
        .query({ destinationId: destination.destinationId, search: 'main-db/' })
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(400);
      const { message } = res.body as { message: string };
      expect(message.length).toBeLessThanOrEqual(8 * 1024);
      // …and the reason still arrives, which is the half a cap must not cost.
      expect(message).toContain('connection refused');
    });
  });

  describe('HTTP surface', () => {
    it('creates, reads, runs, updates and deletes a backup through the controller', async () => {
      const { ownerSession, database, destination } = await setUpDatabase();

      const invalid = await request(server)
        .post('/backups')
        .set('Cookie', ownerSession.cookie)
        .send({ schedule: '0 3 * * *' });
      expect(invalid.status).toBe(400);

      const created = await request(server)
        .post('/backups')
        .set('Cookie', ownerSession.cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        });
      expect(created.status).toBe(201);
      const { backupId } = created.body as { backupId: string };

      const found = await request(server)
        .get(`/backups/${backupId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ prefix: 'daily', database: 'shop' });

      const ran = await request(server)
        .post(`/backups/${backupId}/run`)
        .set('Cookie', ownerSession.cookie);
      expect(ran.status).toBe(204);

      const updated = await request(server)
        .patch(`/backups/${backupId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ prefix: 'weekly' });
      expect(updated.status).toBe(200);
      expect((updated.body as { prefix: string }).prefix).toBe('weekly');

      const removed = await request(server)
        .delete(`/backups/${backupId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/backups/${backupId}`)
        .set('Cookie', ownerSession.cookie);
      expect(gone.status).toBe(404);
    });

    it('lists a database’s schedules, so its ids are reachable', async () => {
      const { ownerSession, database, destination } = await setUpDatabase();

      const empty = await request(server)
        .get('/backups')
        .query({ serviceId: database.postgresId, serviceType: 'postgres' })
        .set('Cookie', ownerSession.cookie);
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual([]);

      const created = await request(server)
        .post('/backups')
        .set('Cookie', ownerSession.cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        });
      expect(created.status).toBe(201);
      const { backupId } = created.body as { backupId: string };

      const listed = await request(server)
        .get('/backups')
        .query({ serviceId: database.postgresId, serviceType: 'postgres' })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      const [row] = listed.body as {
        backupId: string;
        destination: { name: string; secretAccessKey?: string };
      }[];
      // The id the other four routes need now comes out of a list.
      expect(row.backupId).toBe(backupId);
      expect(row.destination.name).toBe('prod-backups');
      expect(row.destination.secretAccessKey).toBeUndefined();

      // The schedule list sits beside the dump-file list without shadowing it.
      execMock.execAsync.mockResolvedValue({
        stdout: '[]',
        stderr: '',
        exitCode: 0,
      });
      const files = await request(server)
        .get('/backups/files')
        .query({ destinationId: destination.destinationId, search: '' })
        .set('Cookie', ownerSession.cookie);
      expect(files.status).toBe(200);
      expect(files.body).toEqual([]);
    });

    it('rejects a serviceType with no backup FK column', async () => {
      const { ownerSession, database } = await setUpDatabase();

      const noServiceType = await request(server)
        .get('/backups')
        .query({ serviceId: database.postgresId })
        .set('Cookie', ownerSession.cookie);
      expect(noServiceType.status).toBe(400);

      // Redis has no dump command and applications are not backed up, so
      // neither has a backup FK — both are outside the query's vocabulary.
      for (const serviceType of ['redis', 'application']) {
        const rejected = await request(server)
          .get('/backups')
          .query({ serviceId: database.postgresId, serviceType })
          .set('Cookie', ownerSession.cookie);
        expect(rejected.status).toBe(400);
      }
    });

    it('reads as absent from a session in another organization', async () => {
      const { ownerSession, database } = await setUpDatabase();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      await request(server)
        .post(`/organizations/${secondOrgId}/set-default`)
        .set('Cookie', ownerSession.cookie);

      // A fresh session starts in the second organization.
      const signIn = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email: owner.email, password: owner.password });
      const secondOrgCookie = signIn.headers['set-cookie'];

      const listed = await request(server)
        .get('/backups')
        .query({ serviceId: database.postgresId, serviceType: 'postgres' })
        .set('Cookie', secondOrgCookie);
      expect(listed.status).toBe(404);
    });
  });
});
