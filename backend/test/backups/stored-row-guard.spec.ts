import { BadRequestException } from '@nestjs/common';
import type { Backup } from '../../src/backups/backup.schema';
import { BackupsService } from '../../src/backups/backups.service';
import type { BackupRunRecorderService } from '../../src/backups/run-recorder.service';
import type { Destination } from '../../src/db/schema';
import type { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SELF_HOSTED } from '../utils/instance-mode-double';

/**
 * H-21's shape one module over. A database backup is a cron job:
 * `runScheduled` reads the row and `buildRunScript` builds a shell script from
 * it with **no request in the call at all**, so a row written before a rule
 * existed can never reach a DTO again — there is no write left to validate.
 * `volume-backups/` has had that guard since H-21; this module had nothing
 * equivalent, so `prefix` kept whatever it held before the fix and `serviceName`
 * whatever it held before the fix, on every scheduled run, forever.
 *
 * Asserted through `run` rather than through the private guard, on
 * `volume-backups/stored-row-guard.spec.ts`' precedent: the claim worth pinning
 * is not "it throws" but *where the throw lands*. A scheduled run has nobody
 * watching a response, so the refusal has to be recorded and notified — the run
 * history and the notification channels are the only places an operator finds
 * out that a backup stopped running and why.
 *
 * The quoting half of the defence is `backup-shell-safety.spec.ts`', which runs
 * the emitted commands against stub binaries. It is the half that has to hold
 * for the values this guard cannot refuse — `metadata`'s credentials, which
 * carry no charset because a password's characters are the ones a charset would
 * refuse. `prefix` and `database` took theirs in a follow-up, and because
 * this guard is *derived* from `createBackupSchema` it began refusing stored
 * rows outside them the moment the DTO did; the two `it`s that name them below
 * are that half.
 */
describe('BackupsService, running a stored row', () => {
  const row = (overrides: Partial<Backup> = {}): Backup =>
    ({
      backupId: 'bk-1',
      appName: 'backup-abc123',
      schedule: '0 3 * * *',
      enabled: true,
      database: 'shop',
      prefix: 'daily',
      serviceName: null,
      destinationId: 'dst-1',
      keepLatestCount: null,
      backupType: 'database',
      databaseType: 'postgres',
      postgresId: 'pg-1',
      composeId: null,
      metadata: null,
      ...overrides,
    }) as unknown as Backup;

  /** A compose row: the shape that stores `serviceName` and `metadata`, which
   * a database row never does. */
  const composeRow = (overrides: Partial<Backup> = {}): Backup =>
    row({
      backupType: 'compose',
      postgresId: null,
      composeId: 'cmp-1',
      serviceName: 'db',
      metadata: { postgres: { databaseUser: 'shop' } },
      ...overrides,
    });

  const parent = {
    serviceId: 'pg-1',
    name: 'checkout-db',
    appName: 'main-db',
    serverId: null,
    projectName: 'storefront',
    organizationId: 'org-1',
    composeType: null,
    cloudAccountId: null,
    databaseUser: 'shop',
    databasePassword: 'hunter2',
  };

  const destination = { bucket: 'cloudgate-backups' } as Destination;

  /** `run` with the three collaborators the refusal path reaches, and nothing
   * else built: anything further would fail loudly rather than pass quietly. */
  const runWith = async (stored: Backup) => {
    const finished: Array<'done' | 'error'> = [];
    const notified: Array<{ status: string; errorMessage?: string }> = [];
    const executed: string[] = [];

    const runRecorder = {
      start: () =>
        Promise.resolve({ deploymentId: 'dep-1', logPath: '/tmp/dep-1.log' }),
      finish: (_id: string, status: 'done' | 'error') => {
        finished.push(status);
        return Promise.resolve();
      },
    } as unknown as BackupRunRecorderService;

    const dispatcher = {
      dispatch: (
        _organizationId: string,
        event: { status: string; errorMessage?: string },
      ) => {
        notified.push({
          status: event.status,
          errorMessage: event.errorMessage,
        });
        return Promise.resolve();
      },
    } as unknown as NotificationDispatcherService;

    const remoteExec = {
      execAsync: (command: string) => {
        executed.push(command);
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    } as unknown as RemoteExecService;

    const service = new BackupsService(
      null as never,
      null as never,
      remoteExec,
      null as never,
      runRecorder,
      null as never,
      dispatcher,
      null as never,
      SELF_HOSTED,
    );

    // 'scheduled' because that is the case with nobody watching a response,
    // which is the whole reason the guard reports through the run history.
    const error = await service['run'](
      stored,
      parent,
      destination,
      'scheduled',
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    return { error, finished, notified, executed };
  };

  it('runs a row whose stored values are clean', async () => {
    const { error, finished, notified, executed } = await runWith(row());

    expect(error).toBeNull();
    expect(finished).toEqual(['done']);
    expect(notified).toEqual([{ status: 'success', errorMessage: undefined }]);
    // It got past the guard and built the pipeline the run host executes,
    // which is what the refusals below prove a poisoned row does not.
    expect(executed.join('\n')).toContain('rclone rcat');
  });

  it('refuses the run of a row whose prefix climbs out of its own bucket path', async () => {
    // The case exactly: `bucketKeySegments` arrived with the authorization fix on `create`
    // and `update`, so a row written before it keeps a traversing prefix and
    // the schedule goes on writing this Service's dumps — and pointing
    // `pruneOldBackups`' `rclone delete` — under a sibling's prefix.
    const { error, finished, notified } = await runWith(
      row({ prefix: '../checkout-api/daily' }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('Backup bk-1');
    expect((error as Error).message).toContain('prefix');
    // A scheduled run has nobody watching the response, so the refusal has to
    // land where an operator looks at backups — the run history, and the
    // notification, which carries the reason rather than only the failure.
    expect(finished).toEqual(['error']);
    expect(notified).toHaveLength(1);
    expect(notified[0].status).toBe('error');
    expect(notified[0].errorMessage).toContain('prefix');
  });

  it('refuses the run of a row whose database is empty', async () => {
    const { error, finished } = await runWith(row({ database: '' }));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('database');
    expect(finished).toEqual(['error']);
  });

  it('refuses the run of a row whose prefix is outside an S3 key’s charset', async () => {
    // The charset half, which had no owner until a follow-up: the authorization fix gave
    // `prefix` the `.`/`..` segment rule and nothing else, so a row could sit
    // on a prefix carrying a space or a `;` and be re-emitted every night. The
    // guard is derived from `createBackupSchema`, so the rule arrived here the
    // moment it arrived at the route.
    const { error, finished, notified } = await runWith(
      row({ prefix: 'daily backups;rm -rf /' }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('prefix');
    expect((error as Error).message).not.toContain('rm -rf');
    expect(finished).toEqual(['error']);
    expect(notified[0].errorMessage).toContain('prefix');
  });

  it('still runs a row whose prefix is slashed and padded the way stored ones are', async () => {
    // The half of the charset that had to be got right before it could be
    // added at all. `normalizeS3Path` `.trim()`s and strips the outer slashes
    // on every read of this column, and the DTO that wrote the row never did
    // either — so this row and a row storing `daily` write the same key and
    // always have. The rule is on the path the value denotes, which is why
    // this run proceeds instead of being refused every night from now on.
    const { error, finished, executed } = await runWith(
      row({ prefix: ' /daily/ ' }),
    );

    expect(error).toBeNull();
    expect(finished).toEqual(['done']);
    expect(executed.join('\n')).toContain('main-db/daily/');
  });

  it('refuses the run of a row whose database the dump tool would read as an option', async () => {
    // The reading `quote()` cannot take away: `quote(['--file=…'])` is the same
    // word back, and `pg_dump … --no-password <db>` puts it where the tool
    // parses options. A stored row is the only way this value gets there
    // without a request, which is what makes it this guard's business.
    const { error, finished } = await runWith(
      row({ database: '--file=/tmp/pwned' }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('database');
    expect((error as Error).message).not.toContain('/tmp/pwned');
    expect(finished).toEqual(['error']);
  });

  it('refuses the run of a row whose serviceName cannot be given to a shell', async () => {
    // An earlier fix gave `serviceName` Compose's own charset at the DTO; this is the
    // stored-row half of that fix, which had no home in this module. The value
    // is the object key's leading segment and a `docker ps --filter label=…`
    // word.
    const { error, finished, notified } = await runWith(
      composeRow({ serviceName: 'api$(id)' }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('Backup bk-1');
    expect((error as Error).message).toContain('serviceName');
    // The stored payload is never echoed back: the message is journalled,
    // notified and rendered in the console, and repeating an injection into
    // all three puts it somewhere new for no gain (§2.5).
    expect((error as Error).message).not.toContain('$(id)');
    expect(finished).toEqual(['error']);
    expect(notified[0].status).toBe('error');
  });

  it('refuses the run of a row whose stored metadata is not the shape the dump reads', async () => {
    // `metadata` is jsonb, typed in TypeScript and unchecked at the boundary,
    // and `credentialsFor` hands its strings straight to the engine's dump
    // command. A value that is not a string renders as itself into that word.
    const { error, finished } = await runWith(
      composeRow({
        metadata: { postgres: { databaseUser: 42 } } as never,
      }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('metadata');
    expect(finished).toEqual(['error']);
  });

  it('refuses the run of a row whose stored engine user is empty, and still runs one whose password is', async () => {
    // The stored half of `composeDatabaseUserSchema`'s `min(1)`, stated here
    // because being derived means the DTO's rule lands on old rows too. The
    // refusal is bounded: `-U ''` is not a dump any server accepts, so the run
    // this stops was already failing — with the engine's message rather than
    // the field's. The password beside it is the asymmetry: `''` is a real
    // configuration there, and refusing it would stop a working backup.
    const emptyUser = await runWith(
      composeRow({ metadata: { postgres: { databaseUser: '' } } }),
    );

    expect(emptyUser.error).toBeInstanceOf(BadRequestException);
    expect((emptyUser.error as Error).message).toContain('metadata');
    expect(emptyUser.finished).toEqual(['error']);

    const emptyPassword = await runWith(
      composeRow({
        databaseType: 'mongo',
        metadata: {
          mongo: { databaseUser: 'root', databasePassword: '' },
        },
      }),
    );

    expect(emptyPassword.error).toBeNull();
    expect(emptyPassword.finished).toEqual(['done']);
  });

  it('runs a compose row whose serviceName is one a stack declares', async () => {
    const { error, finished } = await runWith(
      composeRow({ serviceName: 'db.primary' }),
    );

    expect(error).toBeNull();
    expect(finished).toEqual(['done']);
  });

  it('runs a row that records no stack service and no metadata either way', async () => {
    // Both columns are nullable, and `s3AppName` and `buildRunScript` read any
    // falsy `serviceName` as "no stack service" — so `null` and `''` are absent
    // rather than poisoned, and a guard that refused either would stop every
    // database backup on the instance, which is the H-21 failure mode inverted.
    for (const serviceName of [null, '']) {
      const { error, finished } = await runWith(
        row({ serviceName, metadata: null }),
      );

      expect(error).toBeNull();
      expect(finished).toEqual(['done']);
    }
  });

  it('builds no script and reaches no host for a refused row', async () => {
    const { executed } = await runWith(composeRow({ serviceName: 'api$(id)' }));

    expect(executed).toEqual([]);
  });
});
