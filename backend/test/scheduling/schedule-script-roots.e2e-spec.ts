import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import request from 'supertest';
import { App } from 'supertest/types';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createScheduleSchema } from '../../src/scheduling/schedules/dto/schedule.dto';
import { SchedulesService } from '../../src/scheduling/schedules/schedules.service';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Which **root** a schedule's `script.sh` is materialized, run and removed
 * under (`deployment-engine.paths.ts`' `schedulesDirectory` item,
 * ADR-0018's rule stated for roots).
 *
 * `schedulesDirectory()` was `localCloudgateDirectory()` — *this process's*
 * root — for every machine alike, while all three of its call sites are baked
 * into commands sent to the schedule's own Server. So on an install with
 * `CLOUDGATE_DIRECTORY` set, a `server` schedule's `mkdir -p` created a tree
 * under a root `serverSetupCommand` never laid out on that host, and the cron
 * then ran `bash -c {thatRoot}/schedules/{appName}/script.sh` there.
 *
 * **Why nothing broke, and why nothing would have caught it.** With the
 * variable unset the two roots are the *same literal*, so all three sites were
 * self-consistent and every pre-existing assertion about them —
 * `schedule-commands.spec.ts`' pinned literals and `schedules.e2e-spec.ts`'
 * remote-Server materialization, removal and cron-run tests — passes whichever
 * root is resolved. That is the root change's headline measurement one directory along. So
 * this file sets the variable and every expectation names the *resolved* temp
 * path, because `/etc/cloudgate` exists and is writable on some development
 * hosts and a silent fall back to the default would read as a pass.
 *
 * **And why the conversion is the three sites at once.** ADR-0018: whoever
 * creates an artifact and whoever destroys it must answer this the same way.
 * The writer is `buildScriptMaterializationCommand`, the destroyer is
 * `buildScriptRemovalCommand`, and between them sits a *runner*,
 * `buildScheduleScriptRunCommand`, which is the one that turns a disagreement
 * into a silent nightly failure rather than a leak. So the decisive assertions
 * below are that the removal and the run both name the directory the
 * materialization wrote, taken from the create's own dispatch rather than from
 * this file's opinion.
 *
 * The **machine** half is `ScheduleTarget.serverId` and was never in doubt
 * here; it is asserted alongside because the two mistakes are independent — a
 * site can ask the right Server under the wrong root, which is the state this
 * ticket found.
 *
 * The exec layer is the only double — SSH is a boundary (§1.7).
 */
describe('The root a schedule’s script.sh lives under (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let schedules: SchedulesService;
  let servers: ServersService;
  let sshKeys: SshKeysService;
  let scheduling: SchedulingService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });

  /** A real temp directory, so the two roots are genuinely two strings. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-schedule-root-')),
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
    schedules = ctx.app.get(SchedulesService);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
    scheduling = ctx.app.get(SchedulingService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // Jobs registered by a previous test would leak across resets.
    for (const id of scheduling.ids()) {
      scheduling.unregister(id);
    }
    execMock.execAsync.mockReset().mockResolvedValue(ok);
    execMock.execAsyncRemote.mockReset().mockResolvedValue(ok);
  });

  const permissionCtx = (
    userId: string,
    organizationId: string,
  ): PermissionCtx =>
    ({
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    }) satisfies PermissionCtx;

  async function signUpOwner() {
    const res = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'];
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    return {
      cookie,
      ownerCtx: permissionCtx(
        (res.body as { user: { id: string } }).user.id,
        organizationId,
      ),
    };
  }

  /** An owner plus a remote Server to hang a `server` schedule off. */
  async function setUpServer() {
    const { ownerCtx } = await signUpOwner();
    const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
    const remote = await servers.create(ownerCtx, {
      name: 'worker-1',
      ipAddress: '203.0.113.10',
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
    });
    return { ownerCtx, remote };
  }

  const createServerSchedule = (ownerCtx: PermissionCtx, serverId: string) =>
    schedules.create(
      ownerCtx,
      createScheduleSchema.parse({
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: serverId,
        command: '',
        script: 'apt update',
      }),
    );

  const createHostSchedule = (ownerCtx: PermissionCtx) =>
    schedules.create(
      ownerCtx,
      createScheduleSchema.parse({
        name: 'Sweep logs',
        cronExpression: '0 4 * * *',
        scheduleType: 'cloudgate-server',
        command: '',
        script: 'journalctl --vacuum-time=7d',
      }),
    );

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

  /** The `{root}/schedules` a machine's own script tree is rooted at. */
  const schedulesRootOn = (serverId: string | null) =>
    serverId
      ? `${REMOTE_CLOUDGATE_DIRECTORY}/schedules`
      : `${configuredRoot}/schedules`;

  /** The materialization, read off the code that made the artifact — the
   * expectation the removal and the run below are measured against. */
  const materializations = () =>
    dispatched().filter(({ command }) => command.includes('| base64 -d > '));

  /** The script tree's removals only: the same delete also removes
   * the schedule's run logs, a second tree this file is not about. */
  const removals = () =>
    dispatched().filter(
      ({ command }) =>
        command.startsWith('rm -rf ') && command.includes('/schedules/'),
    );

  const runs = () =>
    dispatched().filter(({ command }) => command.includes('bash -c '));

  describe('the writer', () => {
    it('materializes under the Server’s own root, never under this instance’s', async () => {
      const { ownerCtx, remote } = await setUpServer();

      const created = await createServerSchedule(ownerCtx, remote.serverId);

      const directory = `${schedulesRootOn(remote.serverId)}/${created.appName}`;
      expect(materializations().map(({ serverId }) => serverId)).toEqual([
        remote.serverId,
      ]);
      expect(materializations()[0].command).toContain(`mkdir -p ${directory}`);
      expect(materializations()[0].command).toContain(
        `mv -f ${directory}/script.sh.tmp ${directory}/script.sh`,
      );
      expect(materializations()[0].command).not.toContain(configuredRoot);
    });

    // An update re-materializes, so it is a second writer of the same file and
    // has to answer the same way (it is written beside and moves it on).
    it('re-materializes under the same root on an update', async () => {
      const { ownerCtx, remote } = await setUpServer();
      const created = await createServerSchedule(ownerCtx, remote.serverId);
      const directory = `${schedulesRootOn(remote.serverId)}/${created.appName}`;
      execMock.execAsyncRemote.mockClear();

      await schedules.update(ownerCtx, created.scheduleId, {
        script: 'apt update && apt upgrade -y',
      });

      expect(materializations()).toEqual([
        expect.objectContaining({ serverId: remote.serverId }),
      ]);
      expect(materializations()[0].command).toContain(`mkdir -p ${directory}`);
      expect(materializations()[0].command).not.toContain(configuredRoot);
    });

    // The branch that has to keep working: `cloudgate-server` *is* this
    // process's own machine (ADR-0008), which is the whole reason
    // CLOUDGATE_DIRECTORY exists.
    it('materializes under this instance’s configured root for the platform host', async () => {
      const { ownerCtx } = await signUpOwner();

      const created = await createHostSchedule(ownerCtx);

      expect(materializations().map(({ serverId }) => serverId)).toEqual([
        null,
      ]);
      expect(materializations()[0].command).toContain(
        `mkdir -p ${configuredRoot}/schedules/${created.appName}`,
      );
      expect(materializations()[0].command).not.toContain(
        `${REMOTE_CLOUDGATE_DIRECTORY}/schedules`,
      );
    });
  });

  describe('the runner and the destroyer', () => {
    /**
     * The decisive assertion of this set for the *run*: a cron tick executes
     * the file the materialization wrote. A root that forks between the two is
     * not a leak — it is a schedule that reports a failure every night, or,
     * where the local root happens to exist on the Server too, one that runs a
     * stale script nothing has updated.
     */
    it('runs the script.sh the materialization wrote, on that machine', async () => {
      const { ownerCtx, remote } = await setUpServer();
      const created = await createServerSchedule(ownerCtx, remote.serverId);
      const written = materializations()[0];
      const directory = `${schedulesRootOn(remote.serverId)}/${created.appName}`;
      expect(written.command).toContain(`mv -f ${directory}/script.sh.tmp`);
      execMock.execAsyncRemote.mockClear();

      await schedules.runScheduled(created.scheduleId);

      expect(runs()).toEqual([
        expect.objectContaining({ serverId: written.serverId }),
      ]);
      expect(runs()[0].command).toContain(`bash -c ${directory}/script.sh`);
      expect(runs()[0].command).not.toContain(configuredRoot);
    });

    /**
     * And for the *removal*: `SchedulesService.remove` is the only thing that
     * reclaims the tree, so a removal under the other root leaves the script
     * and its directory on the Server for ever under an `appName` no row names
     * any more — ADR-0018's own defect, one artifact along.
     */
    it('removes the directory the materialization wrote, on that machine', async () => {
      const { ownerCtx, remote } = await setUpServer();
      const created = await createServerSchedule(ownerCtx, remote.serverId);
      const written = materializations()[0];
      const directory = `${schedulesRootOn(remote.serverId)}/${created.appName}`;
      expect(written.command).toContain(`mkdir -p ${directory}`);
      execMock.execAsyncRemote.mockClear();

      await schedules.remove(ownerCtx, created.scheduleId);

      expect(removals()).toEqual([
        { serverId: written.serverId, command: `rm -rf ${directory}` },
      ]);
    });

    // The platform-host branch of both, which is the default install.
    it('runs and removes under this instance’s configured root for the platform host', async () => {
      const { ownerCtx } = await signUpOwner();
      const created = await createHostSchedule(ownerCtx);
      const directory = `${configuredRoot}/schedules/${created.appName}`;
      execMock.execAsync.mockClear();

      await schedules.runScheduled(created.scheduleId);
      await schedules.remove(ownerCtx, created.scheduleId);

      expect(runs()[0]).toEqual(
        expect.objectContaining({ serverId: null as string | null }),
      );
      expect(runs()[0].command).toContain(`bash -c ${directory}/script.sh`);
      expect(removals()).toEqual([
        { serverId: null, command: `rm -rf ${directory}` },
      ]);
      // And the run logs under the same configured root, not the default one
      // — the writer and this destroyer share one path expression.
      expect(
        dispatched().filter(
          ({ command }) =>
            command.startsWith('rm -rf ') && command.includes('/logs/'),
        ),
      ).toEqual([
        expect.objectContaining({
          serverId: null,
          command: `rm -rf ${configuredRoot}/logs/${created.appName}`,
        }),
      ]);
    });
  });
});
