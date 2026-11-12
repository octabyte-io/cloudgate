import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CLOUDGATE_DIRECTORY,
  REMOTE_CLOUDGATE_DIRECTORY,
  cloudgateDirectoryOn,
  localCloudgateDirectory,
} from '../../src/common/config/cloudgate-directory';
import { validateEnv } from '../../src/common/config/env.schema';
import {
  applicationsDirectoryOn,
  composeDirectoryOn,
  fileMountsDirectoryOnRunServer,
  logsDirectory,
  logsDirectoryOn,
  patchReposDirectoryOn,
  schedulesDirectoryOn,
  volumeBackupLockPathOn,
  volumeBackupsDirectoryOn,
} from '../../src/deployment-engine/deployment-engine.paths';
import { accessLogPath } from '../../src/monitoring/access-log.service';
import {
  LegacyStatsSeriesPurge,
  monitoringDirectory,
} from '../../src/realtime/legacy-stats-series';
import { sshDirectory } from '../../src/realtime/local-server-setup.service';
import { serverAuditCommand } from '../../src/servers/server-audit';
import { serverSetupCommand } from '../../src/servers/server-setup';
import { mainTraefikDirectory } from '../../src/settings/traefik-files.service';
import { dynamicTraefikDirectory } from '../../src/traefik/traefik-writer.service';

const validEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/cloudgate',
  APP_ENCRYPTION_SECRET: 'a-long-enough-secret-value-123456',
  BETTER_AUTH_SECRET: 'another-long-enough-secret-value-42',
};

/**
 * Every platform path used to derive from a hardcoded `/etc/cloudgate`, so
 * the backend only ran where its own user could write to /etc. The local tree
 * is now rooted at CLOUDGATE_DIRECTORY — and the paths baked into commands sent
 * to a *remote* Server are not, because those have to match what
 * `serverSetupCommand` created on that host.
 *
 * A custom root here is a real temp directory, and every expectation names the
 * resolved path: /etc/cloudgate exists and is writable on some dev machines, so
 * an accidental fall back to the default would otherwise pass silently.
 */
describe('CLOUDGATE_DIRECTORY', () => {
  const configured = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-root-')),
  );
  const original = process.env.CLOUDGATE_DIRECTORY;

  afterEach(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
  });

  afterAll(() => {
    fs.rmSync(configured, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('defaults to /etc/cloudgate', () => {
      expect(validateEnv(validEnv).CLOUDGATE_DIRECTORY).toBe('/etc/cloudgate');
      expect(DEFAULT_CLOUDGATE_DIRECTORY).toBe('/etc/cloudgate');
    });

    it('accepts an absolute directory', () => {
      expect(
        validateEnv({ ...validEnv, CLOUDGATE_DIRECTORY: '/var/lib/cloudgate' })
          .CLOUDGATE_DIRECTORY,
      ).toBe('/var/lib/cloudgate');
    });

    it('refuses a relative path', () => {
      expect(() =>
        validateEnv({ ...validEnv, CLOUDGATE_DIRECTORY: 'tmp/cloudgate' }),
      ).toThrow(/CLOUDGATE_DIRECTORY/);
    });

    // The filesystem root would make readValidDirectory's containment check
    // pass for every path on the host.
    it('refuses the filesystem root', () => {
      expect(() =>
        validateEnv({ ...validEnv, CLOUDGATE_DIRECTORY: '/' }),
      ).toThrow(/CLOUDGATE_DIRECTORY/);
    });

    it('refuses a path that traverses upwards', () => {
      expect(() =>
        validateEnv({ ...validEnv, CLOUDGATE_DIRECTORY: '/var/lib/../..' }),
      ).toThrow(/CLOUDGATE_DIRECTORY/);
    });
  });

  describe('the local root', () => {
    it('is the default when the variable is unset', () => {
      delete process.env.CLOUDGATE_DIRECTORY;
      expect(localCloudgateDirectory()).toBe('/etc/cloudgate');
    });

    it('is the configured directory, normalized', () => {
      process.env.CLOUDGATE_DIRECTORY = `${configured}/`;
      expect(localCloudgateDirectory()).toBe(configured);
    });

    it('throws rather than silently widening on an unusable value', () => {
      process.env.CLOUDGATE_DIRECTORY = '/';
      expect(() => localCloudgateDirectory()).toThrow(/CLOUDGATE_DIRECTORY/);
    });
  });

  describe('local paths', () => {
    it('all sit under the configured root', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(applicationsDirectoryOn(null)).toBe(`${configured}/applications`);
      expect(logsDirectory()).toBe(`${configured}/logs`);
      expect(composeDirectoryOn(null)).toBe(`${configured}/compose`);
      expect(volumeBackupsDirectoryOn(null)).toBe(
        `${configured}/volume-backups`,
      );
      expect(volumeBackupLockPathOn(null)).toBe(
        `${configured}/volume-backup-lock`,
      );
      expect(schedulesDirectoryOn(null)).toBe(`${configured}/schedules`);
      expect(patchReposDirectoryOn(null)).toBe(`${configured}/patch-repos`);
      expect(monitoringDirectory()).toBe(`${configured}/monitoring`);
      expect(sshDirectory()).toBe(`${configured}/ssh`);
      expect(mainTraefikDirectory()).toBe(`${configured}/traefik`);
      expect(dynamicTraefikDirectory()).toBe(`${configured}/traefik/dynamic`);
      expect(accessLogPath()).toBe(`${configured}/traefik/dynamic/access.log`);
    });

    it('all sit under /etc/cloudgate by default', () => {
      delete process.env.CLOUDGATE_DIRECTORY;

      expect(applicationsDirectoryOn(null)).toBe('/etc/cloudgate/applications');
      expect(logsDirectory()).toBe('/etc/cloudgate/logs');
      expect(composeDirectoryOn(null)).toBe('/etc/cloudgate/compose');
      expect(volumeBackupsDirectoryOn(null)).toBe(
        '/etc/cloudgate/volume-backups',
      );
      expect(volumeBackupLockPathOn(null)).toBe(
        '/etc/cloudgate/volume-backup-lock',
      );
      expect(schedulesDirectoryOn(null)).toBe('/etc/cloudgate/schedules');
      expect(patchReposDirectoryOn(null)).toBe('/etc/cloudgate/patch-repos');
      expect(monitoringDirectory()).toBe('/etc/cloudgate/monitoring');
      expect(sshDirectory()).toBe('/etc/cloudgate/ssh');
      expect(mainTraefikDirectory()).toBe('/etc/cloudgate/traefik');
      expect(dynamicTraefikDirectory()).toBe('/etc/cloudgate/traefik/dynamic');
      expect(accessLogPath()).toBe('/etc/cloudgate/traefik/dynamic/access.log');
    });
  });

  // Not just the strings: the filesystem call itself has to land there. This
  // was the "close 4000 EACCES: permission denied, mkdir '/etc/cloudgate'" of
  // the issue, reproduced through the live stream's series store; that store is
  // gone, and what still touches `monitoring/` is the boot purge of what
  // it left.
  describe('a process that touches the tree under the root', () => {
    it('purges the old monitoring series inside the configured directory', async () => {
      process.env.CLOUDGATE_DIRECTORY = configured;
      const series = `${configured}/monitoring/probe-app`;
      fs.mkdirSync(series, { recursive: true });
      fs.writeFileSync(`${series}/cpu.json`, '[]');

      await new LegacyStatsSeriesPurge().onApplicationBootstrap();

      expect(fs.existsSync(`${configured}/monitoring`)).toBe(false);
    });
  });

  // The regression this change is most likely to introduce: a Server is
  // provisioned with /etc/cloudgate by the setup script, so a build dispatched
  // to it must not be told to write under this instance's own root.
  describe('paths on a remote Server', () => {
    it('stay at /etc/cloudgate however this instance is configured', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(REMOTE_CLOUDGATE_DIRECTORY).toBe('/etc/cloudgate');
      for (const script of [serverSetupCommand(), serverAuditCommand()]) {
        expect(script).toContain('/etc/cloudgate');
        expect(script).not.toContain(configured);
      }
    });

    it('provision the directory the audit probe then looks for', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(serverSetupCommand()).toContain(
        `mkdir -p ${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic`,
      );
      expect(serverAuditCommand()).toContain(
        `[ -d "${REMOTE_CLOUDGATE_DIRECTORY}" ]`,
      );
    });
  });

  /**
   * The remote/local fork, as one rule rather than one expression per
   * directory.
   *
   * `logsDirectoryOn` was the only directory on the page that made this
   * distinction, and it made it by writing the fork out. Every other helper
   * resolves locally while its own docblock says the tree it names lives "on
   * the build server" — so on an install with `CLOUDGATE_DIRECTORY` set, a
   * command baked with one of them and dispatched over SSH names a root
   * `serverSetupCommand` never created on that host.
   *
   * A custom root is what makes any of that visible: with the variable unset
   * the two roots are the same literal, which is why nothing has broken and
   * why every expectation here sets it.
   */
  describe('the remote/local fork', () => {
    it('answers a Server with its own root and this process with the configured one', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(cloudgateDirectoryOn('srv_123')).toBe(REMOTE_CLOUDGATE_DIRECTORY);
      expect(cloudgateDirectoryOn(null)).toBe(configured);
      expect(cloudgateDirectoryOn(undefined)).toBe(configured);
    });

    // `''` is not a `server` row's id, so it is the platform host — the same
    // reading `buildHostServerId` gives it, and the reason both are `||`
    // rather than `??`.
    it('reads an empty server id as the platform host', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(cloudgateDirectoryOn('')).toBe(configured);
    });

    it('roots an Application source tree on the Server that holds it', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(applicationsDirectoryOn('srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/applications`,
      );
      expect(applicationsDirectoryOn(null)).toBe(`${configured}/applications`);
    });

    // The pair this one is modelled on, asserted beside it so a change to
    // either shape has to face the other.
    it('roots a deployment log on the Server that wrote it', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(logsDirectoryOn('srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/logs`,
      );
      expect(logsDirectoryOn(null)).toBe(`${configured}/logs`);
    });

    /**
     * The patch-repo clone, the first of the four and the only one with a
     * *captured* instance: an earlier run produced a delete report naming
     * `{configuredRoot}/patch-repos/application/web-app` as a directory on a
     * remote build Server. `patchReposDirectory()` is gone rather than kept
     * beside this — every caller was in `patch/` and all of them pass a
     * machine now, so a no-argument spelling would have no correct call site.
     */
    it('roots a patch-repo clone on the Server that holds it', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(patchReposDirectoryOn('srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/patch-repos`,
      );
      expect(patchReposDirectoryOn(null)).toBe(`${configured}/patch-repos`);
    });

    /**
     * A schedule's `script.sh`, the second. The runner is what makes this
     * one worse than a leak: `buildScheduleScriptRunCommand` `bash -c`'s the
     * file the materialization wrote, so a fork between them fails every night
     * rather than leaving a directory behind.
     */
    it('roots a schedule script on the Server that runs it', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(schedulesDirectoryOn('srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/schedules`,
      );
      expect(schedulesDirectoryOn(null)).toBe(`${configured}/schedules`);
    });

    /**
     * A compose stack's project tree, the third and the widest set — nine
     * call sites in five modules. A stack has **one** machine rather than the
     * Application's two: `findCompose` hard-codes `buildServerId: null`, so
     * `compose.serverId` is both the run Server and the build host, which is
     * why this takes the column where `applicationsDirectoryOn` takes
     * `buildHostServerId`'s answer.
     */
    it('roots a compose project tree on the stack’s own Server', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(composeDirectoryOn('srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/compose`,
      );
      expect(composeDirectoryOn(null)).toBe(`${configured}/compose`);
    });

    /**
     * A file mount's **bind source**, a later one and the third machine question
     * this page was asked. It is the same two roots as everything above and no
     * third one: a bind source is a path in a *host* filesystem, so the machine
     * that answers it is the machine whose daemon resolves it — the **run**
     * Server, `application.serverId`, and never `buildHostServerId`'s answer,
     * which is what the sibling helper takes. The bind **target** is the other
     * half of the pair and does not fork at all (like `accessLogFile`).
     *
     * It takes the `appName` as well as the machine because the writer of those
     * files (`MountsService.baseFilesPath`) and the daemon that mounts them
     * (`generateFileMounts`) have to be one expression, not two that agree.
     */
    it('roots a file mount source on the Server whose daemon resolves it', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(fileMountsDirectoryOnRunServer('srv_123', 'web-app')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/applications/web-app/files`,
      );
      expect(fileMountsDirectoryOnRunServer(null, 'web-app')).toBe(
        `${configured}/applications/web-app/files`,
      );
    });

    /**
     * The volume-backup staging tree and the volume lock, the fourth — and
     * the lock is the one that had to be thought about before it was converted
     * rather than after. It is not merely a misplaced directory: nothing
     * creates a lock file's parent, so `exec 9>` failed outright on a Server,
     * and the `mkdir` fallback read the same missing directory as the *busy*
     * branch and answered 409 about a lock nobody held.
     */
    it('roots the volume staging tree and the volume lock on the Service’s Server', () => {
      process.env.CLOUDGATE_DIRECTORY = configured;

      expect(volumeBackupsDirectoryOn('srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/volume-backups`,
      );
      expect(volumeBackupsDirectoryOn(null)).toBe(
        `${configured}/volume-backups`,
      );
      expect(volumeBackupLockPathOn('srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/volume-backup-lock`,
      );
      expect(volumeBackupLockPathOn(null)).toBe(
        `${configured}/volume-backup-lock`,
      );
    });

    it('collapses to one answer on an install that configures no root', () => {
      delete process.env.CLOUDGATE_DIRECTORY;

      expect(applicationsDirectoryOn('srv_123')).toBe(
        applicationsDirectoryOn(null),
      );
      expect(logsDirectoryOn('srv_123')).toBe(logsDirectory());
      // The whole mechanism of this defect class, in one line: with no root
      // configured every one of these helpers answers one string, so nothing
      // that existed before the fix could fail however it resolved.
      expect(patchReposDirectoryOn('srv_123')).toBe(
        patchReposDirectoryOn(null),
      );
      expect(schedulesDirectoryOn('srv_123')).toBe(schedulesDirectoryOn(null));
      expect(composeDirectoryOn('srv_123')).toBe(composeDirectoryOn(null));
      expect(volumeBackupsDirectoryOn('srv_123')).toBe(
        volumeBackupsDirectoryOn(null),
      );
      expect(volumeBackupLockPathOn('srv_123')).toBe(
        volumeBackupLockPathOn(null),
      );
    });
  });
});
