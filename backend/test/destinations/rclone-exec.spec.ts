import { quote } from 'shell-quote';
import {
  buildBackupScript,
  buildPruneCommand,
  buildRestoreScript,
  BACKUP_COMMANDS,
  getServiceContainerCommand,
} from '../../src/backups/commands';
import {
  boundedRcloneFlags,
  bulkDownloadCommand,
  bulkDownloadRcloneFlags,
  execRclone,
  reachabilityProbeCommand,
  rcloneFailureMessage,
} from '../../src/destinations/rclone-exec';
import { RCLONE_INVOCATION_ENV } from '../../src/destinations/s3-credentials';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { BadRequestException, Logger } from '@nestjs/common';
import { ExecError } from '../../src/remote/exec-error';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  buildVolumeBackupScript,
  buildVolumeRestoreScript,
} from '../../src/volume-backups/volume-backup-commands';
import type { Destination } from '../../src/db/schema';
import { PLATFORM_HOST_REFUSED_CODE } from '../../src/instance-mode/platform-host-refusal';
import { instanceModeDouble, SELF_HOSTED } from '../utils/instance-mode-double';

// Every route that moved data built the destination's secret access key
// into an rclone command line, so the host's process table held it while the
// command ran and the exception filter wrote it to the journal when the command
// failed. `execRclone` is the one door they all go through now. These are the
// route-by-route proofs: the command carries no credential, the environment
// carries all of them on both sides of the SSH boundary, and the failure a
// person or a journal reads carries none.

// The `serverId: 'server-1'` literals throughout this file name no `server`
// row, and that is correct here — a sweep looked for fixtures that cannot prove an
// organization check ran, and this file has none to prove. `execRclone`
// (`src/destinations/rclone-exec.ts`) takes `serverId` as a *routing* input: it
// picks `execAsyncRemote` over `execAsync` and names the host to the remote
// call. It receives no `PermissionCtx` and calls no `checkServerAccess` — the
// organization check lives in the service above it, and is proved against real
// rows in a second Organization in `destinations.e2e-spec.ts`. The remaining
// two sites are `ExecError` payloads handed to `rcloneFailureMessage`, a pure
// string function. This is a `*.spec.ts` with no Postgres besides, so seeding a
// Server here is not possible and would assert nothing.

const SECRET = 'wJalrXUtnFEMI-example-secret-key';
const ACCESS_KEY = 'AKIAEXAMPLEACCESSKEY';

const destination: Destination = {
  destinationId: 'dest-1',
  name: 'prod-backups',
  provider: 'Cloudflare',
  accessKey: ACCESS_KEY,
  secretAccessKey: SECRET,
  bucket: 'cloudgate-backups',
  region: 'auto',
  endpoint: 'https://accountid.r2.cloudflarestorage.com',
  createdAt: '2026-07-23T00:00:00.000Z',
  organizationId: 'org-1',
};

/** Every spelling of a credential a command line could carry. */
const CREDENTIAL_SPELLINGS = [
  SECRET,
  ACCESS_KEY,
  '--s3-secret-access-key',
  '--s3-access-key-id',
  'RCLONE_S3_SECRET_ACCESS_KEY',
  'RCLONE_S3_ACCESS_KEY_ID',
];

const expectNoCredential = (text: string): void => {
  for (const spelling of CREDENTIAL_SPELLINGS) {
    expect(text).not.toContain(spelling);
  }
};

const BUCKET_PATH = `:s3:${destination.bucket}`;
const LOG_PATH = '/etc/cloudgate/logs/main-db/run-1.log';
const VOLUME_STAGING = '/etc/cloudgate/volume-backups/main-app';

/**
 * The command or script each rclone-backed route actually runs.
 *
 * Six come from the real builders, so a change to a script reaches this table on
 * its own. The other three — the backup-file listing and the two destination
 * probes — are assembled inline in their services, so their shape is transcribed
 * by hand and only their flags come from the real `boundedRcloneFlags`. The
 * transcription has been wrong twice: the listing carried a `2>/dev/null` that
 * a later fix removed, and then the bounding flags added after it. Calling the real flag
 * builder is what stops the third time, and it is callable here because it was
 * moved it to `rclone-exec.ts`; the rest stays transcribed rather than exported
 * only to be observed, since what this table feeds is a redaction check whose
 * property holds for any command shape.
 */
const ROUTE_COMMANDS: [route: string, command: string][] = [
  [
    'database backup run',
    buildBackupScript({
      containerSearch: getServiceContainerCommand('main-db'),
      dumpCommand: BACKUP_COMMANDS.postgres.dump({
        database: 'shop',
        databaseUser: 'shop_user',
      }).command,
      rcloneCommand: `rclone rcat ${quote([`${BUCKET_PATH}/main-db/daily/2026-08-19.sql.gz`])}`,
      logPath: LOG_PATH,
      uploadTarget: `${BUCKET_PATH}/main-db/daily/2026-08-19.sql.gz`,
    }),
  ],
  [
    'database backup prune',
    buildPruneCommand({
      backupFilesPath: `${BUCKET_PATH}/main-db/daily/`,
      include: '*.{sql.gz,bson.gz}',
      keepLatestCount: 3,
    }),
  ],
  [
    'database restore',
    buildRestoreScript({
      containerSearch: getServiceContainerCommand('main-db'),
      restoreCommand: BACKUP_COMMANDS.postgres.restore({
        database: 'shop',
        databaseUser: 'shop_user',
      }).command,
      rcloneCommand: `rclone cat "${BUCKET_PATH}/main-db/daily/2026-08-19.sql.gz" | gunzip`,
      reachabilityProbe: reachabilityProbeCommand(
        `${BUCKET_PATH}/main-db/daily/2026-08-19.sql.gz`,
      ),
      databaseType: 'postgres',
    }),
  ],
  [
    'backup-file listing',
    `rclone lsjson ${boundedRcloneFlags({ idle: '30s' })} "${BUCKET_PATH}/main-db/" --no-mimetype --no-modtime`,
  ],
  [
    'volume backup run',
    `(${buildVolumeBackupScript({
      serverId: null,
      volumeName: 'shop-data',
      backupFileName: 'shop-data-2026-08-19.tar',
      volumeBackupPath: VOLUME_STAGING,
      rcloneDestination: `${BUCKET_PATH}/main-app/daily/shop-data-2026-08-19.tar`,
      turnOff: true,
      target: { serviceType: 'application', appName: 'main-app' },
      // A scheduled run's mode — the case that still blocks on a held volume
      // lock. Irrelevant to what this table asserts, which is that no
      // command carries a credential whatever else it says.
      lockMode: 'wait',
    })}) >> ${LOG_PATH} 2>&1`,
  ],
  [
    'volume backup prune',
    buildPruneCommand({
      backupFilesPath: `${BUCKET_PATH}/main-app/daily/`,
      include: 'shop-data-*.tar',
      keepLatestCount: 3,
    }),
  ],
  [
    'volume restore',
    buildVolumeRestoreScript({
      serverId: null,
      volumeName: 'shop-data',
      backupFileName: 'main-app/daily/shop-data-2026-08-19.tar',
      bucket: destination.bucket,
      target: { serviceType: 'application', appName: 'main-app' },
    }),
  ],
  [
    'destination probe',
    `rclone ls ${boundedRcloneFlags({ idle: '10s' })} "${BUCKET_PATH}"`,
  ],
  [
    'destination object listing',
    `rclone lsjson ${boundedRcloneFlags({ idle: '30s' })} --recursive --no-mimetype "${BUCKET_PATH}/main-app"`,
  ],
];

/**
 * A failed rclone invocation as it comes back from `RemoteExecService`, with the
 * credentials in every place something could have echoed them: the message the
 * exception filter logs, the stack and the diagnostic fields pino's error
 * serializer writes beside it.
 */
const failureCarryingCredentials = (command: string): ExecError =>
  new ExecError(
    `Command execution failed: Command failed: ${command}\n` +
      `Failed to ls with 2 errors: SignatureDoesNotMatch (key ${ACCESS_KEY})`,
    {
      command,
      stdout: '',
      stderr: `RCLONE_S3_SECRET_ACCESS_KEY=${SECRET} rclone: config echo\n${SECRET}`,
      exitCode: 1,
      // `cmd` alongside the message is Node's own shape: `child_process.exec`
      // hangs the failed line off the error under that name, so the raw error
      // nested here carries the command twice and pino writes both fields.
      originalError: Object.assign(
        new Error(`Command failed: ${command} # ${SECRET}`),
        { cmd: `${command} # ${SECRET}` },
      ),
    },
  );

const fakeRemoteExec = () => {
  const execAsync = jest.fn();
  const execAsyncRemote = jest.fn();
  return {
    execAsync,
    execAsyncRemote,
    service: { execAsync, execAsyncRemote } as unknown as RemoteExecService,
  };
};

const OK = { stdout: '[]', stderr: '', exitCode: 0 };

// rclone's defaults are built for an unattended transfer, so a destination
// whose endpoint is simply not there kept a synchronous request open for
// minutes. Reopened, because the four flags that fixed *that* each bound an
// attempt and none of them bounds the request: an endpoint that dribbles rather
// than refuses is never idle on any single connection, and one restore ran for
// 18 min 03 s with the volume lock held throughout.
describe('boundedRcloneFlags', () => {
  it('emits the listing profile from the idle bound alone', () => {
    // The defaults *are* the listing's, and this is the string the probe and
    // the object listing have been shipping — pinned byte for byte, because a
    // change to it is a change to two call sites that were measured working.
    expect(boundedRcloneFlags({ idle: '30s' })).toBe(
      '--retries 1 --low-level-retries 1 --timeout 30s --contimeout 5s',
    );
    expect(boundedRcloneFlags({ idle: '10s' })).toBe(
      '--retries 1 --low-level-retries 1 --timeout 10s --contimeout 5s',
    );
  });

  it('leaves the wall-clock bound off a caller that does not state one', () => {
    // Not defaulted, and that is the assertion: a listing an idle bound already
    // terminates does not need one, and adding a flag to its string would
    // change what two proven call sites emit.
    expect(boundedRcloneFlags({ idle: '30s' })).not.toContain('--max-duration');
    expect(
      boundedRcloneFlags({
        idle: '60s',
        contimeout: '10s',
        retries: 2,
        lowLevelRetries: 3,
      }),
    ).not.toContain('--max-duration');
  });

  it('adds the wall-clock bound last when a bulk download states one', () => {
    // Last, after the four it does not replace: `--max-duration` is the only
    // one of the five that applies to the transfer as a whole rather than to an
    // attempt, so it is the only one that makes the request finite.
    expect(
      boundedRcloneFlags({
        idle: '60s',
        contimeout: '10s',
        retries: 1,
        lowLevelRetries: 10,
        maxDuration: '30m',
      }),
    ).toBe(
      '--retries 1 --low-level-retries 10 --timeout 60s --contimeout 10s ' +
        '--max-duration 30m',
    );
  });

  // The two counters are not two sizes of the same thing, and reading them that
  // way is what G-39 measured: `--retries` restarts the object at byte zero and
  // discards the partial download, `--low-level-retries` resumes at the offset
  // already on disk. Paired against the same stalling endpoint, the shipped
  // `2 × 3` gave up after 1083 s with 0 B where `1 × 10` finished in 181 s with
  // every byte — so a bulk download spends the top-level retry and keeps
  // rclone's own low-level ten.
  it('spends the restarting retry and keeps the resuming one on a bulk download', () => {
    // The shipped constant, spelled out rather than rebuilt from the same
    // builder it is made with (§1.7) — these are the five values that were
    // measured, and the volume restore and the mongo download both run them.
    expect(bulkDownloadRcloneFlags).toBe(
      '--retries 1 --low-level-retries 10 --timeout 60s --contimeout 10s ' +
        '--max-duration 30m',
    );
    // Named because it is what was there before and what a later reader would
    // "even up", not because a number nobody chose is worth an assertion.
    expect(bulkDownloadRcloneFlags).not.toContain('--retries 2');
    expect(bulkDownloadRcloneFlags).not.toContain('--low-level-retries 3');
  });
});

/**
 * H-120. `--max-duration` is **accepted and inert** on the rclone this product
 * installs, so the reopened retry fix fixed the retry knobs — which it measured, and
 * which are not in question — and then assigned the request bound to a flag
 * that does nothing.
 *
 * Three measurements on the box, ending with the one that removes all doubt:
 * `--max-duration 1ms` against a *healthy* endpoint transferred all
 * 157 286 400 bytes, rc=0, in 1 s. `rclone v1.60.1-DEV`
 * (`apt 1.60.1+dfsg-3ubuntu0.24.04.6`), whose own `--cutoff-mode` help reads
 * "Mode to stop transfers when reaching the **max transfer** limit" — on that
 * version the cutoff governs `--max-transfer`, not `--max-duration`, which it
 * reaches at rclone ≥ 1.64. Not an environment quirk: `deploy/install.sh`
 * installs rclone from apt, and apt's rclone on the platform `docs/deploy.md`
 * documents *is* 1.60.1.
 *
 * So the bound is the process, which no rclone version can ignore — and it is
 * one function rather than a `timeout` word at each call site, for the same
 * §1.4 reason `bulkDownloadRcloneFlags` itself exists: the next measurement has
 * to move both consumers or it is a measurement of whichever was forgotten.
 */
describe('bulkDownloadCommand', () => {
  it('probes the host for `timeout` and wraps the download in it', () => {
    // Spelled out rather than rebuilt from the same pieces the code uses
    // (§1.7): this is the shell that was reasoned about, and a fallback that
    // silently stopped emitting the wrapper would satisfy any expectation
    // computed the way the source computes it.
    expect(bulkDownloadCommand({ verb: 'copyto', args: 'SRC DEST' })).toBe(
      "if command -v timeout >/dev/null 2>&1; then RCLONE_WALL_CLOCK='timeout 1800'; else RCLONE_WALL_CLOCK=''; fi\n" +
        '$RCLONE_WALL_CLOCK rclone copyto --retries 1 --low-level-retries 10 ' +
        '--timeout 60s --contimeout 10s --max-duration 30m SRC DEST',
    );
  });

  it('probes rather than assuming, because these scripts also run over SSH', () => {
    const command = bulkDownloadCommand({ verb: 'copyto', args: 'SRC DEST' });

    // The same care, taken over `timeout` instead of `wc`: a host without it
    // downloads unwrapped rather than failing at a missing binary.
    expect(command).toContain('command -v timeout >/dev/null 2>&1');
    expect(command).toContain("else RCLONE_WALL_CLOCK=''");
    // Seconds and not `30m`, because busybox's `timeout` takes no suffix — and
    // a host with busybox coreutils is the host the probe exists for.
    expect(command).toContain("RCLONE_WALL_CLOCK='timeout 1800'");
    expect(command).not.toContain('timeout 30m');
  });

  it('keeps the flag as the belt for a host whose rclone is new enough', () => {
    // Removing it would be the third change to this line in one issue, and it
    // is free: on rclone ≥ 1.64 it is a second bound, and on 1.60.1 it is what
    // the finding says it is — nothing.
    expect(bulkDownloadCommand({ verb: 'copy', args: 'SRC' })).toContain(
      '--max-duration 30m',
    );
  });

  it('ends on the command itself, so a caller can append its own words', () => {
    // `buildRestoreScript` appends the mongo restore's temp directory to this,
    // and the volume restore appends `|| DOWNLOAD_STATUS=$?`. Both depend on
    // the guard being *above* the invocation rather than around it.
    const lines = bulkDownloadCommand({ verb: 'copy', args: 'SRC' }).split(
      '\n',
    );

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '$RCLONE_WALL_CLOCK rclone copy --retries 1 --low-level-retries 10 ' +
        '--timeout 60s --contimeout 10s --max-duration 30m SRC',
    );
  });

  it('indents the guard to the script it is being spliced into', () => {
    expect(
      bulkDownloadCommand({ verb: 'copyto', args: 'SRC DEST', indent: '\t\t' }),
    ).toContain('fi\n\t\t$RCLONE_WALL_CLOCK rclone copyto');
  });

  it('is what the volume restore actually downloads with', () => {
    // The consumer that was measured. The mongo restore is the other, and the
    // pin that they cannot drift is this function being the only place either
    // of them names `timeout` or the flags (§1.4).
    const script = buildVolumeRestoreScript({
      serverId: null,
      volumeName: 'shop-data',
      backupFileName: 'main-app/daily/shop-data.tar',
      bucket: 'cloudgate-backups',
      target: { serviceType: 'application', appName: 'main-app' },
    });

    // `serverId: null` is the platform host, so the tarball stages under this
    // process's CLOUDGATE_DIRECTORY — asked of the machine, not spelled as a
    // Server's `/etc/cloudgate`.
    const staged = `${cloudgateDirectoryOn(null)}/volume-backups/shop-data/main-app/daily/shop-data.tar`;

    expect(script).toContain(
      bulkDownloadCommand({
        verb: 'copyto',
        args: `${quote([`${BUCKET_PATH}/main-app/daily/shop-data.tar`])} ${quote([staged])}`,
        indent: '\t',
      }),
    );
  });
});

// What the bulk downloads' retry budget cannot also be — the
// counter that lets a degraded link assemble is the counter that governs a
// connect that never completes, so the same flags that took a stalling endpoint
// from 1083 s-and-nothing to 181 s-and-every-byte take an absent one from 242 s
// to 641 s. This is the other half, and it is a listing rather than a fourth
// invented profile.
describe('reachabilityProbeCommand', () => {
  it('asks the listing profile, which is the measured sibling and not a new number', () => {
    // Spelled out rather than built with `boundedRcloneFlags`: an expectation
    // that recomputes the flags the way the code does would hold whatever the
    // profile became, and this string is the thing that was measured at 40 s
    // against a dead socket and 0 s through a stalling one (§1.7).
    expect(
      reachabilityProbeCommand(`${BUCKET_PATH}/main-app/daily/x.tar`),
    ).toBe(
      'rclone lsjson --retries 1 --low-level-retries 1 --timeout 30s ' +
        // `quote()`d since H-38, which for a `:`-bearing word is backslashes
        // rather than double quotes — `sh` strips both to the same argument.
        `--contimeout 5s ${quote([`${BUCKET_PATH}/main-app/daily/x.tar`])}`,
    );
  });

  it('carries no wall clock and no bulk retry budget, because it is what fails fast', () => {
    const probe = reachabilityProbeCommand(`${BUCKET_PATH}/main-app/x.tar`);

    expect(probe).toContain('--retries 1 --low-level-retries 1');
    // A cap on a call that already refuses in tens of seconds would only change
    // the string two proven call sites emit.
    expect(probe).not.toContain('--max-duration');
  });
});

describe('execRclone', () => {
  /**
   * The backstop of ADR-0053: whatever a caller forgot to refuse first — a
   * Service in a Cloud account has `serverId: null` too — the Hosted
   * instance's own host runs no customer's rclone, so no customer endpoint
   * is dialled from it with the customer's keys.
   */
  describe('on the Hosted instance', () => {
    it('refuses the platform host before anything runs', async () => {
      const { execAsync, service } = fakeRemoteExec();

      const error: unknown = await execRclone(service, 'rclone ls :s3:b', {
        destination,
        serverId: null,
        platformHost: instanceModeDouble(true),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(
        ((error as BadRequestException).getResponse() as { code?: unknown })
          .code,
      ).toBe(PLATFORM_HOST_REFUSED_CODE);
      expect(execAsync).not.toHaveBeenCalled();
    });

    it('still runs on a Server', async () => {
      const { execAsyncRemote, service } = fakeRemoteExec();
      execAsyncRemote.mockResolvedValue(OK);

      await execRclone(service, 'rclone ls :s3:b', {
        destination,
        serverId: 'server-1',
        platformHost: instanceModeDouble(true),
      });

      expect(execAsyncRemote).toHaveBeenCalled();
    });
  });

  describe.each(ROUTE_COMMANDS)('%s', (_route, command) => {
    it('runs a command that names no credential in any form', () => {
      expectNoCredential(command);
    });

    it('hands the credentials to rclone through the environment on this host', async () => {
      const { execAsync, service } = fakeRemoteExec();
      execAsync.mockResolvedValue(OK);

      await execRclone(service, command, {
        destination,
        serverId: null,
        platformHost: SELF_HOSTED,
      });

      const [sentCommand, options] = execAsync.mock.calls[0] as [
        string,
        { env: Record<string, string> },
      ];
      expectNoCredential(sentCommand);
      expect(options.env.RCLONE_S3_SECRET_ACCESS_KEY).toBe(SECRET);
      expect(options.env.RCLONE_S3_ACCESS_KEY_ID).toBe(ACCESS_KEY);
      // The child still inherits the rest of this process's environment, or
      // rclone loses PATH and HOME.
      expect(options.env.PATH).toBe(process.env.PATH);
      // …and that inheritance is exactly how `JOURNAL_STREAM` reached rclone
      // and made it frame every line for the journal. Blanked here
      // rather than left to the strip, because the strip cannot reach the run
      // log and the run log was polluted too.
      expect(options.env).toMatchObject(RCLONE_INVOCATION_ENV);
    });

    it('hands the credentials to rclone through the environment on a Server', async () => {
      const { execAsyncRemote, service } = fakeRemoteExec();
      execAsyncRemote.mockResolvedValue(OK);

      await execRclone(service, command, {
        destination,
        serverId: 'server-1',
        platformHost: SELF_HOSTED,
      });

      const [serverId, sentCommand, onData, options] = execAsyncRemote.mock
        .calls[0] as [
        string,
        string,
        undefined,
        { env: Record<string, string> },
      ];
      expect(serverId).toBe('server-1');
      expect(onData).toBeUndefined();
      expectNoCredential(sentCommand);
      expect(options.env.RCLONE_S3_SECRET_ACCESS_KEY).toBe(SECRET);
      expect(options.env.RCLONE_S3_ACCESS_KEY_ID).toBe(ACCESS_KEY);
      // Nothing of this process's environment goes over the wire — only what
      // the remote command was given.
      expect(Object.keys(options.env)).not.toContain('PATH');
      // Both sides, because the remote path turns these into `export` lines and
      // a fix that only worked locally would be invisible here otherwise.
      expect(options.env).toMatchObject(RCLONE_INVOCATION_ENV);
    });

    it('answers a failure with a message carrying no credential', async () => {
      const { execAsync, service } = fakeRemoteExec();
      execAsync.mockRejectedValue(failureCarryingCredentials(command));

      const error: ExecError = await execRclone(service, command, {
        destination,
        serverId: null,
        platformHost: SELF_HOSTED,
      }).then(
        () => {
          throw new Error('expected execRclone to reject');
        },
        (e: ExecError) => e,
      );

      for (const written of [
        error.message,
        error.stack ?? '',
        error.command,
        error.stderr ?? '',
        error.originalError?.message ?? '',
        // Node's own name for the failed line, on the nested raw error. pino
        // writes every own property, so a field missed here is a field the
        // journal still holds in clear.
        (error.originalError as { cmd?: string } | undefined)?.cmd ?? '',
      ]) {
        expect(written).not.toContain(SECRET);
        expect(written).not.toContain(ACCESS_KEY);
      }
      // The diagnosis is why the failure is shown at all, so it survives.
      expect(error.message).toContain('SignatureDoesNotMatch');
    });

    it('returns the result when the destination works', async () => {
      const { execAsync, service } = fakeRemoteExec();
      execAsync.mockResolvedValue({ ...OK, stdout: 'done' });

      await expect(
        execRclone(service, command, {
          destination,
          serverId: null,
          platformHost: SELF_HOSTED,
        }),
      ).resolves.toEqual({ ...OK, stdout: 'done' });
    });
  });

  it('names the shell a script needs on both sides of the SSH boundary', async () => {
    // The database backup script opens with `set -eo pipefail`, which dash does
    // not have; without this the remote side would silently lose pipefail.
    const local = fakeRemoteExec();
    local.execAsync.mockResolvedValue(OK);
    await execRclone(local.service, 'rclone rcat :s3:b/o', {
      destination,
      serverId: null,
      platformHost: SELF_HOSTED,
      shell: '/bin/bash',
    });
    const [, localOptions] = local.execAsync.mock.calls[0] as [
      string,
      { shell?: string },
    ];
    expect(localOptions).toMatchObject({ shell: '/bin/bash' });

    const remote = fakeRemoteExec();
    remote.execAsyncRemote.mockResolvedValue(OK);
    await execRclone(remote.service, 'rclone rcat :s3:b/o', {
      destination,
      serverId: 'server-1',
      platformHost: SELF_HOSTED,
      shell: '/bin/bash',
    });
    const [, , , remoteOptions] = remote.execAsyncRemote.mock.calls[0] as [
      string,
      string,
      undefined,
      { shell?: string },
    ];
    expect(remoteOptions).toMatchObject({ shell: '/bin/bash' });
  });

  it('leaves a rejection that is not an object alone', async () => {
    const { execAsync, service } = fakeRemoteExec();
    execAsync.mockRejectedValue('rclone: not found');

    await expect(
      execRclone(service, 'rclone ls :s3:b', {
        destination,
        serverId: null,
        platformHost: SELF_HOSTED,
      }),
    ).rejects.toBe('rclone: not found');
  });

  /**
   * The local branch spawns with `{ ...process.env, ...env }`, so every
   * `RCLONE_*` variable in the *backend's own* environment — a systemd unit's
   * `Environment=`, a Docker `-e`, a `.env` an operator edited — reaches every
   * rclone this product runs unless the map overrides it by name.
   *
   * These are the assertions that matter rather than "the key is in the map":
   * that a spelling in `process.env` does **not** survive the merge. Measured
   * against rclone v1.75.0 with a request-logging endpoint, this is what the
   * variable does when it does survive — the same `..` segment, twice:
   *
   * ```
   * default                       PUT /b/storefront/daily/%EF%BC%8E%EF%BC%8E/ledger/x.tar
   * RCLONE_S3_ENCODING=Slash,InvalidUtf8   PUT /b/storefront/daily/../ledger/x.tar
   * ```
   *
   * `%EF%BC%8E` is U+FF0E, a fullwidth full stop, and the first line is the
   * fact two earlier fixes rest on.
   */
  describe('an rclone variable the operator put in the backend’s environment', () => {
    const OPERATOR_ENCODING = 'Slash,InvalidUtf8';
    let before: string | undefined;

    beforeEach(() => {
      before = process.env.RCLONE_S3_ENCODING;
      process.env.RCLONE_S3_ENCODING = OPERATOR_ENCODING;
    });

    afterEach(() => {
      if (before === undefined) delete process.env.RCLONE_S3_ENCODING;
      else process.env.RCLONE_S3_ENCODING = before;
    });

    it('does not survive into the spawn on this host', async () => {
      const { execAsync, service } = fakeRemoteExec();
      execAsync.mockResolvedValue(OK);

      await execRclone(service, 'rclone lsf :s3:b/storefront/', {
        destination,
        serverId: null,
        platformHost: SELF_HOSTED,
      });

      const [, options] = execAsync.mock.calls[0] as [
        string,
        { env: Record<string, string> },
      ];
      // The value rclone's own `--s3-encoding` help line documents as the
      // default for every provider, read off `rclone help flags` rather than
      // off the source under test.
      expect(options.env.RCLONE_S3_ENCODING).toBe('Slash,InvalidUtf8,Dot');
      // …while the inheritance the merge exists for is untouched.
      expect(options.env.PATH).toBe(process.env.PATH);
    });

    it('is overridden on a Server too, where nothing of this process travels', async () => {
      const { execAsyncRemote, service } = fakeRemoteExec();
      execAsyncRemote.mockResolvedValue(OK);

      await execRclone(service, 'rclone lsf :s3:b/storefront/', {
        destination,
        serverId: 'server-1',
        platformHost: SELF_HOSTED,
      });

      const [, , , options] = execAsyncRemote.mock.calls[0] as [
        string,
        string,
        undefined,
        { env: Record<string, string> },
      ];
      // `buildEnvScript` turns this into an `export` line on `sh -s`'s stdin,
      // so the Server's own environment is overridden by the same map — a
      // pinning that only worked locally would leave every Server-scoped
      // backup, prune, restore and listing on whatever the Server inherited.
      expect(options.env.RCLONE_S3_ENCODING).toBe('Slash,InvalidUtf8,Dot');
    });
  });

  // Moving credentials into the environment left no path that puts a credential
  // in a command *this tree builds*, so the only thing between a future call site
  // and a leak was that nobody interpolates one today. These are that "nobody"
  // made structural.
  //
  // They are not the only place the mask is exercised, and the note that once
  // said so was wrong: `stderr` is in `REDACTED_ERROR_FIELDS` and a provider
  // echoes the key back into it, which two route-level tests now drive.
  describe('a command that carries a credential', () => {
    /**
     * The refusal *names* the spelling it refused — that is how a caller finds
     * the call site — so only the values are forbidden here, not the flag names
     * `expectNoCredential` also rules out of a command line.
     */
    const expectNoCredentialValue = (text: string): void => {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ACCESS_KEY);
    };

    const refusalFrom = async (
      command: string,
      against: Destination = destination,
    ): Promise<ExecError> => {
      const { execAsync, execAsyncRemote, service } = fakeRemoteExec();
      const error: ExecError = await execRclone(service, command, {
        destination: against,
        serverId: null,
        platformHost: SELF_HOSTED,
      }).then(
        () => {
          throw new Error('expected execRclone to refuse');
        },
        (e: ExecError) => e,
      );
      // Nothing was executed on the way to being refused — neither locally nor
      // over SSH, so the secret never reached a process table either.
      expect(execAsync).not.toHaveBeenCalled();
      expect(execAsyncRemote).not.toHaveBeenCalled();
      return error;
    };

    it('is refused when it names the secret access key as an rclone flag', async () => {
      const error = await refusalFrom(
        `rclone rcat --s3-secret-access-key=${SECRET} ":s3:b/o"`,
      );
      expect(error.message).toContain('--s3-secret-access-key');
      expect(error.message).toContain('Credentials travel in the environment');
      expectNoCredentialValue(error.message);
    });

    it('is refused when it names a credential as an inline environment assignment', async () => {
      const error = await refusalFrom(
        `RCLONE_S3_ACCESS_KEY_ID=${ACCESS_KEY} rclone ls ":s3:b"`,
      );
      expect(error.message).toContain('RCLONE_S3_ACCESS_KEY_ID=');
      expectNoCredentialValue(error.message);
    });

    it('is refused when it carries a credential value nothing in it names', async () => {
      const error = await refusalFrom(
        `rclone cat ":s3:b/dump-${SECRET}.sql.gz"`,
      );
      expect(error.message).toContain('secret access key');
      expectNoCredentialValue(error.message);
    });

    it('is refused with the offending command masked, which is the mask’s one reachable path', async () => {
      const command = `rclone rcat --s3-secret-access-key="${SECRET}" ":s3:b/o"`;
      const error = await refusalFrom(command);

      // F-41's pass condition: the marker is present in the failure's own
      // fields, so the exception filter journals a mask rather than a secret.
      expect(error.command).toContain('••••••');
      for (const written of [error.message, error.stack ?? '', error.command]) {
        expectNoCredentialValue(written);
      }
    });

    /**
     * The refusal is the one `ExecError` in this file that
     * is built by hand rather than by `RemoteExecService`, and it was the only
     * one in the tree with no `serverId` at all — so a refused backup said
     * which call site was wrong and could not say which host the run was for.
     * Every other `ExecError` on this path carries it (`execAsyncRemote`
     * passes it on all four of its constructions), and `null` is the platform
     * host rather than "unknown" (ADR-0008), which is why the local branch is
     * asserted as `null` and not merely as "not a Server's id".
     */
    it('names the Server the refused run was for', async () => {
      const { execAsync, execAsyncRemote, service } = fakeRemoteExec();
      const error: ExecError = await execRclone(
        service,
        `rclone cat ":s3:b/dump-${SECRET}.sql.gz"`,
        { destination, serverId: 'server-1', platformHost: SELF_HOSTED },
      ).then(
        () => {
          throw new Error('expected execRclone to refuse');
        },
        (e: ExecError) => e,
      );

      expect(execAsync).not.toHaveBeenCalled();
      expect(execAsyncRemote).not.toHaveBeenCalled();
      expect(error.serverId).toBe('server-1');
      // The masking contract is untouched by the new field: a refusal that
      // started naming its Server must not start echoing a credential.
      expectNoCredentialValue(error.command);
      expectNoCredentialValue(error.message);
    });

    it('names the platform host as `null` rather than leaving the Server unsaid', async () => {
      const error = await refusalFrom(
        `rclone cat ":s3:b/dump-${SECRET}.sql.gz"`,
      );
      expect(error.serverId).toBeNull();
    });

    /**
     * The never-carry half of the guard: the caller's own environment-borne secret.
     *
     * The database password's never-carry property is what this makes
     * structural. Nothing in a backups suite matches on a value the dump
     * command is not supposed to contain, so an engine builder that put
     * `--password=<the value>` back would ship green — and the leak is into the
     * journal, where nobody is looking until they are.
     */
    describe('a secret the caller said travels in the environment', () => {
      const DB_PASSWORD = 'r00t-4f9c1ea7b2d08356';

      const refusalFromEnv = async (command: string): Promise<ExecError> => {
        const { execAsync, execAsyncRemote, service } = fakeRemoteExec();
        const error: ExecError = await execRclone(service, command, {
          destination,
          serverId: null,
          platformHost: SELF_HOSTED,
          env: { CLOUDGATE_DB_PASSWORD: DB_PASSWORD },
        }).then(
          () => {
            throw new Error('expected execRclone to refuse');
          },
          (e: ExecError) => e,
        );
        expect(execAsync).not.toHaveBeenCalled();
        expect(execAsyncRemote).not.toHaveBeenCalled();
        return error;
      };

      it('is refused when the command carries it as well', async () => {
        const error = await refusalFromEnv(
          `docker exec -i $CONTAINER_ID sh -c 'mysqldump --password=${DB_PASSWORD} shop'`,
        );

        // The variable, so the caller knows which of its own values leaked —
        // and never the value.
        expect(error.message).toContain('$CLOUDGATE_DB_PASSWORD');
        expect(error.message).not.toContain(DB_PASSWORD);
      });

      it('is refused with the offending command masked, since no other mask knows this value', async () => {
        // `redactS3CredentialsInError` searches for the *destination's* two
        // values, so without `maskEnvValues` this refusal would be the one
        // ExecError in the tree that journals a database password — the exact
        // leak, reintroduced by the guard against it.
        const error = await refusalFromEnv(
          `docker exec -i $CONTAINER_ID sh -c 'mysql -u root -p${DB_PASSWORD} shop'`,
        );

        expect(error.command).toContain('[credential elided]');
        for (const written of [
          error.message,
          error.stack ?? '',
          error.command,
        ]) {
          expect(written).not.toContain(DB_PASSWORD);
        }
      });

      it('runs the command the engines actually build, which names the variable', async () => {
        const { execAsync, service } = fakeRemoteExec();
        execAsync.mockResolvedValue(OK);

        await execRclone(
          service,
          `docker exec -e CLOUDGATE_DB_PASSWORD -i $CONTAINER_ID sh -c 'mysql -u root -p"$CLOUDGATE_DB_PASSWORD" shop'`,
          {
            destination,
            serverId: null,
            platformHost: SELF_HOSTED,
            env: { CLOUDGATE_DB_PASSWORD: DB_PASSWORD },
          },
        );

        expect(execAsync).toHaveBeenCalledTimes(1);
        const [, options] = execAsync.mock.calls[0] as [
          string,
          { env: Record<string, string> },
        ];
        // Carried to the child, and still under the S3 credentials.
        expect(options.env.CLOUDGATE_DB_PASSWORD).toBe(DB_PASSWORD);
        expect(options.env.RCLONE_S3_SECRET_ACCESS_KEY).toBe(SECRET);
      });

      it('is not refused for a password below the guard’s floor', async () => {
        // The short-value band, applied to this branch by the same code path: refusing
        // costs the operator their backup, and a short password equal to a
        // database name is the same coincidence a bucket name was.
        const { execAsync, service } = fakeRemoteExec();
        execAsync.mockResolvedValue(OK);

        await execRclone(
          service,
          `docker exec -i $CONTAINER_ID sh -c 'mysqldump shop'`,
          {
            destination,
            serverId: null,
            platformHost: SELF_HOSTED,
            env: { CLOUDGATE_DB_PASSWORD: 'shop' },
          },
        );

        expect(execAsync).toHaveBeenCalledTimes(1);
      });
    });

    it('is not refused for a credential too short to be one', async () => {
      // Below the mask's own floor, so there is nothing here for either the
      // mask or the guard: a region of `auto` is not a secret, and refusing
      // every command that says `auto` would take out the listing routes.
      const { execAsync, service } = fakeRemoteExec();
      execAsync.mockResolvedValue(OK);

      await execRclone(service, 'rclone ls --s3-region auto ":s3:b"', {
        destination: { ...destination, accessKey: 'auto' },
        serverId: null,
        platformHost: SELF_HOSTED,
      });

      expect(execAsync).toHaveBeenCalledTimes(1);
    });

    // The value branch was gated on `MIN_MASKED_CREDENTIAL_LENGTH`, so it
    // was armed for every real destination — and for the short keys a
    // self-hosted deployment uses, where a bucket named after the deployment
    // contains the key by accident and every backup, prune, restore and listing
    // was refused.
    describe('a short credential a bucket or key contains by accident', () => {
      const warned = () => jest.spyOn(Logger.prototype, 'warn');

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('runs a command whose bucket contains a short access key, rather than refusing the backup', async () => {
        // MinIO's default key is ten characters and an operator names the
        // bucket after the deployment; `command.includes('minioadmin')` is then
        // true of a perfectly good listing. A refusal here costs the backup.
        warned().mockImplementation(() => undefined);
        const { execAsync, service } = fakeRemoteExec();
        execAsync.mockResolvedValue(OK);

        await execRclone(
          service,
          'rclone lsjson ":s3:minioadmin-backups/main-db/"',
          {
            destination: { ...destination, accessKey: 'minioadmin' },
            serverId: null,
            platformHost: SELF_HOSTED,
          },
        );

        expect(execAsync).toHaveBeenCalled();
      });

      it('runs a command whose key prefix contains a short secret', async () => {
        warned().mockImplementation(() => undefined);
        const { execAsync, service } = fakeRemoteExec();
        execAsync.mockResolvedValue(OK);

        await execRclone(service, 'rclone lsjson ":s3:b/minio123/"', {
          destination: { ...destination, secretAccessKey: 'minio123' },
          serverId: null,
          platformHost: SELF_HOSTED,
        });

        expect(execAsync).toHaveBeenCalled();
      });

      it('says so on the way past, naming the spelling and never the value', async () => {
        // The band does not go silent: this line is the only signal left in it,
        // and it is what a future call site that interpolates a short
        // credential is caught by.
        const warn = warned().mockImplementation(() => undefined);
        const { execAsync, service } = fakeRemoteExec();
        execAsync.mockResolvedValue(OK);

        await execRclone(
          service,
          'rclone lsjson ":s3:minioadmin-backups/main-db/"',
          {
            destination: { ...destination, accessKey: 'minioadmin' },
            serverId: null,
            platformHost: SELF_HOSTED,
          },
        );

        expect(warn).toHaveBeenCalledTimes(1);
        const [line] = warn.mock.calls[0] as [string];
        expect(line).toContain('access key id');
        expect(line).toContain('move it into the environment');
        expect(line).not.toContain('minioadmin');
        expect(line).not.toContain(SECRET);
      });

      it('says nothing at all when no credential is in the command', async () => {
        // The cost of the band is one line per invocation *for such a
        // destination*, not for every one — the nine call sites carry no
        // credential and must stay silent.
        const warn = warned().mockImplementation(() => undefined);
        const { execAsync, service } = fakeRemoteExec();
        execAsync.mockResolvedValue(OK);

        await execRclone(service, 'rclone lsjson ":s3:b/main-db/"', {
          destination,
          serverId: null,
          platformHost: SELF_HOSTED,
        });

        expect(warn).not.toHaveBeenCalled();
      });

      it('still refuses at twenty characters, and not at nineteen', async () => {
        // The constant pinned from both sides, so nobody later moves it up or
        // down without one of these going red. Twenty is an AWS access key id
        // exactly, which is why it is the floor rather than something above it.
        warned().mockImplementation(() => undefined);
        const nineteen = 'A'.repeat(19);
        const twenty = 'A'.repeat(20);

        const below = fakeRemoteExec();
        below.execAsync.mockResolvedValue(OK);
        await execRclone(below.service, `rclone ls ":s3:${nineteen}-backups"`, {
          destination: { ...destination, accessKey: nineteen },
          serverId: null,
          platformHost: SELF_HOSTED,
        });
        expect(below.execAsync).toHaveBeenCalledTimes(1);

        const error = await refusalFrom(`rclone ls ":s3:${twenty}-backups"`, {
          ...destination,
          accessKey: twenty,
        });
        expect(error.message).toContain('access key id');
        expect(error.message).not.toContain(twenty);
      });
    });
  });
});

// The scripts these routes execute are written to be read — the volume
// restore's in-use refusal lists every container holding the volume and prints
// three numbered steps for freeing it — and all of it used to end as a bare
// `500 Internal server error` with the text alive only in the journal.
//
// And stdout-first was too coarse to keep that win. A script's stdout is a
// transcript, so it is never empty by the time anything fails, and the three
// failures F-44 drove answered with narration ("Downloading backup from S3...",
// "Creating new volume and restoring data...") or with rclone's first byte of
// JSON (`[`) while the reason sat unread on stderr.
describe('rcloneFailureMessage', () => {
  it('answers with the script’s refusal, never its 4.6 KB source', () => {
    const refusal =
      '⚠️  WARNING: Cannot restore volume as it is currently in use!';
    const error = new ExecError(
      // child_process spells a failure `Command failed: <the whole script>`,
      // so the message is the script and the diagnosis is one field over.
      'Command execution failed: Command failed: set -e\necho "Volume name: shop-data"…',
      { command: 'the script', stdout: refusal, stderr: '' },
    );
    expect(rcloneFailureMessage(error, 'Failed to restore the volume')).toBe(
      refusal,
    );
  });

  it('answers with the whole refusal block and none of the transcript above it', () => {
    // The volume-in-use branch as it really comes back: the run's narration,
    // then the marked refusal, the containers holding the volume, and the steps.
    const stdout = [
      '=== VOLUME RESTORE FOR APPLICATION ===',
      'Application: main-app',
      'Volume exists: 1',
      'Volume exists, checking for containers using it (including stopped ones)...',
      '',
      '⚠️  WARNING: Cannot restore volume as it is currently in use!',
      '',
      "📋 The following containers are using volume 'shop-data':",
      '   🐳 Container: main-app.1 (abc123)',
      '      Status: running',
      '🔧 To restore this volume, please:',
      '   1. Stop the application',
      '   2. Run the restore operation again',
      '❌ Volume restore aborted - volume is in use',
    ].join('\n');
    const answer = rcloneFailureMessage(
      new ExecError('Remote command failed with exit code 1', {
        command: 'the script',
        stdout,
        stderr: 'docker: no such object: shop-data\n',
      }),
      'Failed to restore the volume',
    );

    expect(answer).toContain('Cannot restore volume as it is currently in use');
    expect(answer).toContain('main-app.1 (abc123)');
    expect(answer).toContain('2. Run the restore operation again');
    // Nothing above the mark survived: what the script got through is not what
    // the caller asked, and stderr's aside did not win over the refusal.
    expect(answer).not.toContain('Volume exists: 1');
    expect(answer).not.toContain('no such object');
    expect(answer.startsWith('⚠️')).toBe(true);
  });

  it('answers with an engine’s own unmarked error line, which no marker precedes', () => {
    // The database restore is `rclone cat … | psql`, not a narrated script: it
    // prints no `❌` because it prints nothing at all except the engine's own
    // complaint. Reading stdout for this tree's markers alone dropped this and
    // answered with the script source — `test/backups` pins the route's half.
    expect(
      rcloneFailureMessage(
        new ExecError(
          'Command execution failed: Command failed: <4.6 KB of script source>',
          {
            command: 'the script',
            stdout:
              'pg_restore: error: could not open input file: No such file',
            stderr: '',
          },
        ),
        'Failed to restore the backup',
      ),
    ).toBe('pg_restore: error: could not open input file: No such file');
  });

  it('does not read a failure into a half-written listing because a key is named for one', () => {
    // A failure word counts at the start of a line or after a space. rclone's
    // own JSON quotes its keys, so a bucket holding `error-log.txt` does not
    // make a truncated listing look like a diagnosis — stderr still wins.
    expect(
      rcloneFailureMessage(
        new ExecError('Remote command failed with exit code 1', {
          command: 'rclone lsjson ":s3:b"',
          stdout:
            '[\n{"Path":"error-log.txt","Name":"error-log.txt","Size":12}',
          stderr: 'Failed to lsjson: error in ListJSON: connection refused\n',
        }),
        'Failed to list the backup files',
      ),
    ).toBe('Failed to lsjson: error in ListJSON: connection refused');
  });

  it('answers a narrating script with rclone’s own reason on stderr', () => {
    // F-44's first useless answer: the restore reached its download, MinIO was
    // not there, and stdout ended mid-narration while stderr held the reason.
    expect(
      rcloneFailureMessage(
        new ExecError('Remote command failed with exit code 1', {
          command: 'the script',
          stdout:
            'Volume name: shop-data\n' +
            'Backup file name: main-app/daily/shop-data.tar\n' +
            'Downloading backup from S3...\n',
          stderr:
            'ERROR : Attempt 1/1 failed: RequestError: send request failed\n' +
            'caused by: dial tcp 127.0.0.1:9000: connect: connection refused\n',
        }),
        'Failed to restore the volume',
      ),
    ).toContain('connection refused');
  });

  it('answers a failed listing with rclone’s complaint, never its first byte of JSON', () => {
    // F-44 on `GET /backups/files`: `[` was the whole 400, because rclone had
    // opened its array before the request failed.
    const answer = rcloneFailureMessage(
      new ExecError('Remote command failed with exit code 1', {
        command: 'rclone lsjson ":s3:cloudgate-backups/main-db/"',
        stdout: '[',
        stderr: 'Failed to lsjson: error in ListJSON: connection refused\n',
      }),
      'Failed to list the backup files',
    );
    expect(answer).toBe(
      'Failed to lsjson: error in ListJSON: connection refused',
    );
    expect(answer).not.toBe('[');
  });

  it('never answers with an SSH exit code while stderr holds the reason', () => {
    // The shape `execAsyncRemote` builds, and the one F-44's measurement hid:
    // nothing folds stderr into the message over SSH, so a probe or a listing
    // run on a Server has its whole diagnosis in a field stdout-first never
    // reached and `error.message` never had.
    expect(
      rcloneFailureMessage(
        new ExecError('Remote command failed with exit code 1', {
          command: 'rclone ls --retries 1 ":s3:cloudgate-backups"',
          stdout: '',
          stderr: 'Failed to ls: SignatureDoesNotMatch: status code: 403\n',
          exitCode: 1,
          serverId: 'server-1',
        }),
        'Error connecting to bucket',
      ),
    ).toBe('Failed to ls: SignatureDoesNotMatch: status code: 403');
  });

  it('answers with the message when a bounded rclone failed before printing', () => {
    // `GET /destinations/:id/objects` is the route F-44 found already answering
    // well: `boundedRcloneFlags` makes rclone give up before it prints, so both
    // streams are empty and child_process's message carries rclone's own text.
    expect(
      rcloneFailureMessage(
        new ExecError(
          'Command execution failed: Command failed: rclone lsjson --retries 1 …\n' +
            'Failed to lsjson: error in ListJSON: connect: connection refused',
          { command: 'rclone lsjson --retries 1 …', stdout: '', stderr: '' },
        ),
        'Error listing the bucket',
      ),
    ).toContain('connection refused');
  });

  it('falls back to stderr, then the message, then the caller’s sentence', () => {
    expect(
      rcloneFailureMessage(
        new ExecError('Command execution failed', {
          command: 'rclone lsjson :s3:b',
          stdout: '   \n',
          stderr: 'ERROR : : error listing: connection refused',
        }),
        'Failed to list the bucket',
      ),
    ).toBe('ERROR : : error listing: connection refused');

    // Nothing ran at all — an SSH failure — and here the message is both short
    // and the only thing there is to say.
    expect(
      rcloneFailureMessage(
        new ExecError('SSH connection error: getaddrinfo ENOTFOUND vps', {
          command: 'the script',
          serverId: 'server-1',
        }),
        'Failed to restore the volume',
      ),
    ).toBe('SSH connection error: getaddrinfo ENOTFOUND vps');

    expect(rcloneFailureMessage({}, 'Failed to restore the volume')).toBe(
      'Failed to restore the volume',
    );
    expect(rcloneFailureMessage(undefined, 'Failed to list the bucket')).toBe(
      'Failed to list the bucket',
    );
  });

  // The backend is a systemd unit, so every rclone it spawned inherited
  // `JOURNAL_STREAM` and framed its output for the journal — the first line of
  // every failing route's 400 was `<5>NOTICE: Config file … not found`, which
  // diagnoses nothing and, once the length cap lands, is the part guaranteed to
  // survive truncation.
  describe('rclone framing its output for the journal', () => {
    it('answers without the syslog priority prefixes or the config notice in front', () => {
      const answer = rcloneFailureMessage(
        new ExecError('Remote command failed with exit code 1', {
          command: 'rclone lsjson ":s3:cloudgate-backups/main-db/"',
          stdout: '',
          stderr:
            '<5>NOTICE: Config file "/root/.config/rclone/rclone.conf" not found - using defaults\n' +
            '<3>ERROR : : error listing: RequestError: send request failed\n',
        }),
        'Failed to list the backup files',
      );

      expect(answer.startsWith('NOTICE:')).toBe(true);
      expect(answer).not.toContain('<5>');
      expect(answer).not.toContain('<3>');
      // The diagnosis is why the message is shown at all, so it survives the
      // strip intact.
      expect(answer).toContain('error listing: RequestError');
    });

    it('strips a prefix only at a line’s start', () => {
      // The assertion that stops the regex being widened later: `<` carries no
      // meaning except in a line's first column followed by one syslog digit.
      const answer = rcloneFailureMessage(
        new ExecError('Remote command failed with exit code 1', {
          command: 'rclone lsjson ":s3:b"',
          stdout: '',
          stderr:
            'ERROR : size mismatch: a < b\n' +
            '<AWSAccessKeyId>W05ACCESSKEYID0AAAAA</AWSAccessKeyId>\n' +
            '<8>not a syslog priority\n',
        }),
        'Failed to list the bucket',
      );

      expect(answer).toContain('a < b');
      expect(answer).toContain('<AWSAccessKeyId>');
      expect(answer).toContain('<8>not a syslog priority');
    });

    it('strips them from a script’s own refusal too, not only from stderr', () => {
      // The strip is not scoped to the stream rclone happens to write on: a
      // script whose narration reached a journal-framed channel would carry the
      // same prefixes into the branch that wins for the restore.
      const answer = rcloneFailureMessage(
        new ExecError('Remote command failed with exit code 1', {
          command: 'the script',
          stdout:
            '<6>Volume exists: 1\n' +
            '<4>⚠️  WARNING: Cannot restore volume as it is currently in use!\n' +
            '<3>❌ Volume restore aborted - volume is in use\n',
          stderr: '',
        }),
        'Failed to restore the volume',
      );

      expect(answer).not.toContain('<4>');
      expect(answer).not.toContain('<3>');
      expect(answer.startsWith('⚠️')).toBe(true);
      expect(answer).toContain('Volume restore aborted - volume is in use');
    });
  });

  // An 8 KB cap and it was skipped, not descoped. Two of
  // the three candidates are unbounded — rclone's stderr on a retrying transfer,
  // and `child_process`'s `Command failed: <the whole script>` — and the
  // exception filter renders whichever wins into a body a person reads.
  describe('the size of the answer', () => {
    const CAP = 8 * 1024;

    it('returns a message of exactly the cap byte-identical', () => {
      // The boundary, pinned so nobody later tidies the comparison into `<`.
      const stderr = 'e'.repeat(CAP);
      expect(
        rcloneFailureMessage(
          new ExecError('Remote command failed with exit code 1', {
            command: 'rclone lsjson ":s3:b"',
            stdout: '',
            stderr,
          }),
          'Failed to list the bucket',
        ),
      ).toBe(stderr);
    });

    it('keeps both ends of a retrying transfer’s stderr, and says what it dropped', () => {
      const answer = rcloneFailureMessage(
        new ExecError('Remote command failed with exit code 1', {
          command: 'rclone lsjson ":s3:b"',
          stdout: '',
          stderr:
            '2026/07/23 10:20:31 ERROR : : error listing: RequestError: send request failed\n'.repeat(
              1200,
            ) +
            'Failed to lsjson: error in ListJSON: RequestError: send request failed',
        }),
        'Failed to list the backup files',
      );

      expect(answer.length).toBeLessThanOrEqual(CAP);
      // The tail, which is where rclone puts the reason — retry 1 first, the
      // fatal summary last.
      expect(answer).toContain('Failed to lsjson');
      // The head, which a tail-only slice would have thrown away.
      expect(answer).toContain('2026/07/23 10:20:31 ERROR :');
      // And the elision is stated rather than silent, so nobody reads the
      // answer as the whole of what rclone said.
      expect(answer).toContain('characters elided');
    });

    it('keeps the header of a refusal block whose steps run past the cap', () => {
      // This is the assertion that pins the decision. The ticket asked for "the last
      // 8 KB", and a stdout refusal is a block whose *header* is the diagnosis:
      // a tail-only cap answers with the numbered steps under no heading, which
      // is the old listing bug arriving by another door.
      const answer = rcloneFailureMessage(
        new ExecError('Remote command failed with exit code 1', {
          command: 'the script',
          stdout:
            '⚠️  WARNING: Cannot restore volume\n' +
            '   🐳 Container: c-x\n'.repeat(400) +
            '🔧 To restore this volume, please:\n' +
            '   1. Stop the application\n' +
            '   2. Run the restore operation again\n' +
            '❌ Volume restore aborted - volume is in use',
        }),
        'Failed to restore the volume',
      );

      expect(answer.length).toBeLessThanOrEqual(CAP);
      expect(answer).toContain('⚠️  WARNING: Cannot restore volume');
      expect(answer).toContain('Run the restore operation again');
    });

    it('caps what is left after the syslog prefixes go, not before', () => {
      // The order the two changes have to land in: a prefix per line is bytes,
      // and bytes spent on `<3>` are bytes the preserved head does not spend on
      // the diagnosis. With the strip running second, the head would be three
      // characters shorter per line and the answer would exceed the cap.
      const answer = rcloneFailureMessage(
        new ExecError('Remote command failed with exit code 1', {
          command: 'rclone lsjson ":s3:b"',
          stdout: '',
          stderr:
            '<3>ERROR : : error listing: RequestError: send request failed\n'.repeat(
              1200,
            ) + '<3>Failed to lsjson: error in ListJSON: connection refused',
        }),
        'Failed to list the backup files',
      );

      expect(answer.length).toBeLessThanOrEqual(CAP);
      expect(answer).not.toContain('<3>');
      expect(answer).toContain('Failed to lsjson');
    });

    it('leaves the caller’s own fallback sentence alone', () => {
      // Every fallback in this tree is a short literal a call site supplied, not
      // something a tool wrote, so there is nothing there to bound.
      expect(rcloneFailureMessage({}, 'Failed to restore the volume')).toBe(
        'Failed to restore the volume',
      );
    });

    describe('a cut that lands inside a character', () => {
      // A high surrogate with no low one after it, or a low one with no high one
      // before it: the two shapes that make a string not well-formed Unicode.
      // `JSON.parse` in a browser turns each into U+FFFD and a log pipeline that
      // re-encodes the body cannot round-trip it.
      const LONE_SURROGATE =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

      it('does not split an astral character a boundary lands inside', () => {
        // The live shape: an S3 provider's `<Message>` is a tool's words and can
        // be anything, so every unit of it can be half of a surrogate pair. 🐳 is
        // U+1F433, two UTF-16 units, and `String.prototype.slice` is indexed in
        // units — with this length both the head's end and the tail's start fall
        // between the two halves of one whale.
        const answer = rcloneFailureMessage(
          new ExecError('Remote command failed with exit code 1', {
            command: 'rclone lsjson ":s3:b"',
            stdout: '',
            stderr: '🐳'.repeat(12_000),
          }),
          'Failed to list the bucket',
        );

        expect(answer.length).toBeLessThanOrEqual(CAP);
        expect(answer).toContain('characters elided');
        expect(answer).not.toMatch(LONE_SURROGATE);
        // Which is to say: whole whales on both sides of the marker, and nothing
        // between a whale and the marker.
        expect(answer.split('\n… ')[0]).toMatch(/^🐳+$/u);
        expect(answer.split(' …\n').at(-1)).toMatch(/^🐳+$/u);
      });

      it('does not split the 🐳 the volume in-use refusal writes per container', () => {
        // The product-authored candidate the cap exists for: this block is the
        // one that grows without bound, and it writes an astral emoji per
        // container. 668 containers with a nine-character name is the shape whose
        // boundary lands mid-pair — the offset depends on the name's length, so
        // "no lone surrogate for c-x" is luck rather than a property.
        const answer = rcloneFailureMessage(
          new ExecError('Remote command failed with exit code 1', {
            command: 'the script',
            stdout:
              '⚠️  WARNING: Cannot restore volume\n' +
              '   🐳 Container: cg-abc123\n'.repeat(668) +
              '🔧 To restore this volume, please:\n' +
              '   1. Stop the application\n' +
              '   2. Run the restore operation again\n' +
              '❌ Volume restore aborted - volume is in use',
          }),
          'Failed to restore the volume',
        );

        expect(answer.length).toBeLessThanOrEqual(CAP);
        expect(answer).not.toMatch(LONE_SURROGATE);
        expect(answer).toContain('⚠️  WARNING: Cannot restore volume');
        expect(answer).toContain('Run the restore operation again');
      });

      it('control: a BMP-only message of the same length keeps both ends whole', () => {
        // The defect is the boundary, not the cap. `⚠️` and `❌` are one unit
        // each, so the same cap over the same length cuts nothing in half and
        // produces no surrogate at all.
        const answer = rcloneFailureMessage(
          new ExecError('Remote command failed with exit code 1', {
            command: 'rclone lsjson ":s3:b"',
            stdout: '',
            stderr: '⚠'.repeat(24_000),
          }),
          'Failed to list the bucket',
        );

        expect(answer.length).toBeLessThanOrEqual(CAP);
        expect(answer).toContain('characters elided');
        expect(answer).not.toMatch(LONE_SURROGATE);
        expect(answer.split('\n… ')[0]).toMatch(/^⚠+$/u);
        expect(answer.split(' …\n').at(-1)).toMatch(/^⚠+$/u);
      });
    });
  });

  it('is fed an error the mask has already been over', async () => {
    // The whole point of reading a script's own refusal rather than the message:
    // the mask covers stdout and stderr as well as message, so nothing
    // this builds can carry the secret out whichever one wins.
    const { execAsync, service } = fakeRemoteExec();
    execAsync.mockRejectedValue(
      new ExecError('Command execution failed', {
        command: 'rclone copyto :s3:b/o',
        stdout: `Downloading…\n❌ Error: 403 for ${ACCESS_KEY} with ${SECRET}`,
        stderr: '',
      }),
    );

    const error = await execRclone(service, 'rclone copyto :s3:b/o', {
      destination,
      serverId: null,
      platformHost: SELF_HOSTED,
    }).catch((e: unknown) => e);
    expectNoCredential(rcloneFailureMessage(error, 'Failed to restore'));
  });
});
