import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse } from 'yaml';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import * as schema from '../../src/db/schema';
import {
  DEPLOYMENT_QUEUE,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { DOCKER_CLIENT } from '../../src/docker/docker-client.provider';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { SHELL_PAYLOAD, expectQuotedInCommand } from '../utils/shell-safety';
import { DeploymentNotifierAdapter } from '../../src/notifications/deployment-notifier.adapter';
import { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import type { FileConfig } from '../../src/traefik/config/file-types';
import { CLOUDGATE_VERSION } from '../../src/settings/version';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { CleanupService } from '../../src/settings/cleanup.service';
import { DockerCleanupService } from '../../src/settings/docker-cleanup.service';
import { DockerResourceService } from '../../src/settings/docker-resource.service';
import { GPU_SETUP_PAUSE } from '../../src/settings/gpu.service';
import { LogCleanupService } from '../../src/settings/log-cleanup.service';
import { TraefikSetupService } from '../../src/settings/traefik-setup.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { defaultWebServerMetricsConfig } from '../../src/settings/settings.schema';
import { SettingsService } from '../../src/settings/settings.service';
import {
  ACCESS_LOG_MAX_BYTES,
  MAIN_TRAEFIK_DIR,
  TraefikFilesService,
} from '../../src/settings/traefik-files.service';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { seededConfigName } from '../utils/seeded-config-name';

jest.setTimeout(120_000);

/**
 * The public address this instance is reached on — `deploy/install.sh`'s one
 * required input. `updateServerTraefik` resolves the console's upstream from
 * it, so it has to be set before the app boots.
 */
/** A Server's own Traefik tree, which is not this instance's. */
const REMOTE_TRAEFIK_DIR = `${REMOTE_CLOUDGATE_DIRECTORY}/traefik`;

const CONSOLE_HOST = '203.0.113.10';
const CONSOLE_PORT = '3000';
process.env.CLOUDGATE_PUBLIC_HOST = CONSOLE_HOST;
process.env.CONSOLE_PORT = CONSOLE_PORT;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  httpServer: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(httpServer)
    .post('/api/auth/sign-up/email')
    .send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

/** `SettingsService.requireOwnerOrAdmin`'s refusal, written out. */
const OWNER_OR_ADMIN_REFUSAL =
  'Only owners and admins can manage web server settings';

/** `PermissionService.checkInstanceAuthority`'s refusal, written out. */
const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

/** The message an `AllExceptionsFilter` response carries. */
const refusal = (res: { body: unknown }): string =>
  (res.body as { message: string }).message;

describe('Settings (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let settings: SettingsService;
  let traefikFiles: TraefikFilesService;
  let dockerResources: DockerResourceService;
  let traefikSetup: TraefikSetupService;
  let logCleanup: LogCleanupService;
  let cleanup: CleanupService;
  let dockerCleanup: DockerCleanupService;
  let dispatcher: NotificationDispatcherService;
  let traefikDir: string;

  /**
   * The Traefik root per machine: a temp dir for the platform host,
   * whose files this suite reads and writes with `fs`, and a Server's own tree
   * — the one `serverSetupCommand` creates — for a `serverId`.
   */
  const traefikDirOn = (serverId?: string | null) =>
    serverId ? REMOTE_TRAEFIK_DIR : traefikDir;

  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  const dockerFactory = {
    getRemoteDocker: jest.fn<Promise<unknown>, [string | undefined]>(),
  };

  const traefikWriter = {
    loadOrCreateConfig: jest.fn<Promise<FileConfig>, [string]>(),
    writeConfig: jest.fn<Promise<void>, [string, FileConfig]>(),
    removeConfig: jest.fn<Promise<void>, [string]>(),
    writeCertificate: jest.fn<Promise<void>, [unknown]>(),
    removeCertificate: jest.fn<Promise<void>, [string]>(),
  };

  const fetchClient = jest.fn<Promise<Response>, [string, unknown?]>();

  const dockerClient = {
    getContainer: jest.fn<
      { inspect: () => Promise<{ State: { Running: boolean } }> },
      [string]
    >(),
    getService: jest.fn<unknown, [string]>(),
    listTasks: jest.fn<Promise<unknown[]>, [unknown]>(),
  };

  beforeAll(async () => {
    traefikDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-traefik-'));
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: remoteExec },
        { provide: RemoteDockerFactory, useValue: dockerFactory },
        { provide: TraefikWriterService, useValue: traefikWriter },
        { provide: FETCH_CLIENT, useValue: fetchClient },
        { provide: DOCKER_CLIENT, useValue: dockerClient },
        // A function of the machine, and this double relocates only
        // the platform host's branch: the temp dir is what makes the `fs` half
        // of this suite safe to run, while a Server's tree is the one
        // `serverSetupCommand` created and `mainTraefikDirectory` resolves.
        { provide: MAIN_TRAEFIK_DIR, useValue: traefikDirOn },
        // GPU setup waits 15 s for Docker to come back after its restart;
        // the doubled daemon is back at once.
        { provide: GPU_SETUP_PAUSE, useValue: () => Promise.resolve() },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    settings = ctx.app.get(SettingsService);
    traefikFiles = ctx.app.get(TraefikFilesService);
    dockerResources = ctx.app.get(DockerResourceService);
    traefikSetup = ctx.app.get(TraefikSetupService);
    logCleanup = ctx.app.get(LogCleanupService);
    cleanup = ctx.app.get(CleanupService);
    dockerCleanup = ctx.app.get(DockerCleanupService);
    dispatcher = ctx.app.get(NotificationDispatcherService);
  });

  afterAll(async () => {
    await ctx.teardown();
    fs.rmSync(traefikDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    remoteExec.execAsync.mockResolvedValue(ok(''));
    remoteExec.execAsyncRemote.mockResolvedValue(ok(''));
    fs.rmSync(traefikDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(traefikDir, 'dynamic'), { recursive: true });
  });

  describe('web-server settings singleton', () => {
    it('creates the row with its defaults on first read and reuses it', async () => {
      const first = await settings.getWebServerSettings();

      expect(first.certificateType).toBe('none');
      expect(first.https).toBe(false);
      expect(first.host).toBeNull();
      expect(first.serverIp).toBeNull();
      expect(first.enableDockerCleanup).toBe(true);
      expect(first.logCleanupCron).toBe('0 0 * * *');
      expect(first.buildsConcurrency).toBe(1);
      expect(first.metricsConfig).toEqual({
        server: {
          type: 'Cloudgate',
          refreshRate: 60,
          port: 4500,
          token: '',
          retentionDays: 2,
          cronJob: '',
          urlCallback: '',
          thresholds: { cpu: 0, memory: 0 },
        },
        containers: {
          refreshRate: 60,
          services: { include: [], exclude: [] },
        },
      });

      const second = await settings.getWebServerSettings();
      expect(second.id).toBe(first.id);
    });

    it('corrects a stored metrics type to Cloudgate on read and persists it', async () => {
      const created = await settings.getWebServerSettings();
      await ctx.db.update(schema.webServerSettings).set({
        metricsConfig: {
          ...created.metricsConfig,
          server: { ...created.metricsConfig.server, type: 'Remote' },
        },
      });
      const [stale] = await ctx.db.select().from(schema.webServerSettings);
      expect(stale.metricsConfig.server.type).toBe('Remote');

      const read = await settings.getWebServerSettings();
      expect(read.id).toBe(created.id);
      expect(read.metricsConfig.server.type).toBe('Cloudgate');
      expect(read.metricsConfig.server.port).toBe(4500);

      const [stored] = await ctx.db.select().from(schema.webServerSettings);
      expect(stored.metricsConfig.server.type).toBe('Cloudgate');
    });

    it('updates settings partially and bumps updatedAt', async () => {
      const created = await settings.getWebServerSettings();

      const updated = await settings.updateWebServerSettings({
        host: 'panel.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });

      expect(updated.id).toBe(created.id);
      expect(updated.host).toBe('panel.example.com');
      expect(updated.https).toBe(true);
      expect(updated.certificateType).toBe('letsencrypt');
      // Untouched fields survive the partial update.
      expect(updated.enableDockerCleanup).toBe(true);
      expect(updated.updatedAt >= created.updatedAt).toBe(true);
    });

    // The instance's own SSH key was stored here, encrypted, and read by
    // nothing — Servers are dialled with `ssh_key.private_key`. The migration
    // drops the column, and with it every stored ciphertext; this pins that a
    // migrated database has no place left to put one.
    it('has no column to store an instance SSH private key in', async () => {
      await settings.getWebServerSettings();

      const columns = await ctx.db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns
            where table_name = 'web_server_settings'`,
      );
      const names = columns.rows.map((row) => row.column_name);
      // The premise: this is the singleton's table, read from a migrated schema.
      expect(names).toContain('server_ip');
      expect(names).not.toContain('ssh_private_key');
    });

    it("builds the instance URL from host and https, else serverIp and the console's port", async () => {
      // No host: falls back to http://serverIp:<console port>. Which port that
      // is depends on the environment this runs in, so what is pinned here is
      // the thing the link fix was about — it is never *this process's* listener,
      // which is what a link mailed to an operator used to carry. The exact
      // resolution is pinned in `notifications/deployment-link.spec.ts`.
      await settings.updateWebServerSettings({ serverIp: '203.0.113.7' });
      const url = new URL((await settings.getInstanceUrl()) as string);
      expect(url.hostname).toBe('203.0.113.7');
      expect(url.port).not.toBe(String(process.env.PORT ?? 4000));

      // Host set: protocol follows the https flag.
      await settings.updateWebServerSettings({ host: 'panel.example.com' });
      expect(await settings.getInstanceUrl()).toBe('http://panel.example.com');

      await settings.updateWebServerSettings({ https: true });
      expect(await settings.getInstanceUrl()).toBe('https://panel.example.com');
    });
  });

  describe('admin-gated settings mutations', () => {
    // The save/clear pair went with the column. An owner — who held
    // the authority both routes took — is answered 404 by each, so no console
    // or script can store a private key on the instance any more.
    it('offers no route to save or clear an instance SSH private key', async () => {
      const session = await signUp(httpServer, owner);

      const save = await request(httpServer)
        .post('/settings/ssh-private-key')
        .set('Cookie', session.cookie)
        .send({ sshPrivateKey: 'ssh-rsa SAVED-KEY' });
      expect(save.status).toBe(404);

      const clean = await request(httpServer)
        .delete('/settings/ssh-private-key')
        .set('Cookie', session.cookie);
      expect(clean.status).toBe(404);
    });

    it('updates and reads the server IP', async () => {
      const session = await signUp(httpServer, owner);

      const update = await request(httpServer)
        .post('/settings/ip')
        .set('Cookie', session.cookie)
        .send({ serverIp: '198.51.100.4' });
      expect(update.status).toBe(200);

      // getIp is open to any authenticated user.
      const read = await request(httpServer)
        .get('/settings/ip')
        .set('Cookie', session.cookie);
      expect(read.status).toBe(200);
      expect(read.text).toBe('198.51.100.4');
    });

    it('updates the builds concurrency within 1 to 100', async () => {
      const session = await signUp(httpServer, owner);

      const update = await request(httpServer)
        .post('/settings/builds-concurrency')
        .set('Cookie', session.cookie)
        .send({ buildsConcurrency: 4 });
      expect(update.status).toBe(200);
      expect((await settings.getWebServerSettings()).buildsConcurrency).toBe(4);

      const outOfRange = await request(httpServer)
        .post('/settings/builds-concurrency')
        .set('Cookie', session.cookie)
        .send({ buildsConcurrency: 101 });
      expect(outOfRange.status).toBe(400);
    });

    it('denies a plain member the admin mutations', async () => {
      const session = await signUp(httpServer, owner);
      const memberSession = await signUpMember(httpServer, session.cookie);

      // It writes the `web_server_settings` singleton, so the refusal is the
      // instance one now (H-63). A plain member fails either gate; which
      // sentence comes back is what says *which question was asked*, and it is
      // no longer "what is your role here".
      const ip = await request(httpServer)
        .post('/settings/ip')
        .set('Cookie', memberSession.cookie)
        .send({ serverIp: '198.51.100.9' });
      expect(ip.status).toBe(403);
      expect(refusal(ip)).toBe(INSTANCE_AUTHORITY_REFUSAL);
    });
  });

  describe('traefik file surface', () => {
    it('reads and writes the main traefik.yml (readMainConfig/writeMainConfig)', () => {
      expect(traefikFiles.readMainConfig()).toBeNull();

      traefikFiles.writeMainConfig('entryPoints:\n  web:\n    address: :80\n');
      expect(traefikFiles.readMainConfig()).toBe(
        'entryPoints:\n  web:\n    address: :80\n',
      );
      expect(
        fs.readFileSync(path.join(traefikDir, 'traefik.yml'), 'utf8'),
      ).toContain('entryPoints');
    });

    it('reads and writes named dynamic configs (readConfig/writeConfig)', () => {
      expect(traefikFiles.readConfig('cloudgate')).toBeNull();

      traefikFiles.writeConfig('cloudgate', 'http:\n  routers: {}\n');
      expect(traefikFiles.readConfig('cloudgate')).toBe(
        'http:\n  routers: {}\n',
      );
      expect(
        fs.existsSync(path.join(traefikDir, 'dynamic', 'cloudgate.yml')),
      ).toBe(true);
    });

    /**
     * The two branches take **two paths**, not one,: each is
     * confined to the Traefik tree of the machine it addresses, so the local
     * half names this instance's own directory and the remote half names the
     * tree `serverSetupCommand` created on that Server. They were the same path
     * here — which is what the defect looked like from inside a test with
     * `CLOUDGATE_DIRECTORY` unset. `traefik-files-roots.e2e-spec.ts` is where
     * the roots are genuinely two strings and where the refusals each way are
     * asserted.
     */
    it('reads/writes a config at an explicit path, locally and remotely', async () => {
      const filePath = path.join(traefikDir, 'dynamic', 'custom.yml');
      const remotePath = path.join(REMOTE_TRAEFIK_DIR, 'dynamic', 'custom.yml');
      fs.writeFileSync(filePath, 'tcp: {}\n');

      // Local read/write.
      expect(await traefikFiles.readConfigInPath(filePath)).toBe('tcp: {}\n');
      await traefikFiles.writeTraefikConfigInPath(filePath, 'udp: {}\n');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('udp: {}\n');

      // Remote read: cats the file over SSH.
      remoteExec.execAsyncRemote.mockResolvedValueOnce(ok('http: {}\n'));
      expect(await traefikFiles.readConfigInPath(remotePath, 'srv-1')).toBe(
        'http: {}\n',
      );
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        'srv-1',
        `cat ${remotePath}`,
      );

      // Remote write: base64 round-trip like the traefik writer.
      await traefikFiles.writeTraefikConfigInPath(
        remotePath,
        'tls: {}\n',
        'srv-1',
      );
      const encoded = Buffer.from('tls: {}\n', 'utf-8').toString('base64');
      // The redirect target is `quote()`d rather than wrapped in double quotes.
      // A path with nothing special in it quotes to itself, so this
      // still pins the emitted command exactly.
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        'srv-1',
        `echo "${encoded}" | base64 -d > ${remotePath}`,
      );
    });

    /**
     * `validatePath` confines the path to the traefik directory but says
     * nothing about the characters in it, so `…/dynamic/a$(id).yml` passes it
     * and used to reach an unquoted `cat` and an only-double-quoted redirect
     * over SSH — where `$` and a backtick still substitute. An earlier fix quoted the
     * command builders one ring out and missed this pair; the confinement rule
     * and the shell rule are orthogonal, exactly as `mount.dto.ts` records for
     * the traversal and shell-safety rules.
     */
    it('quotes an explicit path that carries a shell metacharacter', async () => {
      // In the Server's own tree, because that is the branch that reaches a
      // shell at all and,, the only one `validatePath` admits with a
      // `serverId`.
      const nasty = path.join(
        REMOTE_TRAEFIK_DIR,
        'dynamic',
        `${SHELL_PAYLOAD}.yml`,
      );

      remoteExec.execAsyncRemote.mockResolvedValueOnce(ok('http: {}\n'));
      await traefikFiles.readConfigInPath(nasty, 'srv-1');
      expectQuotedInCommand(
        remoteExec.execAsyncRemote.mock.calls.at(-1)?.[1] ?? null,
      );

      await traefikFiles.writeTraefikConfigInPath(nasty, 'tls: {}\n', 'srv-1');
      expectQuotedInCommand(
        remoteExec.execAsyncRemote.mock.calls.at(-1)?.[1] ?? null,
      );
    });

    it('confines explicit paths to the traefik directory', async () => {
      await expect(
        traefikFiles.readConfigInPath('/etc/passwd'),
      ).rejects.toThrow('Invalid path');
      await expect(
        traefikFiles.readConfigInPath(`${traefikDir}/../escape.yml`),
      ).rejects.toThrow('Invalid path');
      // The write path is confined too, not only the read.
      await expect(
        traefikFiles.writeTraefikConfigInPath('/etc/cron.d/evil', 'x'),
      ).rejects.toThrow('Invalid path');
    });

    it('lists the traefik directory as a tree (readDirectories)', async () => {
      fs.writeFileSync(path.join(traefikDir, 'traefik.yml'), 'x');
      fs.writeFileSync(path.join(traefikDir, 'dynamic', 'cloudgate.yml'), 'y');

      const tree = await traefikFiles.readDirectory(traefikDir);
      const names = tree.map((item) => item.name).sort();
      expect(names).toEqual(['dynamic', 'traefik.yml']);

      const dynamic = tree.find((item) => item.name === 'dynamic');
      expect(dynamic?.type).toBe('directory');
      expect(dynamic?.children?.map((child) => child.name)).toEqual([
        'cloudgate.yml',
      ]);
      const file = tree.find((item) => item.name === 'traefik.yml');
      expect(file?.type).toBe('file');
      expect(file?.id).toBe(path.join(traefikDir, 'traefik.yml'));

      // Remote listing runs the process_items script and parses stdout.
      remoteExec.execAsyncRemote.mockResolvedValueOnce(
        ok(
          '[{"id":"/etc/cloudgate/traefik/traefik.yml","name":"traefik.yml","type":"file"}]',
        ),
      );
      const remoteTree = await traefikFiles.readDirectory(traefikDir, 'srv-1');
      expect(remoteTree).toEqual([
        {
          id: '/etc/cloudgate/traefik/traefik.yml',
          name: 'traefik.yml',
          type: 'file',
        },
      ]);
      const [serverId, script] = remoteExec.execAsyncRemote.mock.calls.at(
        -1,
      ) as [string, string];
      expect(serverId).toBe('srv-1');
      expect(script).toContain('process_items()');
      expect(script).toContain(`root_dir=${traefikDir}`);
    });

    it('toggles the access-log block in the main config (toggleRequests)', async () => {
      traefikFiles.writeMainConfig('entryPoints:\n  web:\n    address: :80\n');
      expect(await traefikFiles.haveActivateRequests()).toEqual({
        present: true,
        enabled: false,
      });

      await traefikFiles.toggleRequests(true);
      expect(await traefikFiles.haveActivateRequests()).toEqual({
        present: true,
        enabled: true,
      });
      const config = parse(traefikFiles.readMainConfig() as string) as {
        accessLog?: { filePath: string; format: string; bufferingSize: number };
      };
      // Traefik reads this path inside its container, where the dynamic
      // directory is the fixed bind target — so it is the literal on the
      // platform host too, and deliberately does not follow CLOUDGATE_DIRECTORY.
      expect(config.accessLog).toEqual({
        filePath: '/etc/cloudgate/traefik/dynamic/access.log',
        format: 'json',
        bufferingSize: 100,
      });

      await traefikFiles.toggleRequests(false);
      expect(await traefikFiles.haveActivateRequests()).toEqual({
        present: true,
        enabled: false,
      });
    });

    it('reports that the toggle only reaches Traefik on restart, and restarts nothing', async () => {
      const session = await signUp(httpServer, owner);
      traefikFiles.writeMainConfig('entryPoints:\n  web:\n    address: :80\n');

      const res = await request(httpServer)
        .post('/settings/traefik/requests')
        .set('Cookie', session.cookie)
        .send({ enable: true });

      expect(res.status).toBe(200);
      // accessLog lands in the *static* traefik.yml, which Traefik reads once
      // at process start: the caller is told a restart is owed, not given one.
      expect(res.body).toEqual({ written: true, restartRequired: true });
      await expect(traefikFiles.haveActivateRequests()).resolves.toEqual({
        present: true,
        enabled: true,
      });

      // Dropping every connection on 80/443 is never a side effect of the
      // toggle — POST /settings/traefik/reload stays the only restart.
      const commands = remoteExec.execAsync.mock.calls.map(([cmd]) => cmd);
      expect(commands.join('\n')).not.toContain('cloudgate-traefik');
    });

    it('tells "no Traefik configuration here" apart from "logging is off"', async () => {
      const session = await signUp(httpServer, owner);
      // A host where the Traefik setup step never ran: no traefik.yml at all.
      fs.rmSync(path.join(traefikDir, 'traefik.yml'), { force: true });

      const absent = await request(httpServer)
        .get('/settings/traefik/requests')
        .set('Cookie', session.cookie);
      expect(absent.status).toBe(200);
      expect(absent.body).toEqual({ present: false, enabled: false });

      // Nothing to write into: a refusal, not a quiet `false`.
      const toggle = await request(httpServer)
        .post('/settings/traefik/requests')
        .set('Cookie', session.cookie)
        .send({ enable: true });
      expect(toggle.status).toBe(404);
      expect((toggle.body as { message: string }).message).toMatch(/traefik/i);

      // With a config in place, "off" is a distinct, present answer.
      traefikFiles.writeMainConfig('entryPoints:\n  web:\n    address: :80\n');
      const off = await request(httpServer)
        .get('/settings/traefik/requests')
        .set('Cookie', session.cookie);
      expect(off.body).toEqual({ present: true, enabled: false });
    });

    it('scopes the request-logging toggle to a Server, org-scoped', async () => {
      const session = await signUp(httpServer, owner);
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const [ownServer] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId,
        })
        .returning();
      // The Server's own `traefik.yml`, not this instance's: the path baked
      // into a command sent over SSH is the tree `serverSetupCommand` created
      // on that host. `traefik-files-roots.e2e-spec.ts` is where the two
      // roots are genuinely two strings; here they differ because the platform
      // host's is the injected temp dir.
      const remoteMainConfig = path.join(REMOTE_TRAEFIK_DIR, 'traefik.yml');

      // The platform host is off; the Server's own traefik.yml is on. The
      // toggle must answer for the Server the caller named, not the host.
      traefikFiles.writeMainConfig('entryPoints:\n  web:\n    address: :80\n');
      remoteExec.execAsyncRemote.mockResolvedValueOnce(
        ok(
          'accessLog:\n  filePath: /etc/cloudgate/traefik/dynamic/access.log\n',
        ),
      );
      const status = await request(httpServer)
        .get('/settings/traefik/requests')
        .query({ serverId: ownServer.serverId })
        .set('Cookie', session.cookie);
      expect(status.status).toBe(200);
      expect(status.body).toEqual({ present: true, enabled: true });
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        ownServer.serverId,
        `cat ${remoteMainConfig}`,
      );

      // Writing goes to that same Server over SSH, never to the local file.
      // The SSH answers in the order the switch asks: its read of
      // traefik.yml, the write, then the restart — the probe finding
      // Traefik a standalone container, and `docker restart` going through.
      remoteExec.execAsyncRemote
        .mockResolvedValueOnce(ok('entryPoints:\n  web:\n    address: :80\n'))
        .mockResolvedValueOnce(ok(''))
        .mockResolvedValueOnce(ok('standalone\n'))
        .mockResolvedValueOnce(ok(''));
      const toggle = await request(httpServer)
        .post('/settings/traefik/requests')
        .set('Cookie', session.cookie)
        .send({ enable: true, serverId: ownServer.serverId });
      expect(toggle.status).toBe(200);
      // On a Server the restart is part of the switch, awaited before the
      // answer, so none is owed.
      expect(toggle.body).toEqual({ written: true, restartRequired: false });
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        ownServer.serverId,
        'docker restart cloudgate-traefik',
      );
      const write = remoteExec.execAsyncRemote.mock.calls.find(([, command]) =>
        command.includes('base64 -d >'),
      ) as [string, string];
      expect(write[0]).toBe(ownServer.serverId);
      // The redirect target is `quote()`d now, not double-quoted; a
      // temp path with nothing special in it quotes to itself.
      expect(write[1]).toContain(`> ${remoteMainConfig}`);
      const written = Buffer.from(
        /echo "([^"]+)"/.exec(write[1])?.[1] ?? '',
        'base64',
      ).toString('utf8');
      expect(parse(written)).toMatchObject({
        accessLog: { filePath: '/etc/cloudgate/traefik/dynamic/access.log' },
      });
      // The platform host's own config was left alone.
      await expect(traefikFiles.haveActivateRequests()).resolves.toEqual({
        present: true,
        enabled: false,
      });

      // A Server with no traefik.yml: cat answers nothing.
      remoteExec.execAsyncRemote.mockResolvedValueOnce(ok(''));
      const bare = await request(httpServer)
        .get('/settings/traefik/requests')
        .query({ serverId: ownServer.serverId })
        .set('Cookie', session.cookie);
      expect(bare.body).toEqual({ present: false, enabled: false });

      // Cross-org serverIds are refused before any SSH happens.
      const crossOrgRead = await request(httpServer)
        .get('/settings/traefik/requests')
        .query({ serverId: 'srv-of-someone-else' })
        .set('Cookie', session.cookie);
      expect(crossOrgRead.status).toBe(404);
      expect((crossOrgRead.body as { message: string }).message).toBe(
        'Server not found',
      );

      const crossOrgWrite = await request(httpServer)
        .post('/settings/traefik/requests')
        .set('Cookie', session.cookie)
        .send({ enable: true, serverId: 'srv-of-someone-else' });
      expect(crossOrgWrite.status).toBe(404);
      expect((crossOrgWrite.body as { message: string }).message).toBe(
        'Server not found',
      );
    });

    it('exposes the traefik config over HTTP with admin gating', async () => {
      const session = await signUp(httpServer, owner);
      const memberSession = await signUpMember(httpServer, session.cookie);

      const write = await request(httpServer)
        .post('/settings/traefik/config')
        .set('Cookie', session.cookie)
        .send({ traefikConfig: 'entryPoints: {}\n' });
      expect(write.status).toBe(200);

      const read = await request(httpServer)
        .get('/settings/traefik/config')
        .set('Cookie', session.cookie);
      expect(read.status).toBe(200);
      expect(read.text).toBe('entryPoints: {}\n');

      const denied = await request(httpServer)
        .post('/settings/traefik/config')
        .set('Cookie', memberSession.cookie)
        .send({ traefikConfig: 'evil: {}\n' });
      expect(denied.status).toBe(403);
      // The platform host's own `traefik.yml`, so the refusal is the
      // instance one now (H-52). A plain member fails either gate; which
      // sentence comes back is what says *which question was asked*, and it
      // is no longer "what is your role here".
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);

      // traefikFiles-permission endpoints: members hold no traefikFiles
      // grants, so even reads are denied.
      const deniedRead = await request(httpServer)
        .get('/settings/traefik/directories')
        .set('Cookie', memberSession.cookie);
      expect(deniedRead.status).toBe(403);
      // A different gate from the one above, and the message proves which:
      // this route carries @RequirePermission('traefikFiles', 'read') and
      // memberRole holds `traefikFiles: []`, so PermissionsGuard refuses it
      // before the handler rather than SettingsService refusing inside it, and
      // the refusal names the resource it refused.
      expect(refusal(deniedRead)).toBe(
        'unauthorized to access resource "traefikFiles"',
      );
      expect(refusal(deniedRead)).not.toBe(OWNER_OR_ADMIN_REFUSAL);

      const ownerRead = await request(httpServer)
        .get('/settings/traefik/directories')
        .set('Cookie', session.cookie);
      expect(ownerRead.status).toBe(200);
    });

    /**
     * At the route: `traefik.yml` is read only when Traefik starts, so a
     * broken save used to take every domain down at the next restart, far from
     * the edit. The unit spec (`traefik-files.service.spec.ts`) carries the
     * cases; this pins the answer an operator sees on both routes that write it.
     */
    it('refuses invalid YAML for traefik.yml with 400 on both routes, and leaves the file unchanged', async () => {
      const session = await signUp(httpServer, owner);
      const mainConfig = path.join(traefikDir, 'traefik.yml');
      fs.writeFileSync(mainConfig, 'entryPoints: {}\n');

      const byCard = await request(httpServer)
        .post('/settings/traefik/config')
        .set('Cookie', session.cookie)
        .send({ traefikConfig: 'providers: [unclosed\n' });
      const byPath = await request(httpServer)
        .post('/settings/traefik/file')
        .set('Cookie', session.cookie)
        .send({ path: mainConfig, traefikConfig: 'providers: [unclosed\n' });

      for (const res of [byCard, byPath]) {
        expect(res.status).toBe(400);
        expect(refusal(res)).toMatch(
          /^traefik\.yml is not valid YAML: .* at line 2, column 1$/,
        );
      }
      // Nothing was written on the way to either refusal.
      expect(fs.readFileSync(mainConfig, 'utf8')).toBe('entryPoints: {}\n');
    });

    /**
     * The two named `dynamic/` files share the Main configuration card and its
     * refusal: `TraefikFilesService.writeConfig` parses before it writes, so
     * `writeRawTraefikConfig`'s observer never sees a file Traefik would drop.
     */
    it.each([
      ['web-server-config', 'cloudgate.yml'],
      ['middlewares-config', 'middlewares.yml'],
    ])(
      'refuses invalid YAML on POST /settings/traefik/%s with 400, and leaves %s unchanged',
      async (route, file) => {
        const session = await signUp(httpServer, owner);
        const onDisk = path.join(traefikDir, 'dynamic', file);
        fs.writeFileSync(onDisk, 'http: {}\n');

        const res = await request(httpServer)
          .post(`/settings/traefik/${route}`)
          .set('Cookie', session.cookie)
          .send({ traefikConfig: 'http:\n  routers: [\n' });

        expect(res.status).toBe(400);
        expect(refusal(res)).toMatch(
          new RegExp(
            `^${file.replace('.', '\\.')} is not valid YAML: .* at line \\d+, column \\d+$`,
          ),
        );
        expect(fs.readFileSync(onDisk, 'utf8')).toBe('http: {}\n');
      },
    );

    /**
     * At the route: a certificate's key and `acme.json` are refused by
     * name with 403, and an Application's htpasswd entry never leaves in the
     * body — the same route an Application's Advanced → Traefik configuration
     * card reads.
     */
    it('withholds key files and redacts htpasswd entries on GET /settings/traefik/file', async () => {
      const session = await signUp(httpServer, owner);
      const keyFile = path.join(
        traefikDir,
        'dynamic/certificates/certificate-x/privkey.key',
      );
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, 'key-bytes-never-served');
      fs.writeFileSync(path.join(traefikDir, 'dynamic/acme.json'), '{}');
      const appFile = path.join(traefikDir, 'dynamic/app-abc123.yml');
      fs.writeFileSync(
        appFile,
        'http:\n  middlewares:\n    auth-app-abc123:\n      basicAuth:\n        users:\n          - ui:$2a$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvwxyz01234\n',
      );
      const read = (file: string) =>
        request(httpServer)
          .get('/settings/traefik/file')
          .query({ path: file })
          .set('Cookie', session.cookie);

      const key = await read(keyFile);
      const acme = await read(path.join(traefikDir, 'dynamic/acme.json'));
      const app = await read(appFile);
      const tree = await request(httpServer)
        .get('/settings/traefik/directories')
        .set('Cookie', session.cookie);

      expect(key.status).toBe(403);
      expect(refusal(key)).toBe(
        'privkey.key holds private key material, which the console neither shows nor overwrites',
      );
      expect(key.text).not.toContain('key-bytes-never-served');
      expect(acme.status).toBe(403);
      expect(app.status).toBe(200);
      expect(app.text).toContain('ui:<redacted>');
      expect(app.text).not.toContain('$2');
      expect(JSON.stringify(tree.body)).toContain(
        '"name":"acme.json","type":"file","withheld"',
      );
    });
  });

  describe('docker resource operations', () => {
    // `RESOURCE_NAME=` and not `RESOURCE_NAME="…"`: the name is `quote()`d by
    // the builder now (H-92), and a `cloudgate`/`cloudgate-traefik` needs no
    // quoting, so `shell-quote` returns it unchanged and the double quotes went
    // with the interpolation they were guarding. The unit spec
    // (`test/settings/docker-resource.service.spec.ts`) carries why: inside
    // `"…"` a `$(…)` still substitutes, so that assignment was the one site of
    // the six that would have executed rather than word-split.
    const typeProbe = (name: string) => `
RESOURCE_NAME=${name}
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`;

    it('probes the docker resource type with the inspect script, locally and remotely', async () => {
      remoteExec.execAsync.mockResolvedValueOnce(ok('service\n'));
      expect(await dockerResources.getDockerResourceType('cloudgate')).toBe(
        'service',
      );
      expect(remoteExec.execAsync).toHaveBeenCalledWith(typeProbe('cloudgate'));

      remoteExec.execAsyncRemote.mockResolvedValueOnce(ok('standalone\n'));
      expect(
        await dockerResources.getDockerResourceType(
          'cloudgate-traefik',
          'srv-1',
        ),
      ).toBe('standalone');
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        'srv-1',
        typeProbe('cloudgate-traefik'),
      );

      // Probe failures read as unknown.
      remoteExec.execAsync.mockRejectedValueOnce(new Error('boom'));
      expect(await dockerResources.getDockerResourceType('cloudgate')).toBe(
        'unknown',
      );
    });

    it('reloads the cloudgate service with the versioned image', async () => {
      const version = CLOUDGATE_VERSION;
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(ok(''));

      await dockerResources.reloadDockerResource(
        'cloudgate',
        undefined,
        version,
      );

      expect(remoteExec.execAsync).toHaveBeenLastCalledWith(
        `docker service update --force --image cloudgate/cloudgate:${version} cloudgate`,
      );
    });

    it('reloads other resources without an image and restarts standalones', async () => {
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(ok(''));
      await dockerResources.reloadDockerResource('cloudgate-traefik');
      expect(remoteExec.execAsync).toHaveBeenLastCalledWith(
        'docker service update --force cloudgate-traefik',
      );

      remoteExec.execAsyncRemote
        .mockResolvedValueOnce(ok('standalone\n'))
        .mockResolvedValueOnce(ok(''));
      await dockerResources.reloadDockerResource('cloudgate-traefik', 'srv-1');
      expect(remoteExec.execAsyncRemote).toHaveBeenLastCalledWith(
        'srv-1',
        'docker restart cloudgate-traefik',
      );

      remoteExec.execAsync.mockResolvedValueOnce(ok('unknown\n'));
      await expect(
        dockerResources.reloadDockerResource('ghost'),
      ).rejects.toThrow('Resource type not found');
    });

    it('reads environment variables from the resource spec', async () => {
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(ok('["FOO=bar","BAZ=qux"]\n'));

      const env =
        await dockerResources.readEnvironmentVariables('cloudgate-traefik');
      expect(env).toBe('FOO=bar\nBAZ=qux');
      expect(remoteExec.execAsync).toHaveBeenLastCalledWith(
        "docker service inspect cloudgate-traefik --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'",
      );

      // A resource without env reads as the empty string.
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('standalone\n'))
        .mockResolvedValueOnce(ok('null\n'));
      expect(
        await dockerResources.readEnvironmentVariables('cloudgate-traefik'),
      ).toBe('');
    });

    it('reads service ports, dropping 80/443', async () => {
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(
          ok(
            JSON.stringify([
              { TargetPort: 80, PublishedPort: 80, Protocol: 'tcp' },
              { TargetPort: 443, PublishedPort: 443, Protocol: 'tcp' },
              { TargetPort: 8080, PublishedPort: 8080, Protocol: 'tcp' },
            ]),
          ),
        );

      const ports = await dockerResources.readPorts('cloudgate-traefik');
      expect(ports).toEqual([
        { targetPort: 8080, publishedPort: 8080, protocol: 'tcp' },
      ]);
      expect(remoteExec.execAsync).toHaveBeenLastCalledWith(
        "docker service inspect cloudgate-traefik --format '{{json .Spec.EndpointSpec.Ports}}'",
      );
    });

    it('reads standalone ports, deduping IPv4/IPv6 mappings', async () => {
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('standalone\n'))
        .mockResolvedValueOnce(
          ok(
            JSON.stringify({
              '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }],
              '9000/tcp': [
                { HostIp: '0.0.0.0', HostPort: '9000' },
                { HostIp: '::', HostPort: '9000' },
              ],
              '9443/udp': [{ HostIp: '0.0.0.0', HostPort: '9444' }],
            }),
          ),
        );

      const ports = await dockerResources.readPorts('cloudgate-traefik');
      expect(ports).toEqual([
        { targetPort: 9000, publishedPort: 9000, protocol: 'tcp' },
        { targetPort: 9443, publishedPort: 9444, protocol: 'udp' },
      ]);
    });

    it('checks whether a port is in use (container, host service, free)', async () => {
      // A container claims the port.
      remoteExec.execAsync.mockResolvedValueOnce(ok('nginx-proxy\n'));
      expect(await dockerResources.checkPortInUse(8080)).toEqual({
        isInUse: true,
        conflictingContainer: 'container "nginx-proxy"',
      });
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        `docker ps -a --format '{{.Names}}' | grep -v '^cloudgate-traefik$' | while read name; do docker port "$name" 2>/dev/null | grep -q ':8080' && echo "$name" && break; done || true`,
      );

      // No container, but a host-level listener.
      remoteExec.execAsync
        .mockResolvedValueOnce(ok(''))
        .mockResolvedValueOnce(ok('in_use\n'));
      expect(await dockerResources.checkPortInUse(8080)).toEqual({
        isInUse: true,
        conflictingContainer: 'a host-level service',
      });
      expect(remoteExec.execAsync).toHaveBeenLastCalledWith(
        `docker run --rm --net=host busybox sh -c 'nc -z 0.0.0.0 8080 2>/dev/null && echo in_use || echo free'`,
      );

      // Free — and probe errors also read as free.
      remoteExec.execAsync
        .mockResolvedValueOnce(ok(''))
        .mockResolvedValueOnce(ok('free\n'));
      expect(await dockerResources.checkPortInUse(8080)).toEqual({
        isInUse: false,
      });
    });
  });

  describe('traefik setup (writeTraefikSetup)', () => {
    it('recreates the standalone cloudgate-traefik container with ported settings', async () => {
      remoteExec.execAsync.mockResolvedValueOnce(ok('standalone\n'));
      const container = {
        remove: jest.fn<Promise<void>, [unknown?]>().mockResolvedValue(),
        start: jest.fn<Promise<void>, []>().mockResolvedValue(),
      };
      const docker = {
        pull: jest.fn<Promise<void>, [string]>().mockResolvedValue(),
        getContainer: jest.fn<unknown, [string]>().mockReturnValue(container),
        createContainer: jest
          .fn<Promise<void>, [Record<string, unknown>]>()
          .mockResolvedValue(),
      };
      dockerFactory.getRemoteDocker.mockResolvedValue(docker);

      await traefikSetup.writeTraefikSetup({
        env: ['FOO=bar'],
        additionalPorts: [
          { targetPort: 8080, publishedPort: 8080, protocol: 'tcp' },
        ],
      });

      expect(docker.pull).toHaveBeenCalledWith('traefik:v3.6.7');
      expect(container.remove).toHaveBeenCalledWith({ force: true });
      const created = docker.createContainer.mock.calls[0][0] as {
        name: string;
        Image: string;
        Env: string[];
        NetworkingConfig: unknown;
        ExposedPorts: Record<string, object>;
        HostConfig: {
          RestartPolicy: { Name: string };
          Binds: string[];
          PortBindings: Record<string, Array<{ HostPort: string }>>;
        };
      };
      expect(created.name).toBe('cloudgate-traefik');
      expect(created.Image).toBe('traefik:v3.6.7');
      expect(created.Env).toEqual(['FOO=bar']);
      expect(created.NetworkingConfig).toEqual({
        EndpointsConfig: { 'cloudgate-network': {} },
      });
      expect(created.ExposedPorts).toEqual({
        '80/tcp': {},
        '443/tcp': {},
        '443/udp': {},
        '8080/tcp': {},
      });
      expect(created.HostConfig.RestartPolicy).toEqual({ Name: 'always' });
      // No serverId, so each bind *source* is a path on the platform host and
      // sits under this process's own root, taken from the machine rather than
      // spelled. `writeTraefikSetup` resolves it itself rather than
      // through the injected `traefikDir`, which is why that is not it here.
      const platformTraefikDir = `${cloudgateDirectoryOn(null)}/traefik`;
      expect(created.HostConfig.Binds).toEqual([
        `${platformTraefikDir}/traefik.yml:/etc/traefik/traefik.yml`,
        // The target is the fixed in-container literal the static config's file
        // provider watches, and deliberately does not follow CLOUDGATE_DIRECTORY.
        `${platformTraefikDir}/dynamic:/etc/cloudgate/traefik/dynamic`,
        '/var/run/docker.sock:/var/run/docker.sock',
      ]);
      expect(created.HostConfig.PortBindings['8080/tcp']).toEqual([
        { HostPort: '8080' },
      ]);
      expect(container.start).toHaveBeenCalled();
    });

    it('updates the swarm service in place, bumping ForceUpdate', async () => {
      remoteExec.execAsync.mockResolvedValueOnce(ok('service\n'));
      const service = {
        inspect: jest.fn<Promise<unknown>, []>().mockResolvedValue({
          Version: { Index: '7' },
          Spec: { TaskTemplate: { ForceUpdate: 2 } },
        }),
        update: jest
          .fn<Promise<void>, [Record<string, unknown>]>()
          .mockResolvedValue(undefined),
      };
      const docker = {
        getService: jest.fn<unknown, [string]>().mockReturnValue(service),
        createService: jest.fn<Promise<void>, [unknown]>(),
      };
      dockerFactory.getRemoteDocker.mockResolvedValue(docker);

      await traefikSetup.writeTraefikSetup({ env: [], additionalPorts: [] });

      expect(docker.getService).toHaveBeenCalledWith('cloudgate-traefik');
      const update = service.update.mock.calls[0][0] as {
        version: number;
        Name: string;
        TaskTemplate: {
          ForceUpdate: number;
          ContainerSpec: { Image: string; Mounts: unknown[] };
          Networks: unknown[];
        };
        EndpointSpec: { Ports: unknown[] };
      };
      expect(update.version).toBe(7);
      expect(update.Name).toBe('cloudgate-traefik');
      expect(update.TaskTemplate.ForceUpdate).toBe(3);
      expect(update.TaskTemplate.Networks).toEqual([
        { Target: 'cloudgate-network' },
      ]);
      expect(update.EndpointSpec.Ports).toEqual([
        {
          TargetPort: 443,
          PublishedPort: 443,
          PublishMode: 'host',
          Protocol: 'tcp',
        },
        {
          TargetPort: 443,
          PublishedPort: 443,
          PublishMode: 'host',
          Protocol: 'udp',
        },
        {
          TargetPort: 80,
          PublishedPort: 80,
          PublishMode: 'host',
          Protocol: 'tcp',
        },
      ]);
      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('reconnects isolated compose stacks to traefik after the rewrite', async () => {
      const session = await signUp(httpServer, owner);
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;

      const [project] = await ctx.db
        .insert(schema.project)
        .values({ name: 'p1', organizationId })
        .returning();
      const [environment] = await ctx.db
        .insert(schema.environment)
        .values({ name: 'production', projectId: project.projectId })
        .returning();
      await ctx.db.insert(schema.compose).values({
        name: 'stack',
        appName: 'isolated-stack',
        environmentId: environment.environmentId,
        configName: seededConfigName(),
        isolatedDeployment: true,
      });

      remoteExec.execAsync.mockResolvedValueOnce(ok('standalone\n'));
      const docker = {
        pull: jest.fn().mockResolvedValue(undefined),
        getContainer: jest.fn().mockReturnValue({
          remove: jest.fn().mockResolvedValue(undefined),
          start: jest.fn().mockResolvedValue(undefined),
        }),
        createContainer: jest.fn().mockResolvedValue(undefined),
      };
      dockerFactory.getRemoteDocker.mockResolvedValue(docker);

      await traefikSetup.writeTraefikSetup({ env: [], additionalPorts: [] });

      const reconnect = remoteExec.execAsync.mock.calls.at(-1)?.[0] as string;
      expect(reconnect).toContain(
        'docker network connect isolated-stack $(docker ps --filter "name=cloudgate-traefik" -q) >/dev/null 2>&1',
      );
    });
  });

  describe('reload endpoints', () => {
    it('POST /settings/reload-server force-updates the cloudgate service (admin)', async () => {
      const session = await signUp(httpServer, owner);
      const version = CLOUDGATE_VERSION;
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(ok(''));

      const res = await request(httpServer)
        .post('/settings/reload-server')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(remoteExec.execAsync).toHaveBeenLastCalledWith(
        `docker service update --force --image cloudgate/cloudgate:${version} cloudgate`,
      );

      const memberSession = await signUpMember(httpServer, session.cookie);
      const denied = await request(httpServer)
        .post('/settings/reload-server')
        .set('Cookie', memberSession.cookie);
      expect(denied.status).toBe(403);
      // Restarting the backend is the platform host's own lifecycle (H-63).
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
    });

    it('POST /settings/traefik/reload kicks the traefik reload in the background', async () => {
      const session = await signUp(httpServer, owner);
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(ok(''));

      const res = await request(httpServer)
        .post('/settings/traefik/reload')
        .set('Cookie', session.cookie)
        .send({});
      expect(res.status).toBe(200);

      // The reload runs as a fire-and-forget promise; give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(remoteExec.execAsync).toHaveBeenLastCalledWith(
        'docker service update --force cloudgate-traefik',
      );
    });

    it('POST /settings/traefik/dashboard conflicts when port 8080 is taken', async () => {
      const session = await signUp(httpServer, owner);
      // readPorts probe (service) + ports json + env probe + env json,
      // then checkPortInUse finds a container squatting on 8080.
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(ok('null'))
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(ok('["A=1"]'))
        .mockResolvedValueOnce(ok('rogue-app\n'));

      const res = await request(httpServer)
        .post('/settings/traefik/dashboard')
        .set('Cookie', session.cookie)
        .send({ enableDashboard: true });

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'Port 8080 is already in use by container "rogue-app". Please stop the conflicting service or use a different port for the Traefik dashboard.',
      );
    });

    it('writes and removes the api block the published port answers from', async () => {
      // The switch published 8080 and nothing listened on it, because
      // `api` is static configuration and traefik.yml has none. The recreate
      // the toggle already performs is the restart that reads it.
      const session = await signUp(httpServer, owner);
      const configPath = path.join(traefikDir, 'traefik.yml');
      fs.writeFileSync(
        configPath,
        'entryPoints:\n  web:\n    address: ":80"\n',
      );

      // readPorts probe + ports json, env probe + env json, then a free 8080.
      const toggleReads = () =>
        remoteExec.execAsync
          .mockResolvedValueOnce(ok('service\n'))
          .mockResolvedValueOnce(ok('null'))
          .mockResolvedValueOnce(ok('service\n'))
          .mockResolvedValueOnce(ok('["A=1"]'))
          .mockResolvedValueOnce(ok(''));

      toggleReads();
      const on = await request(httpServer)
        .post('/settings/traefik/dashboard')
        .set('Cookie', session.cookie)
        .send({ enableDashboard: true });
      expect(on.status).toBe(200);
      expect(
        (parse(fs.readFileSync(configPath, 'utf8')) as { api?: unknown }).api,
      ).toEqual({ dashboard: true, insecure: true });

      toggleReads();
      const off = await request(httpServer)
        .post('/settings/traefik/dashboard')
        .set('Cookie', session.cookie)
        .send({ enableDashboard: false });
      expect(off.status).toBe(200);
      expect(parse(fs.readFileSync(configPath, 'utf8'))).not.toHaveProperty(
        'api',
      );
    });

    it('takes 8080 back on a host with no traefik.yml, where publishing it is refused', async () => {
      // The `api` write refuses a host it cannot edit — but only on the
      // way on. Refusing it both ways would leave 8080 published with no way to
      // withdraw it, which is the one direction that always used to work.
      const session = await signUp(httpServer, owner);
      expect(fs.existsSync(path.join(traefikDir, 'traefik.yml'))).toBe(false);
      const setup = jest
        .spyOn(traefikSetup, 'writeTraefikSetup')
        .mockResolvedValue(undefined);

      // readPorts probe + ports json, with 8080 already published, then the
      // env probe and env json.
      const toggleReads = () =>
        remoteExec.execAsync
          .mockResolvedValueOnce(ok('service\n'))
          .mockResolvedValueOnce(
            ok('[{"TargetPort":8080,"PublishedPort":8080,"Protocol":"tcp"}]'),
          )
          .mockResolvedValueOnce(ok('service\n'))
          .mockResolvedValueOnce(ok('["A=1"]'));

      toggleReads();
      const off = await request(httpServer)
        .post('/settings/traefik/dashboard')
        .set('Cookie', session.cookie)
        .send({ enableDashboard: false });
      expect(off.status).toBe(200);
      // The recreate is fire-and-forget; give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup).toHaveBeenCalledWith(
        expect.objectContaining({ additionalPorts: [] }),
      );

      // The other arm, unchanged: no config to write `api` into, so the port is
      // not published either — the two halves never disagree.
      toggleReads();
      remoteExec.execAsync.mockResolvedValueOnce(ok(''));
      const on = await request(httpServer)
        .post('/settings/traefik/dashboard')
        .set('Cookie', session.cookie)
        .send({ enableDashboard: true });
      expect(on.status).toBe(404);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup).toHaveBeenCalledTimes(1);

      setup.mockRestore();
    });

    it('reads the traefik env and dashboard state over HTTP', async () => {
      const session = await signUp(httpServer, owner);

      remoteExec.execAsync
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(ok('["TRAEFIK_A=1"]'));
      const env = await request(httpServer)
        .get('/settings/traefik/env')
        .set('Cookie', session.cookie);
      expect(env.status).toBe(200);
      expect(env.text).toBe('TRAEFIK_A=1');

      remoteExec.execAsync
        .mockResolvedValueOnce(ok('service\n'))
        .mockResolvedValueOnce(
          ok(JSON.stringify([{ TargetPort: 8080, PublishedPort: 8080 }])),
        );
      const dashboard = await request(httpServer)
        .get('/settings/traefik/dashboard')
        .set('Cookie', session.cookie);
      expect(dashboard.status).toBe(200);
      expect(dashboard.text).toBe('true');
    });
  });

  describe('assign domain', () => {
    it('assigns the dashboard domain: settings, cloudgate config, acme email', async () => {
      const session = await signUp(httpServer, owner);
      fs.writeFileSync(
        path.join(traefikDir, 'traefik.yml'),
        'certificatesResolvers:\n  letsencrypt:\n    acme:\n      email: test@localhost.com\n      storage: /etc/cloudgate/traefik/dynamic/acme.json\n',
      );
      traefikWriter.loadOrCreateConfig.mockResolvedValue({
        http: { routers: {}, services: {} },
      });

      const res = await request(httpServer)
        .post('/settings/assign-domain')
        .set('Cookie', session.cookie)
        .send({
          host: 'panel.example.com',
          certificateType: 'letsencrypt',
          https: true,
          letsEncryptEmail: 'ops@example.com',
        });
      expect(res.status).toBe(200);

      const row = await settings.getWebServerSettings();
      expect(row.host).toBe('panel.example.com');
      expect(row.certificateType).toBe('letsencrypt');
      expect(row.https).toBe(true);
      expect(row.letsEncryptEmail).toBe('ops@example.com');

      const [appName, written] = traefikWriter.writeConfig.mock.calls[0];
      expect(appName).toBe('cloudgate');
      expect(written.http?.routers?.['cloudgate-router-app']).toMatchObject({
        rule: 'Host(`panel.example.com`)',
        middlewares: ['redirect-to-https'],
      });
      /**
       * The upstream is the console's own origin, resolved from the
       * install contract. It used to be `http://cloudgate:${PORT}` — a
       * container that does not exist on a native install, named on the API's
       * port rather than the console's, so the written file 502'd.
       */
      expect(
        written.http?.services?.['cloudgate-service-app']?.loadBalancer
          ?.servers?.[0]?.url,
      ).toBe(`http://${CONSOLE_HOST}:${CONSOLE_PORT}`);
      expect(
        written.http?.routers?.['cloudgate-router-app-secure'],
      ).toMatchObject({
        rule: 'Host(`panel.example.com`)',
        entryPoints: ['websecure'],
        tls: { certResolver: 'letsencrypt' },
      });

      const mainConfig = parse(
        fs.readFileSync(path.join(traefikDir, 'traefik.yml'), 'utf8'),
      ) as {
        certificatesResolvers: { letsencrypt: { acme: { email: string } } };
      };
      expect(mainConfig.certificatesResolvers.letsencrypt.acme.email).toBe(
        'ops@example.com',
      );
    });

    it('denies members and leaves the acme email alone when none is sent', async () => {
      const session = await signUp(httpServer, owner);
      const memberSession = await signUpMember(httpServer, session.cookie);
      traefikWriter.loadOrCreateConfig.mockResolvedValue({
        http: { routers: {}, services: {} },
      });

      const denied = await request(httpServer)
        .post('/settings/assign-domain')
        .set('Cookie', memberSession.cookie)
        .send({ host: 'evil.example.com', certificateType: 'none' });
      expect(denied.status).toBe(403);
      // `assign-domain` is the structured writer of `dynamic/cloudgate.yml`,
      // so it moved to the instance gate with the raw one (H-52).
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);

      const res = await request(httpServer)
        .post('/settings/assign-domain')
        .set('Cookie', session.cookie)
        .send({ host: 'plain.example.com', certificateType: 'none' });
      expect(res.status).toBe(200);
      // No https: both secure routers are dropped and middlewares cleared.
      // The Gateway's plain router rides the console's host beside the
      // console's own (ADR-0040), so it is the one other router left.
      const [, written] = traefikWriter.writeConfig.mock.calls[0];
      expect(Object.keys(written.http?.routers ?? {}).sort()).toEqual([
        'cloudgate-router-app',
        'cloudgate-router-gateway',
      ]);
      expect(written.http?.routers?.['cloudgate-router-gateway']).toMatchObject(
        { middlewares: [] },
      );
      expect(written.http?.routers?.['cloudgate-router-app']).toMatchObject({
        rule: 'Host(`plain.example.com`)',
        middlewares: [],
      });
    });

    /**
     * `hostSchema`'s two refusals, written out rather than imported: a test that
     * reads the expectation off the schema under test proves nothing (§1.7).
     */
    const INVALID_HOST_REFUSAL =
      'Invalid domain name. Use only letters, numbers, hyphens and dots (e.g. example.com). Underscores are not allowed.';
    const UNTRIMMED_HOST_REFUSAL =
      'Domain name cannot have leading or trailing spaces';

    /**
     * Every field-level refusal the exception filter rendered for one field —
     * `details`, not the bare 400, because the point of holding the console's
     * host to `hostSchema` is that the operator is told *which box is wrong* and
     * what is wrong with it.
     */
    const refusalsFor = (body: unknown, field: string): string[] =>
      (
        (body as { details?: { path: string; message: string }[] }).details ??
        []
      )
        .filter((detail) => detail.path === field)
        .map((detail) => detail.message);

    /**
     * The console's own host reaches ``Host(`<host>`)`` in
     * `traefik/config/web-server.ts` the way a Domain's reaches the compose
     * label builder. The caller here is an owner and the settings surface
     * already lets them write `traefik.yml` by hand, so this is the robustness
     * half of the host rule, not its security half: an unroutable console is what the
     * refusal prevents.
     */
    it('refuses a console host carrying a backtick, naming the host field', async () => {
      const session = await signUp(httpServer, owner);
      traefikWriter.loadOrCreateConfig.mockResolvedValue({
        http: { routers: {}, services: {} },
      });

      const res = await request(httpServer)
        .post('/settings/assign-domain')
        .set('Cookie', session.cookie)
        .send({
          host: 'panel.example.com`)||Host(`any.com',
          https: true,
          certificateType: 'none',
        });

      expect(res.status).toBe(400);
      expect(refusalsFor(res.body, 'host')).toEqual([INVALID_HOST_REFUSAL]);
      // Nothing was stored and no router was written on the way to being
      // refused.
      expect((await settings.getWebServerSettings()).host).toBeNull();
      expect(traefikWriter.writeConfig).not.toHaveBeenCalled();
    });

    it('refuses a plainly malformed console host', async () => {
      const session = await signUp(httpServer, owner);
      traefikWriter.loadOrCreateConfig.mockResolvedValue({
        http: { routers: {}, services: {} },
      });

      // A space, one label, an underscore, and a label ending in `-` — which
      // RFC 1123 forbids and Traefik answers by dropping the router, the silent
      // failure this rule exists to turn into a 400. The last one is refused
      // rather than trimmed, which is `hostSchema`'s own answer to leading
      // whitespace and now the console's too.
      const cases: [string, string][] = [
        ['not a hostname', INVALID_HOST_REFUSAL],
        ['console', INVALID_HOST_REFUSAL],
        ['my_panel.example.com', INVALID_HOST_REFUSAL],
        ['app-a1b-.sslip.io', INVALID_HOST_REFUSAL],
        [' panel.example.com ', UNTRIMMED_HOST_REFUSAL],
      ];

      for (const [host, message] of cases) {
        const res = await request(httpServer)
          .post('/settings/assign-domain')
          .set('Cookie', session.cookie)
          .send({ host, certificateType: 'none' });

        expect(res.status).toBe(400);
        expect(refusalsFor(res.body, 'host')).toEqual([message]);
      }

      expect((await settings.getWebServerSettings()).host).toBeNull();
      expect(traefikWriter.writeConfig).not.toHaveBeenCalled();
    });

    /**
     * The regression this rule had to leave alone. An empty host is not a bad
     * host: `updateServerTraefik` reads it as "the console has no domain" and
     * calls `removeConfig('cloudgate')`, which *deletes*
     * `dynamic/cloudgate.yml`. That is the only way an operator unassigns
     * the console domain, and the console's card offers it as one.
     */
    it('accepts an empty console host, and clearing it drops the router config', async () => {
      const session = await signUp(httpServer, owner);
      traefikWriter.loadOrCreateConfig.mockResolvedValue({
        http: { routers: {}, services: {} },
      });

      const assigned = await request(httpServer)
        .post('/settings/assign-domain')
        .set('Cookie', session.cookie)
        .send({ host: 'panel.example.com', certificateType: 'none' });
      expect(assigned.status).toBe(200);
      expect(traefikWriter.writeConfig).toHaveBeenCalledTimes(1);

      const cleared = await request(httpServer)
        .post('/settings/assign-domain')
        .set('Cookie', session.cookie)
        .send({ host: '', certificateType: 'none' });

      expect(cleared.status).toBe(200);
      expect((cleared.body as { host: string }).host).toBe('');
      expect((await settings.getWebServerSettings()).host).toBe('');
      expect(traefikWriter.removeConfig).toHaveBeenCalledWith(
        'cloudgate',
        null,
        {
          platformOwned: true,
        },
      );
      // The file was dropped rather than rewritten: no second router went out.
      expect(traefikWriter.writeConfig).toHaveBeenCalledTimes(1);
    });

    it('takes a console host a person would actually write, unchanged', async () => {
      const session = await signUp(httpServer, owner);
      traefikWriter.loadOrCreateConfig.mockResolvedValue({
        http: { routers: {}, services: {} },
      });

      const res = await request(httpServer)
        .post('/settings/assign-domain')
        .set('Cookie', session.cookie)
        .send({ host: 'panel-2.eu.example.com', certificateType: 'none' });

      expect(res.status).toBe(200);
      expect((res.body as { host: string }).host).toBe(
        'panel-2.eu.example.com',
      );
      expect((await settings.getWebServerSettings()).host).toBe(
        'panel-2.eu.example.com',
      );
      const [, written] = traefikWriter.writeConfig.mock.calls[0];
      expect(written.http?.routers?.['cloudgate-router-app']).toMatchObject({
        rule: 'Host(`panel-2.eu.example.com`)',
      });
    });
  });

  /**
   * H-25. An earlier fix put the console-host rule on `AssignDomainDto` and
   * `updateServerTraefik` takes its host from the caller, never from the row —
   * so every *write* is safe and a host stored before the rule existed is never
   * shown to it again. The injected ``Host(`…`)`` sits in
   * `dynamic/cloudgate.yml` unread and unrewritten, and nothing detects it.
   *
   * The mirror image of X05-1, and it needs the opposite mechanism: an
   * emitter guard cannot see a value no emitter reads, so the sweep is the seam
   * and boot is when it runs. What is asserted here is the sweep itself rather
   * than `onApplicationBootstrap`, because the harness boots the app before a
   * test can plant a row — the hook is three lines of try/catch over this.
   */
  describe('sweepConsoleHost', () => {
    /** Stores a host directly, the way a pre-fix write would have left one. */
    const storeConsoleHost = async (host: string) => {
      const row = await settings.getWebServerSettings();
      await ctx.db.$client.query(
        'update web_server_settings set host = $1 where id = $2',
        [host, row.id],
      );
    };

    it('takes a poisoned console host out of the file provider and clears it', async () => {
      await storeConsoleHost(
        'console.example.com`) || Host(`victim.example.com',
      );

      await settings.sweepConsoleHost();

      expect(traefikWriter.removeConfig).toHaveBeenCalledWith(
        'cloudgate',
        null,
        {
          platformOwned: true,
        },
      );
      expect((await settings.getWebServerSettings()).host).toBeNull();
      // Not repaired, and not re-emitted: the injected half is attacker-chosen
      // and a salvaged router is a router nobody decided on.
      expect(traefikWriter.writeConfig).not.toHaveBeenCalled();
    });

    it('leaves an ordinary empty install alone', async () => {
      // X05-3: `host` is empty on a default install and an unset console host
      // deliberately reserves nothing, so this must not read as poisoned.
      await settings.sweepConsoleHost();
      expect(traefikWriter.removeConfig).not.toHaveBeenCalled();

      await storeConsoleHost('');
      await settings.sweepConsoleHost();
      expect(traefikWriter.removeConfig).not.toHaveBeenCalled();
      expect((await settings.getWebServerSettings()).host).toBe('');
    });

    it('leaves an assigned console host alone', async () => {
      await storeConsoleHost('panel.example.com');

      await settings.sweepConsoleHost();

      expect(traefikWriter.removeConfig).not.toHaveBeenCalled();
      expect((await settings.getWebServerSettings()).host).toBe(
        'panel.example.com',
      );
    });
  });

  /**
   * An install that assigned its console domain before the Gateway existed
   * gets its `/ai` routers at the next boot, not at the next save of the
   * domain (ADR-0040). Asserted on the method the boot hook calls, for
   * `sweepConsoleHost`'s reason: the harness boots before a row can be planted.
   */
  describe('reconcileGatewayRouters', () => {
    const storeConsoleHost = async (host: string) => {
      const row = await settings.getWebServerSettings();
      await ctx.db.$client.query(
        'update web_server_settings set host = $1 where id = $2',
        [host, row.id],
      );
    };

    it('writes the gateway routers beside a console domain assigned before them', async () => {
      await storeConsoleHost('panel.example.com');
      traefikWriter.loadOrCreateConfig.mockResolvedValue({
        http: {
          routers: {
            'cloudgate-router-app': {
              rule: 'Host(`panel.example.com`)',
              service: 'cloudgate-service-app',
              entryPoints: ['web'],
            },
          },
          services: {},
        },
      });

      await settings.reconcileGatewayRouters();

      const [file, written] = traefikWriter.writeConfig.mock.calls[0];
      expect(file).toBe('cloudgate');
      expect(written.http?.routers?.['cloudgate-router-gateway']).toMatchObject(
        { rule: 'Host(`panel.example.com`) && PathPrefix(`/ai/`)' },
      );
    });

    it('leaves a file that already routes the gateway, and an install with no console domain, alone', async () => {
      await settings.reconcileGatewayRouters();
      expect(traefikWriter.loadOrCreateConfig).not.toHaveBeenCalled();

      await storeConsoleHost('panel.example.com');
      traefikWriter.loadOrCreateConfig.mockResolvedValue({
        http: {
          routers: {
            'cloudgate-router-gateway': {
              rule: 'Host(`panel.example.com`) && PathPrefix(`/ai/`)',
              service: 'cloudgate-service-gateway',
              entryPoints: ['web'],
            },
          },
          services: {},
        },
      });
      await settings.reconcileGatewayRouters();
      expect(traefikWriter.writeConfig).not.toHaveBeenCalled();
    });
  });

  describe('log cleanup', () => {
    it('starts and stops the access-log cleanup cron, persisting the schedule', async () => {
      const session = await signUp(httpServer, owner);
      const scheduling = ctx.app.get(SchedulingService);

      const start = await request(httpServer)
        .post('/settings/log-cleanup')
        .set('Cookie', session.cookie)
        .send({ cronExpression: '0 3 * * *' });
      expect(start.status).toBe(200);
      expect(start.text).toBe('true');
      expect(scheduling.has('access-log-cleanup')).toBe(true);
      expect((await settings.getWebServerSettings()).logCleanupCron).toBe(
        '0 3 * * *',
      );

      const status = await request(httpServer)
        .get('/settings/log-cleanup')
        .set('Cookie', session.cookie);
      expect(status.body).toEqual({
        enabled: true,
        cronExpression: '0 3 * * *',
      });

      const stop = await request(httpServer)
        .post('/settings/log-cleanup')
        .set('Cookie', session.cookie)
        .send({ cronExpression: null });
      expect(stop.status).toBe(200);
      expect(scheduling.has('access-log-cleanup')).toBe(false);

      const stopped = await request(httpServer)
        .get('/settings/log-cleanup')
        .set('Cookie', session.cookie);
      expect(stopped.body).toEqual({ enabled: false, cronExpression: null });
    });

    // It used to run `tail -n 1000 > tmp && mv` — bounding the file by deleting
    // every request older than the last thousand, once a day, silently. It now
    // rotates past ACCESS_LOG_MAX_BYTES instead, so the file the request-analytics
    // reader walks is still bounded but the history is beside it.
    it('the cleanup job rotates an oversized access log and signals traefik', async () => {
      const accessLog = path.join(traefikDir, 'dynamic', 'access.log');
      fs.writeFileSync(accessLog, 'x'.repeat(ACCESS_LOG_MAX_BYTES + 1));
      remoteExec.execAsync
        .mockResolvedValueOnce(ok('abc123\n'))
        .mockResolvedValueOnce(ok(''));

      await logCleanup.runCleanup();

      expect(fs.existsSync(accessLog)).toBe(false);
      expect(fs.statSync(`${accessLog}.1`).size).toBe(ACCESS_LOG_MAX_BYTES + 1);
      expect(remoteExec.execAsync).toHaveBeenNthCalledWith(
        1,
        'docker ps -q --filter "name=cloudgate-traefik" --filter "status=running" | head -n 1',
      );
      expect(remoteExec.execAsync).toHaveBeenNthCalledWith(
        2,
        'docker exec abc123 kill -USR1 1',
      );
    });

    // The old job truncated whatever it found, so a small log lost its history
    // for nothing. SIGUSR1 makes Traefik drop and reopen a file handle, which is
    // not something to do to a log that is nowhere near its limit.
    it('the cleanup job leaves an access log under the limit alone', async () => {
      const accessLog = path.join(traefikDir, 'dynamic', 'access.log');
      fs.writeFileSync(accessLog, '{}\n');

      await logCleanup.runCleanup();

      expect(fs.readFileSync(accessLog, 'utf8')).toBe('{}\n');
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('the cleanup job is a no-op while the access log does not exist', async () => {
      await logCleanup.runCleanup();
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });
  });

  describe('deployment queue', () => {
    it('POST /settings/clean-deployment-queue clears waiting jobs (admin)', async () => {
      const session = await signUp(httpServer, owner);
      const queue = ctx.app.get<QueuePort>(DEPLOYMENT_QUEUE);
      const clearSpy = jest.spyOn(queue, 'clearWaiting');

      const res = await request(httpServer)
        .post('/settings/clean-deployment-queue')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(clearSpy).toHaveBeenCalled();

      const memberSession = await signUpMember(httpServer, session.cookie);
      const denied = await request(httpServer)
        .post('/settings/clean-deployment-queue')
        .set('Cookie', memberSession.cookie);
      expect(denied.status).toBe(403);
      // The queue is the instance's, not an organization's (H-63).
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
    });
  });

  describe('docker cleanup ops', () => {
    it('prunes images over HTTP behind the docker-busy guard (admin)', async () => {
      const session = await signUp(httpServer, owner);

      const res = await request(httpServer)
        .post('/settings/cleanup/images')
        .set('Cookie', session.cookie)
        .send({});
      expect(res.status).toBe(200);

      const command = remoteExec.execAsync.mock.calls[0][0];
      expect(command).toContain('docker image prune --all --force');
      // The wait-until-docker-is-idle loop.
      expect(command).toContain('Docker is busy. Will check again');

      const memberSession = await signUpMember(httpServer, session.cookie);
      const denied = await request(httpServer)
        .post('/settings/cleanup/images')
        .set('Cookie', memberSession.cookie)
        .send({});
      expect(denied.status).toBe(403);
      // No `serverId`, so this prunes the platform host (H-63).
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
    });

    it('runs the remaining cleanup endpoints with their prune commands', async () => {
      const session = await signUp(httpServer, owner);
      const cases: Array<[string, string]> = [
        ['volumes', 'docker volume prune --all --force'],
        ['stopped-containers', 'docker container prune --force'],
        ['docker-builder', 'docker builder prune --all --force'],
      ];

      for (const [route, command] of cases) {
        remoteExec.execAsync.mockClear();
        const res = await request(httpServer)
          .post(`/settings/cleanup/${route}`)
          .set('Cookie', session.cookie)
          .send({});
        expect(res.status).toBe(200);
        expect(remoteExec.execAsync.mock.calls[0][0]).toContain(command);
      }

      // docker-prune = system prune + builder prune.
      remoteExec.execAsync.mockClear();
      const prune = await request(httpServer)
        .post('/settings/cleanup/docker-prune')
        .set('Cookie', session.cookie)
        .send({});
      expect(prune.status).toBe(200);
      expect(remoteExec.execAsync.mock.calls[0][0]).toContain(
        'docker system prune --all --force',
      );
      expect(remoteExec.execAsync.mock.calls[1][0]).toContain(
        'docker builder prune --all --force',
      );
    });

    it('cleanupAll skips volumes and runs on remote servers', async () => {
      const commands: string[] = [];
      remoteExec.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) => {
          commands.push(command);
          return Promise.resolve(ok(''));
        },
      );

      await cleanup.cleanupAll('srv-1');

      expect(commands).toHaveLength(4);
      expect(commands[0]).toContain('docker container prune --force');
      expect(commands[1]).toContain('docker image prune --all --force');
      expect(commands[2]).toContain('docker builder prune --all --force');
      expect(commands[3]).toContain('docker system prune --all --force');
      expect(commands.join('\n')).not.toContain('volume prune');
    });

    it('reports docker disk usage from docker system df json lines', async () => {
      const session = await signUp(httpServer, owner);
      remoteExec.execAsync.mockResolvedValueOnce(
        ok(
          [
            '{"Active":"5","Reclaimable":"1.2GB (40%)","Size":"3GB","TotalCount":"12","Type":"Images"}',
            '{"Active":"3","Reclaimable":"0B (0%)","Size":"512MB","TotalCount":"3","Type":"Containers"}',
          ].join('\n'),
        ),
      );

      const res = await request(httpServer)
        .get('/settings/docker-disk-usage')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        "docker system df --format '{{json .}}'",
      );
      expect(res.body).toEqual([
        {
          type: 'Images',
          totalCount: 12,
          active: 5,
          size: '3GB',
          reclaimable: '1.2GB (40%)',
          sizeBytes: 3 * 1024 ** 3,
        },
        {
          type: 'Containers',
          totalCount: 3,
          active: 3,
          size: '512MB',
          reclaimable: '0B (0%)',
          sizeBytes: 512 * 1024 ** 2,
        },
      ]);
    });

    /**
     * The third review comment. The directory was the live stream's scratch series
     * (gone) — nothing ever read it back — so emptying it cleared
     * nothing any screen draws, while the card promised "the
     * Monitoring screen's history starts again from now". That history is the
     * platform host's `server_metric` / `container_metric` rows (`serverId`
     * null), and they are what this control now deletes too. A Server's rows
     * are its Organization's and stay: they are pruned by that Server's own
     * retention, stopped or not.
     */
    it("deletes the platform host's stored samples, and no Server's", async () => {
      const session = await signUp(httpServer, owner);
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const [remote] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId,
        })
        .returning();
      const sample = (serverId: string | null) => ({
        timestamp: new Date().toISOString(),
        cpu: 1,
        cpuModel: '',
        cpuCores: 1,
        cpuPhysicalCores: 1,
        cpuSpeed: 0,
        os: '',
        distro: '',
        kernel: '',
        arch: '',
        memUsed: 0,
        memUsedGB: 0,
        memTotal: 0,
        uptime: 0,
        diskUsed: 0,
        totalDisk: 0,
        networkIn: 0,
        networkOut: 0,
        serverId,
      });
      const container = (serverId: string | null) => ({
        timestamp: new Date().toISOString(),
        containerId: 'a',
        containerName: 'web',
        metrics: {},
        serverId,
      });
      await ctx.db
        .insert(schema.serverMetric)
        .values([sample(null), sample(null), sample(remote.serverId)]);
      await ctx.db
        .insert(schema.containerMetric)
        .values([container(null), container(remote.serverId)]);

      const res = await request(httpServer)
        .post('/settings/cleanup/monitoring')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);

      const servers = await ctx.db.select().from(schema.serverMetric);
      expect(servers.map((row) => row.serverId)).toEqual([remote.serverId]);
      const containers = await ctx.db.select().from(schema.containerMetric);
      expect(containers.map((row) => row.serverId)).toEqual([remote.serverId]);
    });

    it('org-scopes serverId cleanups: cross-org 404, owned goes over SSH', async () => {
      const session = await signUp(httpServer, owner);
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;

      const [ownServer] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId,
        })
        .returning();

      const crossOrg = await request(httpServer)
        .post('/settings/cleanup/images')
        .set('Cookie', session.cookie)
        .send({ serverId: 'srv-of-someone-else' });
      expect(crossOrg.status).toBe(404);

      const owned = await request(httpServer)
        .post('/settings/cleanup/images')
        .set('Cookie', session.cookie)
        .send({ serverId: ownServer.serverId });
      expect(owned.status).toBe(200);
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        ownServer.serverId,
        expect.stringContaining('docker image prune --all --force'),
      );
    });
  });

  describe('docker cleanup cron (updateDockerCleanup)', () => {
    it('toggles the local docker-cleanup cron and persists the flag', async () => {
      const session = await signUp(httpServer, owner);
      const scheduling = ctx.app.get(SchedulingService);

      const enable = await request(httpServer)
        .post('/settings/docker-cleanup')
        .set('Cookie', session.cookie)
        .send({ enableDockerCleanup: true });
      expect(enable.status).toBe(200);
      expect(scheduling.has('docker-cleanup')).toBe(true);
      expect((await settings.getWebServerSettings()).enableDockerCleanup).toBe(
        true,
      );

      const disable = await request(httpServer)
        .post('/settings/docker-cleanup')
        .set('Cookie', session.cookie)
        .send({ enableDockerCleanup: false });
      expect(disable.status).toBe(200);
      expect(scheduling.has('docker-cleanup')).toBe(false);
    });

    it('toggles a per-server cleanup cron, org-scoped and active-only', async () => {
      const session = await signUp(httpServer, owner);
      const scheduling = ctx.app.get(SchedulingService);
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;

      const [row] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId,
        })
        .returning();

      const enable = await request(httpServer)
        .post('/settings/docker-cleanup')
        .set('Cookie', session.cookie)
        .send({ enableDockerCleanup: true, serverId: row.serverId });
      expect(enable.status).toBe(200);
      expect(scheduling.has(`docker-cleanup:${row.serverId}`)).toBe(true);
      const [updated] = await ctx.db
        .select()
        .from(schema.server)
        .where(sql`server_id = ${row.serverId}`);
      expect(updated.enableDockerCleanup).toBe(true);

      const disable = await request(httpServer)
        .post('/settings/docker-cleanup')
        .set('Cookie', session.cookie)
        .send({ enableDockerCleanup: false, serverId: row.serverId });
      expect(disable.status).toBe(200);
      expect(scheduling.has(`docker-cleanup:${row.serverId}`)).toBe(false);

      // Unknown/cross-org server: NotFound before anything is written.
      const crossOrg = await request(httpServer)
        .post('/settings/docker-cleanup')
        .set('Cookie', session.cookie)
        .send({ enableDockerCleanup: true, serverId: 'not-mine' });
      expect(crossOrg.status).toBe(404);

      // Inactive servers cannot enable cleanup ('Server is inactive').
      await ctx.db
        .update(schema.server)
        .set({ serverStatus: 'inactive' })
        .where(sql`server_id = ${row.serverId}`);
      const inactive = await request(httpServer)
        .post('/settings/docker-cleanup')
        .set('Cookie', session.cookie)
        .send({ enableDockerCleanup: true, serverId: row.serverId });
      expect(inactive.status).toBe(404);
      expect((inactive.body as { message: string }).message).toBe(
        'Server is inactive',
      );
    });

    it('the cleanup jobs prune docker and notify the right audience', async () => {
      const session = await signUp(httpServer, owner);
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue(undefined);

      // Local job: cleans the web server and notifies instance-wide.
      await dockerCleanup.runLocalCleanup();
      expect(
        remoteExec.execAsync.mock.calls.some((call) =>
          call[0].includes('docker system prune --all --force'),
        ),
      ).toBe(true);
      expect(dispatchSpy).toHaveBeenCalledWith(null, {
        type: 'docker-cleanup',
        message: 'Docker cleanup for Cloudgate',
      });

      // Per-server job: cleans over SSH and notifies the owning org.
      const [row] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId,
        })
        .returning();
      await dockerCleanup.runServerCleanup(row.serverId);
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        row.serverId,
        expect.stringContaining('docker container prune --force'),
      );
      expect(dispatchSpy).toHaveBeenCalledWith(organizationId, {
        type: 'docker-cleanup',
        message: `Docker cleanup for Server srv (${row.serverId})`,
      });

      dispatchSpy.mockRestore();
    });

    it("the nightly cleanup of a Frozen Organization's Server sends it nothing and notifies no one", async () => {
      const session = await signUp(httpServer, owner);
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const [row] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId,
        })
        .returning();
      await freezeOrganization(ctx, organizationId);
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue(undefined);
      remoteExec.execAsyncRemote.mockClear();

      await dockerCleanup.runServerCleanup(row.serverId);

      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
      expect(dispatchSpy).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    /**
     * A prune that waited its ten minutes behind a busy Docker CLI and
     * gave up exits 75 and names what held it. The nightly job then sends no
     * "completed successfully" notification, and a manual prune answers 409
     * with the reason rather than a 500 or a spinner that never ends.
     */
    it('a prune Docker kept busy is a 409 by hand and no "completed" notification at night', async () => {
      const session = await signUp(httpServer, owner);
      const busy = new ExecError('Command failed with exit code 75', {
        command: 'x',
        stderr: 'CLOUDGATE_DOCKER_BUSY: docker build\n',
        exitCode: 75,
      });
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue(undefined);

      remoteExec.execAsync.mockRejectedValueOnce(busy);
      const res = await request(httpServer)
        .post('/settings/cleanup/images')
        .set('Cookie', session.cookie)
        .send({});
      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'Docker stayed busy for 10 minutes, so the prune did not run: docker build',
      );

      remoteExec.execAsync.mockClear();
      remoteExec.execAsync.mockRejectedValueOnce(busy);
      await dockerCleanup.runLocalCleanup();
      // Skipped at the first prune: the other three would wait behind the same build.
      expect(remoteExec.execAsync).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).not.toHaveBeenCalled();

      dispatchSpy.mockRestore();
    });

    it('re-registers enabled cleanup crons and the log cleanup on boot', async () => {
      const scheduling = ctx.app.get(SchedulingService);
      const session = await signUp(httpServer, owner);
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;

      await settings.updateWebServerSettings({
        enableDockerCleanup: true,
        logCleanupCron: '15 2 * * *',
      });
      const [row] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          enableDockerCleanup: true,
          organizationId,
        })
        .returning();

      await dockerCleanup.initCronJobs();

      expect(scheduling.has('docker-cleanup')).toBe(true);
      expect(scheduling.has(`docker-cleanup:${row.serverId}`)).toBe(true);
      expect(scheduling.has('access-log-cleanup')).toBe(true);

      // Cleanup for the next tests.
      ctx.app.get(SchedulingService).unregister('docker-cleanup');
      ctx.app
        .get(SchedulingService)
        .unregister(`docker-cleanup:${row.serverId}`);
      ctx.app.get(SchedulingService).unregister('access-log-cleanup');
    });
  });

  describe('instance updates', () => {
    it('reports version and release tag', async () => {
      const session = await signUp(httpServer, owner);
      const version = CLOUDGATE_VERSION;

      const versionRes = await request(httpServer)
        .get('/settings/version')
        .set('Cookie', session.cookie);
      expect(versionRes.status).toBe(200);
      expect(versionRes.text).toBe(version);

      const tagRes = await request(httpServer)
        .get('/settings/release-tag')
        .set('Cookie', session.cookie);
      expect(tagRes.status).toBe(200);
      expect(tagRes.text).toBe('latest');
    });

    /** `GET /repos/octabyte-io/cloudgate/releases`, each with its tarball. */
    const githubReleases = (...tags: string[]) =>
      ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            tags.map((tag) => ({
              tag_name: tag,
              assets: [
                { name: `cloudgate-${tag.slice(1)}-linux-amd64.tar.gz` },
              ],
            })),
          ),
      }) as unknown as Response;

    /** The resource probe's answer: this instance as the `cloudgate` Docker service. */
    const runningAsDockerService = () =>
      remoteExec.execAsync.mockImplementation((command: string) =>
        Promise.resolve(
          ok(command.includes('docker service inspect') ? 'service\n' : ''),
        ),
      );

    it('checks GitHub Releases for a newer Cloudgate version', async () => {
      const session = await signUp(httpServer, owner);
      fetchClient.mockResolvedValueOnce(
        githubReleases('cli-v99.0.0', 'v99.0.0', 'v0.0.1'),
      );

      const res = await request(httpServer)
        .post('/settings/update-data')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        latestVersion: 'v99.0.0',
        updateAvailable: true,
        upgradeCommand:
          'curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo CLOUDGATE_VERSION=v99.0.0 sh',
        canUpdateInPlace: false,
        error: null,
      });
      expect(fetchClient).toHaveBeenCalledWith(
        'https://api.github.com/repos/octabyte-io/cloudgate/releases?per_page=100',
        expect.anything(),
      );
    });

    /**
     * An unreachable GitHub used to answer exactly what "checked, you are
     * current" answers. It now names the failure.
     */
    it('reports a fetch failure instead of answering "nothing newer"', async () => {
      const session = await signUp(httpServer, owner);
      fetchClient.mockRejectedValueOnce(new Error('github down'));

      const res = await request(httpServer)
        .post('/settings/update-data')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      const body = res.body as { error: string };
      expect(body).toMatchObject({
        latestVersion: null,
        updateAvailable: false,
      });
      expect(body.error).toContain('api.github.com');
      expect(body.error).toContain('github down');
    });

    it('POST /settings/update-server refuses when the check did not complete', async () => {
      const session = await signUp(httpServer, owner);
      fetchClient.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ message: 'API rate limit exceeded' }),
      } as unknown as Response);

      const res = await request(httpServer)
        .post('/settings/update-server')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(503);
      expect(remoteExec.execFileAsync).not.toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['service', 'update']),
      );
    });

    it('POST /settings/update-server refuses a native install with 409, saying how it upgrades', async () => {
      const session = await signUp(httpServer, owner);
      fetchClient.mockResolvedValueOnce(githubReleases('v99.0.0'));

      const res = await request(httpServer)
        .post('/settings/update-server')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain(
        'CLOUDGATE_VERSION',
      );
      expect(remoteExec.execFileAsync).not.toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['service', 'update']),
      );
    });

    it('POST /settings/update-server moves the cloudgate Docker service onto a newer Cloudgate version', async () => {
      const session = await signUp(httpServer, owner);
      runningAsDockerService();
      fetchClient.mockResolvedValueOnce(githubReleases('v99.0.0'));

      const res = await request(httpServer)
        .post('/settings/update-server')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(remoteExec.execFileAsync).toHaveBeenCalledWith('docker', [
        'service',
        'update',
        '--force',
        '--image',
        'cloudgate/cloudgate:v99.0.0',
        'cloudgate',
      ]);
    });
  });

  describe('GPU support', () => {
    /**
     * `swarm-resource` counts only at top level. Appended, it sat inside
     * the last table, where the runtime ignores it.
     */
    const TOML_CONFIGURED =
      'disable-require = false\nswarm-resource = "DOCKER_RESOURCE_GPU"\n\n[nvidia-ctk]\npath = "nvidia-ctk"\n';
    const TOML_THE_OLD_WAY =
      'disable-require = false\n\n[nvidia-ctk]\npath = "nvidia-ctk"\nswarm-resource = "DOCKER_RESOURCE_GPU"\n';

    it('aggregates GPU status from the nvidia/docker probes', async () => {
      const session = await signUp(httpServer, owner);
      remoteExec.execAsync.mockImplementation((command: string) => {
        if (command.includes('--query-gpu=driver_version'))
          return Promise.resolve(ok('550.12\n'));
        if (
          command.includes('--query-gpu=gpu_name --format=csv,noheader | wc -l')
        )
          return Promise.resolve(ok('2\n'));
        if (command.includes('command -v nvidia-container-runtime'))
          return Promise.resolve(ok('/usr/bin/nvidia-container-runtime\n'));
        if (command.includes('{{json .Runtimes}}'))
          return Promise.resolve(
            ok('{"nvidia":{"path":"nvidia-container-runtime"}}\n'),
          );
        if (command.includes('{{.DefaultRuntime}}'))
          return Promise.resolve(ok('nvidia\n'));
        if (command.includes('cat /etc/nvidia-container-runtime/config.toml'))
          return Promise.resolve(ok(TOML_CONFIGURED));
        if (command.includes('GenericResources'))
          return Promise.resolve(
            ok('[{"DiscreteResourceSpec":{"Kind":"GPU","Value":2}}]\n'),
          );
        if (command.includes('--query-gpu=gpu_name,memory.total'))
          return Promise.resolve(ok('NVIDIA A100, 40960 MiB\n'));
        if (command.includes('CUDA Version'))
          return Promise.resolve(ok('    CUDA Version   : 12.4\n'));
        return Promise.resolve(ok(''));
      });

      const res = await request(httpServer)
        .get('/settings/gpu')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        driverInstalled: true,
        driverVersion: '550.12',
        gpuModel: 'NVIDIA A100',
        runtimeInstalled: true,
        runtimeConfigured: true,
        cudaSupport: true,
        cudaVersion: '12.4',
        memoryInfo: '40960 MiB',
        availableGPUs: 2,
        swarmEnabled: true,
        gpuResources: 2,
        gpuSetup: 'count',
        gpuCardIds: [],
      });
    });

    it('refuses GPU setup without drivers (400, with the install-drivers message)', async () => {
      const session = await signUp(httpServer, owner);
      remoteExec.execAsync.mockRejectedValue(new Error('nvidia-smi not found'));

      const res = await request(httpServer)
        .post('/settings/gpu-setup')
        .set('Cookie', session.cookie)
        .send({});
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'NVIDIA drivers not installed. Please install appropriate NVIDIA drivers first.',
      );
    });

    /**
     * GPU setup by card ID, on any Server. The probes below are what a
     * Server with two cards answers over SSH; `advertised` is what
     * `docker node inspect self` reports as its GPU generic resources, and the
     * setup command flips it to `afterSetup`, as the Docker restart would.
     */
    const CARD_A = 'GPU-8f3c1a2b-0d4e-4f5a-9b6c-7d8e9f0a1b2c';
    const CARD_B = 'GPU-11111111-2222-3333-4444-555555555555';
    const NOT_SET_UP = 'null';
    const BY_COUNT = '[{"DiscreteResourceSpec":{"Kind":"GPU","Value":2}}]';
    const BY_CARD_ID = `[{"NamedResourceSpec":{"Kind":"GPU","Value":"${CARD_A}"}},{"NamedResourceSpec":{"Kind":"GPU","Value":"${CARD_B}"}}]`;

    function answerGpuProbes(
      initial: string,
      afterSetup = BY_CARD_ID,
      runtimeToml = TOML_CONFIGURED,
      runtimeTomlAfterSetup = TOML_CONFIGURED,
    ) {
      let advertised = initial;
      let toml = runtimeToml;
      remoteExec.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) => {
          if (command.includes('systemctl restart docker')) {
            advertised = afterSetup;
            toml = runtimeTomlAfterSetup;
            return Promise.resolve(ok(''));
          }
          if (command.includes('--query-gpu=driver_version'))
            return Promise.resolve(ok('550.12\n'));
          if (command.includes('--query-gpu=uuid'))
            return Promise.resolve(ok(`${CARD_A}\n${CARD_B}\n`));
          if (command.includes('| wc -l')) return Promise.resolve(ok('2\n'));
          if (command.includes('command -v nvidia-container-runtime'))
            return Promise.resolve(ok('/usr/bin/nvidia-container-runtime\n'));
          if (command.includes('{{json .Runtimes}}'))
            return Promise.resolve(
              ok('{"nvidia":{"path":"nvidia-container-runtime"}}\n'),
            );
          if (command.includes('{{.DefaultRuntime}}'))
            return Promise.resolve(ok('nvidia\n'));
          if (command.includes('{{.Swarm.NodeID}}'))
            return Promise.resolve(ok('node-1\n'));
          if (command.includes('cat /etc/nvidia-container-runtime/config.toml'))
            return Promise.resolve(ok(toml));
          if (command.includes('sudo -n cat /etc/docker/daemon.json'))
            return Promise.resolve(
              ok(
                '{"default-shm-size":"1G","node-generic-resources":["GPU=2"]}',
              ),
            );
          if (command.includes('GenericResources'))
            return Promise.resolve(ok(`${advertised}\n`));
          return Promise.resolve(ok(''));
        },
      );
    }

    async function ownServerOf(cookie: string): Promise<string> {
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const [row] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'gpu-1',
          ipAddress: '10.0.0.7',
          port: 22,
          organizationId,
        })
        .returning();
      return row.serverId;
    }

    it("tells a Server's three GPU setup states apart", async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServerOf(session.cookie);

      const answers: Record<string, unknown> = {};
      for (const [name, advertised] of [
        ['not set up', NOT_SET_UP],
        ['set up the old way', BY_COUNT],
        ['set up by card ID', BY_CARD_ID],
      ]) {
        answerGpuProbes(advertised);
        const res = await request(httpServer)
          .get('/settings/gpu')
          .query({ serverId })
          .set('Cookie', session.cookie);
        expect(res.status).toBe(200);
        const body = res.body as Record<string, unknown>;
        answers[name] = {
          gpuSetup: body.gpuSetup,
          gpuCardIds: body.gpuCardIds,
          gpuResources: body.gpuResources,
        };
      }

      expect(answers).toEqual({
        'not set up': { gpuSetup: 'none', gpuCardIds: [], gpuResources: 0 },
        'set up the old way': {
          gpuSetup: 'count',
          gpuCardIds: [],
          gpuResources: 2,
        },
        'set up by card ID': {
          gpuSetup: 'card-id',
          gpuCardIds: [CARD_A, CARD_B],
          gpuResources: 2,
        },
      });
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('sets a Server set up the old way up again, writing one GPU=<card ID> per card into its daemon.json and swarm-resource at top level', async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServerOf(session.cookie);
      answerGpuProbes(BY_COUNT);

      const res = await request(httpServer)
        .post('/settings/gpu-setup')
        .set('Cookie', session.cookie)
        .send({ serverId });
      expect(res.status).toBe(200);

      const setup = remoteExec.execAsyncRemote.mock.calls
        .map(([, command]) => command)
        .find((command) => command.includes('systemctl restart docker'));
      expect(setup).toContain(`"GPU=${CARD_A}"`);
      expect(setup).toContain(`"GPU=${CARD_B}"`);
      expect(setup).not.toContain('"GPU=2"');
      // Merged into what is there, not written over it.
      expect(setup).toContain('"default-shm-size": "1G"');
      expect(setup).toContain('swarm-resource = "DOCKER_RESOURCE_GPU"');
      expect(setup).not.toContain('tee -a');
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        'docker node update --label-add gpu=true node-1',
      );
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('leaves a Server already set up by card ID as it is', async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServerOf(session.cookie);
      answerGpuProbes(BY_CARD_ID);

      const res = await request(httpServer)
        .post('/settings/gpu-setup')
        .set('Cookie', session.cookie)
        .send({ serverId });
      expect(res.status).toBe(200);
      const commands = remoteExec.execAsyncRemote.mock.calls.map(
        ([, command]) => command,
      );
      expect(commands.filter((c) => c.includes('daemon.json'))).toEqual([]);
    });

    it('sets a Server up again whose swarm-resource sits inside a table', async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServerOf(session.cookie);
      answerGpuProbes(BY_CARD_ID, BY_CARD_ID, TOML_THE_OLD_WAY);

      const before = await request(httpServer)
        .get('/settings/gpu')
        .query({ serverId })
        .set('Cookie', session.cookie);
      expect(before.body).toMatchObject({
        gpuSetup: 'card-id',
        runtimeConfigured: false,
      });

      const res = await request(httpServer)
        .post('/settings/gpu-setup')
        .set('Cookie', session.cookie)
        .send({ serverId });
      expect(res.status).toBe(200);
      const commands = remoteExec.execAsyncRemote.mock.calls.map(
        ([, command]) => command,
      );
      expect(
        commands.filter((c) => c.includes('systemctl restart docker')),
      ).toHaveLength(1);
    });

    it('fails a setup after which swarm-resource still sits inside a table', async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServerOf(session.cookie);
      answerGpuProbes(BY_COUNT, BY_CARD_ID, TOML_THE_OLD_WAY, TOML_THE_OLD_WAY);

      const res = await request(httpServer)
        .post('/settings/gpu-setup')
        .set('Cookie', session.cookie)
        .send({ serverId });
      expect(res.status).toBe(400);
      expect(refusal(res)).toBe(
        'GPU setup did not leave the NVIDIA runtime configured: Docker must use it by default and its config.toml must set swarm-resource before any table',
      );
    });

    it('fails a setup after which the Server still advertises a count', async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServerOf(session.cookie);
      answerGpuProbes(BY_COUNT, BY_COUNT);

      const res = await request(httpServer)
        .post('/settings/gpu-setup')
        .set('Cookie', session.cookie)
        .send({ serverId });
      expect(res.status).toBe(400);
      expect(refusal(res)).toBe(
        'GPU support not detected in swarm after setup',
      );
    });

    it("lets an organization admin check and set up their Server's GPUs, and refuses a member, another organization and an Agent", async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServerOf(session.cookie);
      const admin = await signUpMember(httpServer, session.cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });
      const member = await signUpMember(httpServer, session.cookie);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );
      const agent = await request(httpServer)
        .post('/agents')
        .set('Cookie', session.cookie)
        .send({ name: 'gpu-bot', role: 'agentOperator' });
      expect(agent.status).toBe(201);
      const agentKey = (agent.body as { key: string }).key;
      answerGpuProbes(BY_COUNT);

      const asked = async (who: { cookie: string } | { key: string }) => {
        const as = (req: request.Test) =>
          'cookie' in who
            ? req.set('Cookie', who.cookie)
            : req.set('x-api-key', who.key);
        const check = await as(
          request(httpServer).get('/settings/gpu').query({ serverId }),
        );
        const setup = await as(
          request(httpServer).post('/settings/gpu-setup').send({ serverId }),
        );
        return {
          check: [check.status, refusal(check)],
          setup: [setup.status, refusal(setup)],
        };
      };

      expect(await asked({ cookie: member.cookie })).toEqual({
        check: [403, OWNER_OR_ADMIN_REFUSAL],
        setup: [403, OWNER_OR_ADMIN_REFUSAL],
      });
      expect(await asked({ cookie: mallory.cookie })).toEqual({
        check: [404, 'Server not found'],
        setup: [404, 'Server not found'],
      });
      const AGENT_REFUSAL = 'An Agent can act only through the MCP endpoint';
      expect(await asked({ key: agentKey })).toEqual({
        check: [403, AGENT_REFUSAL],
        setup: [403, AGENT_REFUSAL],
      });
      // Not one probe or setup command reached the Server for the three.
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();

      const byAdmin = await asked({ cookie: admin.cookie });
      expect([byAdmin.check[0], byAdmin.setup[0]]).toEqual([200, 200]);
    });
  });

  describe('infrastructure health', () => {
    it('reports postgres via the live connection and traefik via docker', async () => {
      const session = await signUp(httpServer, owner);
      dockerClient.getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({ State: { Running: true } }),
      });

      const res = await request(httpServer)
        .get('/settings/infrastructure-health')
        .set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        postgres: { status: 'healthy' },
        traefik: { status: 'healthy' },
      });
    });

    it('flags a stopped traefik container', async () => {
      const session = await signUp(httpServer, owner);
      dockerClient.getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({ State: { Running: false } }),
      });

      const res = await request(httpServer)
        .get('/settings/infrastructure-health')
        .set('Cookie', session.cookie);
      expect(res.body).toEqual({
        postgres: { status: 'healthy' },
        traefik: {
          status: 'unhealthy',
          message: 'Container is not running',
        },
      });
    });

    it('GET /settings/health is public and pings the database', async () => {
      const res = await request(httpServer).get('/settings/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('GET /settings/about answers with no credential: Cloudgate, its version, no API address unless one is set, and self-hosted mode', async () => {
      // The version is backend/package.json's, read independently of the code.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { version } = require('../../package.json') as { version: string };

      const res = await request(httpServer).get('/settings/about');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        product: 'cloudgate',
        version,
        apiUrl: null,
        // HOSTED_MODE is unset in this file.
        mode: 'self-hosted',
      });
    });

    it('isUserSubscribed reflects servers/projects in the active org', async () => {
      const session = await signUp(httpServer, owner);

      const before = await request(httpServer)
        .get('/settings/is-user-subscribed')
        .set('Cookie', session.cookie);
      expect(before.text).toBe('false');

      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      await ctx.db
        .insert(schema.project)
        .values({ name: 'p1', organizationId });

      const after = await request(httpServer)
        .get('/settings/is-user-subscribed')
        .set('Cookie', session.cookie);
      expect(after.text).toBe('true');
    });
  });

  describe('deployment notification links', () => {
    const notification = {
      projectName: 'shop',
      applicationName: 'web',
      applicationType: 'application',
      environmentName: 'production',
      organizationId: 'org-1',
      projectId: 'proj-1',
      environmentId: 'env-1',
      serviceId: 'app-1',
    };

    it('builds the console buildLink once the instance URL exists', async () => {
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue(undefined);
      await settings.updateWebServerSettings({
        host: 'panel.example.com',
        https: true,
      });

      const notifier = ctx.app.get(DeploymentNotifierAdapter);
      await notifier.buildSuccess(notification);

      expect(dispatchSpy).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          type: 'app-deploy',
          applicationName: 'web',
          // A route the console serves, held to the console's own tables in
          // `notifications/deployment-link.spec.ts`.
          buildLink: 'https://panel.example.com/applications/app-1/deployments',
        }),
      );
      dispatchSpy.mockRestore();
    });

    it('omits the buildLink while no host or serverIp is configured', async () => {
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue(undefined);

      const notifier = ctx.app.get(DeploymentNotifierAdapter);
      await notifier.buildError({
        ...notification,
        errorMessage: 'boom',
      });

      const [, event] = dispatchSpy.mock.calls[0] as [
        string,
        { type: string; buildLink?: string },
      ];
      expect(event.type).toBe('app-build-error');
      expect(event.buildLink).toBeUndefined();
      dispatchSpy.mockRestore();
    });
  });

  /**
   * H-52. `dynamic/cloudgate.yml` is the console's own router file and it has
   * two writers — `SettingsService.updateServerTraefik` behind
   * `POST /settings/assign-domain`, and
   * `TraefikFilesService.writeConfig('cloudgate', …)` behind
   * `POST /settings/traefik/web-server-config`, which takes raw operator YAML
   * as a documented escape hatch. Both sat behind `requireOwnerOrAdmin`, which
   * reads the caller's member row in the organization they are *currently
   * acting in*, so an owner of any organization on the instance could rewrite
   * the console's router. `POST /settings/traefik/file` with no `serverId` is a
   * third writer of the same file behind a *weaker* gate again.
   *
   * The neighbouring suites already denied a plain Member. Nobody had asked
   * what a second organization's owner could do, because until this fixture
   * there was no second organization's owner to ask with.
   */
  describe('the platform host as a target', () => {
    it("refuses another organization's owner the console's Traefik config", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );

      const denied = await request(httpServer)
        .post('/settings/traefik/web-server-config')
        .set('Cookie', mallory.cookie)
        .send({ traefikConfig: 'http:\n  routers: {}\n' });
      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);

      // Nothing was written on the way to being refused.
      expect(traefikFiles.readConfig('cloudgate')).toBeNull();

      const deniedRead = await request(httpServer)
        .get('/settings/traefik/web-server-config')
        .set('Cookie', mallory.cookie);
      expect(deniedRead.status).toBe(403);
      expect(refusal(deniedRead)).toBe(INSTANCE_AUTHORITY_REFUSAL);
    });

    it("refuses another organization's owner the same file by path", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );

      const denied = await request(httpServer)
        .post('/settings/traefik/file')
        .set('Cookie', mallory.cookie)
        .send({
          path: `${traefikDir}/dynamic/cloudgate.yml`,
          traefikConfig: 'http:\n  routers: {}\n',
        });
      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      expect(traefikFiles.readConfig('cloudgate')).toBeNull();
    });

    it("refuses another organization's owner the static traefik.yml and the console host", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );

      const staticConfig = await request(httpServer)
        .post('/settings/traefik/config')
        .set('Cookie', mallory.cookie)
        .send({ traefikConfig: 'entryPoints: {}\n' });
      expect(staticConfig.status).toBe(403);
      expect(refusal(staticConfig)).toBe(INSTANCE_AUTHORITY_REFUSAL);

      const assign = await request(httpServer)
        .post('/settings/assign-domain')
        .set('Cookie', mallory.cookie)
        .send({ host: 'console.attacker.tld', certificateType: 'none' });
      expect(assign.status).toBe(403);
      expect(refusal(assign)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      expect(traefikWriter.writeConfig).not.toHaveBeenCalled();
    });

    it('lets the instance owner configure the platform host', async () => {
      const session = await signUp(httpServer, owner);
      await secondOrganizationOwner(httpServer, ctx.db, session.cookie);

      const write = await request(httpServer)
        .post('/settings/traefik/web-server-config')
        .set('Cookie', session.cookie)
        .send({ traefikConfig: 'http:\n  routers: {}\n' });
      expect(write.status).toBe(200);

      const read = await request(httpServer)
        .get('/settings/traefik/web-server-config')
        .set('Cookie', session.cookie);
      expect(read.status).toBe(200);
      expect(read.text).toBe('http:\n  routers: {}\n');
    });

    /**
     * The no-lockout claim, pinned rather than argued.
     *
     * `hasInstanceOwner` is what closes sign-up, and it is the same `member`
     * row `checkInstanceAuthority` reads. So an instance that anybody can sign
     * into always has an account that passes this gate — which is why gating on
     * it cannot leave an operator locked out of their own platform host, and
     * why the admin plugin's `user.role` could not be used instead (it is
     * `'user'` for every row and no request can change it).
     */
    it('admits the account whose existence closed sign-up', async () => {
      const session = await signUp(httpServer, owner);

      const open = await request(httpServer).get('/auth/sign-up-open');
      expect(open.status).toBe(200);
      expect(open.body).toEqual({ open: false, state: 'closed' });

      const write = await request(httpServer)
        .post('/settings/traefik/web-server-config')
        .set('Cookie', session.cookie)
        .send({ traefikConfig: 'http:\n  routers: {}\n' });
      expect(write.status).toBe(200);
    });

    /**
     * The no-op claim, asserted rather than assumed: on the install
     * `deploy/install.sh` produces there is one Organization, its owner is the
     * instance owner, and an admin they invite keeps every route they had.
     */
    it("leaves the single-organization install's owner and admin exactly as they were", async () => {
      const session = await signUp(httpServer, owner);
      const admin = await signUpMember(httpServer, session.cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });

      const byOwner = await request(httpServer)
        .post('/settings/traefik/web-server-config')
        .set('Cookie', session.cookie)
        .send({ traefikConfig: 'http:\n  routers: {}\n' });
      expect(byOwner.status).toBe(200);

      const byAdmin = await request(httpServer)
        .post('/settings/traefik/web-server-config')
        .set('Cookie', admin.cookie)
        .send({ traefikConfig: 'http:\n  services: {}\n' });
      expect(byAdmin.status).toBe(200);
      expect(traefikFiles.readConfig('cloudgate')).toBe(
        'http:\n  services: {}\n',
      );
    });

    /**
     * H-64. Two routes on this controller reach the platform host with **no
     * authority behind them at all**, which is a different defect from H-51/H-52
     * — there the question asked was the wrong one, here none was asked.
     *
     * `POST /settings/traefik/requests` gated on `checkServerAccess` alone, and
     * `checkServerAccess` returns for an absent id by design, so the whole gate
     * was a no-op on the host branch. `POST /settings/log-cleanup` took no
     * `@CurrentUser` at all. Both write instance-wide state on the platform
     * host, and both were reachable by any signed-in member of any organization.
     *
     * The decisive caller is therefore a **plain member**, which is what the
     * neighbouring suites never asked for on these two routes; a second
     * organization's owner is asserted alongside because the same fixture proves
     * the boundary is the instance organization rather than any owner's.
     */
    it("refuses a plain member the platform host's request-logging toggle", async () => {
      const session = await signUp(httpServer, owner);
      const memberSession = await signUpMember(httpServer, session.cookie);
      traefikFiles.writeMainConfig('entryPoints:\n  web:\n    address: :80\n');
      await traefikFiles.toggleRequests(true);

      const denied = await request(httpServer)
        .post('/settings/traefik/requests')
        .set('Cookie', memberSession.cookie)
        .send({ enable: false });

      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      // The audit trail `/monitoring/requests/*` reads survived: nothing was
      // written to the static config on the way to being refused.
      await expect(traefikFiles.haveActivateRequests()).resolves.toEqual({
        present: true,
        enabled: true,
      });
    });

    it("refuses another organization's owner the request-logging toggle", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );
      traefikFiles.writeMainConfig('entryPoints:\n  web:\n    address: :80\n');

      const denied = await request(httpServer)
        .post('/settings/traefik/requests')
        .set('Cookie', mallory.cookie)
        .send({ enable: true });

      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      await expect(traefikFiles.haveActivateRequests()).resolves.toEqual({
        present: true,
        enabled: false,
      });
    });

    /**
     * The carve-out ADR-0013 made is for the **read**, and it still holds: `GET
     * /settings/traefik/requests` answers one boolean pair, discloses no
     * configuration, and is a documented any-authenticated-user quirk. The
     * write beside it was never covered by that reasoning.
     */
    it('still answers the request-logging status to a plain member', async () => {
      const session = await signUp(httpServer, owner);
      const memberSession = await signUpMember(httpServer, session.cookie);
      traefikFiles.writeMainConfig('entryPoints:\n  web:\n    address: :80\n');

      const status = await request(httpServer)
        .get('/settings/traefik/requests')
        .set('Cookie', memberSession.cookie);

      expect(status.status).toBe(200);
      expect(status.body).toEqual({ present: true, enabled: false });
    });

    it("refuses a plain member the host's log-rotation schedule", async () => {
      const session = await signUp(httpServer, owner);
      const memberSession = await signUpMember(httpServer, session.cookie);
      const scheduling = ctx.app.get(SchedulingService);

      const denied = await request(httpServer)
        .post('/settings/log-cleanup')
        .set('Cookie', memberSession.cookie)
        .send({ cronExpression: '* * * * *' });

      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      // Neither half of the effect happened: no cron was registered and the
      // stored schedule is still the default.
      expect(scheduling.has('access-log-cleanup')).toBe(false);
      expect((await settings.getWebServerSettings()).logCleanupCron).toBe(
        '0 0 * * *',
      );
    });

    it("refuses another organization's owner the stop of log rotation", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );

      const denied = await request(httpServer)
        .post('/settings/log-cleanup')
        .set('Cookie', mallory.cookie)
        .send({ cronExpression: null });

      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      expect((await settings.getWebServerSettings()).logCleanupCron).toBe(
        '0 0 * * *',
      );
    });

    it('leaves the single-organization install able to toggle requests and rotation', async () => {
      const session = await signUp(httpServer, owner);
      const admin = await signUpMember(httpServer, session.cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });
      const scheduling = ctx.app.get(SchedulingService);
      traefikFiles.writeMainConfig('entryPoints:\n  web:\n    address: :80\n');

      const byOwner = await request(httpServer)
        .post('/settings/traefik/requests')
        .set('Cookie', session.cookie)
        .send({ enable: true });
      expect(byOwner.status).toBe(200);
      expect(byOwner.body).toEqual({ written: true, restartRequired: true });

      const byAdmin = await request(httpServer)
        .post('/settings/traefik/requests')
        .set('Cookie', admin.cookie)
        .send({ enable: false });
      expect(byAdmin.status).toBe(200);
      await expect(traefikFiles.haveActivateRequests()).resolves.toEqual({
        present: true,
        enabled: false,
      });

      const cronByAdmin = await request(httpServer)
        .post('/settings/log-cleanup')
        .set('Cookie', admin.cookie)
        .send({ cronExpression: '0 3 * * *' });
      expect(cronByAdmin.status).toBe(200);
      expect(scheduling.has('access-log-cleanup')).toBe(true);
      expect((await settings.getWebServerSettings()).logCleanupCron).toBe(
        '0 3 * * *',
      );

      const cronByOwner = await request(httpServer)
        .post('/settings/log-cleanup')
        .set('Cookie', session.cookie)
        .send({ cronExpression: null });
      expect(cronByOwner.status).toBe(200);
      expect(scheduling.has('access-log-cleanup')).toBe(false);
    });
  });

  /**
   * `enforceSSO` is one boolean on the `web_server_settings` singleton
   * and `SsoService.enforceSso` reads it with no organization in the query, so
   * it is instance-wide by construction — and the console's own `EnforceCard`
   * calls it *"the most dangerous control in the console and it is not close"*,
   * because the sign-in screen renders **no password form at all** when it is
   * on. `PATCH /sso/enforce` delegates to `SettingsService.updateEnforceSso`,
   * which sat behind `requireOwnerOrAdmin`: ADR-0013's fourth consequence
   * verbatim, on the login path rather than on a Traefik file, so an owner of
   * any second Organization could take password sign-in away from every
   * Organization on the instance — or hand it back after the operator had
   * deliberately removed it.
   *
   * The licence is still deliberately not asked here (see
   * `SettingsService.updateEnforceSso`): a lapsed licence must not be able to
   * strand an instance in SSO-only mode with no way to switch back.
   */
  describe('the instance-wide SSO switch', () => {
    it("refuses another organization's owner the instance's SSO enforcement", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );

      const denied = await request(httpServer)
        .patch('/sso/enforce')
        .set('Cookie', mallory.cookie)
        .send({ enforceSSO: true });
      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);

      // Password sign-in is still there for everybody, the second
      // Organization's own members included.
      expect((await settings.getWebServerSettings()).enforceSSO).toBe(false);
      const publicRead = await request(httpServer).get('/sso/enforce');
      expect(publicRead.body).toEqual({ enforced: false });
    });

    it("leaves a single-organization install's owner and admin able to enforce it", async () => {
      const session = await signUp(httpServer, owner);
      const admin = await signUpMember(httpServer, session.cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });

      const byAdmin = await request(httpServer)
        .patch('/sso/enforce')
        .set('Cookie', admin.cookie)
        .send({ enforceSSO: true });
      expect(byAdmin.status).toBe(200);
      expect((await settings.getWebServerSettings()).enforceSSO).toBe(true);

      const byOwner = await request(httpServer)
        .patch('/sso/enforce')
        .set('Cookie', session.cookie)
        .send({ enforceSSO: false });
      expect(byOwner.status).toBe(200);
      expect((await settings.getWebServerSettings()).enforceSSO).toBe(false);
    });
  });

  /**
   * H-63. The rest of what ADR-0013's fifth consequence promised.
   *
   * That consequence named the routes left out of the change that closed
   * H-51/H-52 and said why: *"`update-server`, `reload-server`,
   * `infrastructure-health`, `clean-deployment-queue`, `docker-disk-usage`, the
   * `cleanup/*` family, `gpu`, `runtime-info`, `ip`, `ssh-private-key` and
   * `builds-concurrency` are all instance-wide and all still organization-gated.
   * They are the same question and they should get the same answer; they were
   * left out … to keep that change reviewable, not because they differ."* This
   * is that answer.
   *
   * The sharpest of them is `POST /settings/cleanup/volumes`, which is
   * `docker volume prune --all --force` on the platform host: it takes every
   * volume no running container holds, which is **other tenants' data**, deleted
   * by a caller who was never a member of their organization. The suite below
   * asserts the refusal *and* that the daemon was never asked, because a fix
   * that refuses after the prune is not a fix.
   */
  describe('the platform host as a maintenance target', () => {
    it("refuses another organization's owner every destructive cleanup on the host", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );

      for (const route of [
        'cleanup/volumes',
        'cleanup/all',
        'cleanup/docker-prune',
        'cleanup/images',
        'cleanup/stopped-containers',
        'cleanup/docker-builder',
        'cleanup/monitoring',
      ]) {
        const denied = await request(httpServer)
          .post(`/settings/${route}`)
          .set('Cookie', mallory.cookie)
          .send({});
        expect([route, denied.status]).toEqual([route, 403]);
        expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      }

      // Nothing was pruned on the way to being refused: not one docker command
      // reached the host, for any of the seven.
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });

    it("refuses another organization's owner the host's GPU rewrite and its inventory", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );

      // `/etc/docker/daemon.json` and a daemon restart, on the machine every
      // organization's containers run on.
      const setup = await request(httpServer)
        .post('/settings/gpu-setup')
        .set('Cookie', mallory.cookie)
        .send({});
      expect(setup.status).toBe(403);
      expect(refusal(setup)).toBe(INSTANCE_AUTHORITY_REFUSAL);

      // The read moves with it (ADR-0013): both answer with the host's own
      // inventory, which is the reconnaissance half of the write above.
      for (const route of ['gpu', 'runtime-info']) {
        const denied = await request(httpServer)
          .get(`/settings/${route}`)
          .set('Cookie', mallory.cookie);
        expect([route, denied.status]).toEqual([route, 403]);
        expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      }

      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it("refuses another organization's owner the instance's own lifecycle", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );
      const queue = ctx.app.get<QueuePort>(DEPLOYMENT_QUEUE);
      const clearSpy = jest.spyOn(queue, 'clearWaiting');

      for (const route of [
        'update-server',
        'reload-server',
        'clean-deployment-queue',
        'ip',
        'builds-concurrency',
        'docker-cleanup',
      ]) {
        const denied = await request(httpServer)
          .post(`/settings/${route}`)
          .set('Cookie', mallory.cookie)
          .send({
            serverIp: '198.51.100.9',
            buildsConcurrency: 1,
            enableDockerCleanup: false,
          });
        expect([route, denied.status]).toEqual([route, 403]);
        expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      }

      // Every organization's pending builds are still queued.
      expect(clearSpy).not.toHaveBeenCalled();

      for (const route of ['infrastructure-health', 'docker-disk-usage']) {
        const denied = await request(httpServer)
          .get(`/settings/${route}`)
          .set('Cookie', mallory.cookie);
        expect([route, denied.status]).toEqual([route, 403]);
        expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      }
    });

    /**
     * The Server branch is untouched, which is the other half of the claim: a
     * `serverId` names a Server, a Server belongs to an organization, and
     * Mallory owns hers — so her own fleet still answers to her, and the
     * organization role is still the right question there (ADR-0013's second
     * consequence).
     */
    it("leaves another organization's owner in charge of their own Server", async () => {
      const session = await signUp(httpServer, owner);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        session.cookie,
      );

      const key = await request(httpServer)
        .post('/ssh-keys')
        .set('Cookie', mallory.cookie)
        .send({ name: 'mallory-key' });
      expect(key.status).toBe(201);
      const created = await request(httpServer)
        .post('/servers')
        .set('Cookie', mallory.cookie)
        .send({
          name: 'mallory-1',
          ipAddress: '198.51.100.20',
          port: 22,
          username: 'root',
          sshKeyId: (key.body as { sshKeyId: string }).sshKeyId,
        });
      expect(created.status).toBe(201);
      const serverId = (created.body as { serverId: string }).serverId;

      const pruned = await request(httpServer)
        .post('/settings/cleanup/volumes')
        .set('Cookie', mallory.cookie)
        .send({ serverId });
      expect(pruned.status).toBe(200);
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        expect.stringContaining('docker volume prune --all --force'),
      );
    });

    /**
     * The no-op claim, asserted rather than assumed: on the single-organization
     * install `deploy/install.sh` produces there is one Organization, it is the
     * instance organization, and its owner and the admin they invited keep every
     * one of these routes.
     */
    it("leaves the single-organization install's owner and admin exactly as they were", async () => {
      const session = await signUp(httpServer, owner);
      const admin = await signUpMember(httpServer, session.cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });

      const prunedByAdmin = await request(httpServer)
        .post('/settings/cleanup/volumes')
        .set('Cookie', admin.cookie)
        .send({});
      expect(prunedByAdmin.status).toBe(200);
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('docker volume prune --all --force'),
      );

      const usageByOwner = await request(httpServer)
        .get('/settings/docker-disk-usage')
        .set('Cookie', session.cookie);
      expect(usageByOwner.status).toBe(200);

      const concurrencyByOwner = await request(httpServer)
        .post('/settings/builds-concurrency')
        .set('Cookie', session.cookie)
        .send({ buildsConcurrency: 3 });
      expect(concurrencyByOwner.status).toBe(200);
      expect((await settings.getWebServerSettings()).buildsConcurrency).toBe(3);
    });
  });

  describe('HTTP surface', () => {
    it('GET /settings/web-server returns the settings to an authenticated user', async () => {
      const session = await signUp(httpServer, owner);

      const res = await request(httpServer)
        .get('/settings/web-server')
        .set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.id).toBeTruthy();
      expect(body.certificateType).toBe('none');
      // Neither the instance SSH key nor its presence flag: an earlier change
      // dropped the column, so there is nothing left for the row to report.
      expect(body).not.toHaveProperty('sshPrivateKey');
      expect(body).not.toHaveProperty('hasSshPrivateKey');
    });

    it('rejects unauthenticated access', async () => {
      const res = await request(httpServer).get('/settings/web-server');
      expect(res.status).toBe(401);
    });

    // Three earlier leaks were one shape three times: the instance's SSH key
    // decrypted on read and rode a response out. An earlier change dropped that key, so
    // these guard the secret the row still carries — the metrics agent token
    // — on the two mutations found answering with the row.
    // The GET is `web-server-secrets.e2e-spec.ts`'s, over every string in the
    // body; `admin/admin.e2e-spec.ts` holds the third route.
    const METRICS_TOKEN = 'INSTANCE-METRICS-TOKEN';

    async function storeMetricsToken(): Promise<void> {
      await settings.updateWebServerSettings({
        metricsConfig: {
          ...defaultWebServerMetricsConfig,
          server: {
            ...defaultWebServerMetricsConfig.server,
            token: METRICS_TOKEN,
          },
        },
      });
    }

    it('POST /settings/ip never carries the metrics agent token', async () => {
      const session = await signUp(httpServer, owner);
      await storeMetricsToken();

      const res = await request(httpServer)
        .post('/settings/ip')
        .set('Cookie', session.cookie)
        .send({ serverIp: '198.51.100.4' });

      expect(res.status).toBe(200);
      const body = res.body as {
        metricsConfig: { server: Record<string, unknown> };
      } & Record<string, unknown>;
      expect(body.metricsConfig.server).not.toHaveProperty('token');
      expect(res.text).not.toContain(METRICS_TOKEN);
      expect(body.metricsConfig.server.hasToken).toBe(true);
      // The rest of the row still answers the caller's write.
      expect(body.id).toBeTruthy();
      expect(body.serverIp).toBe('198.51.100.4');
      expect(body.certificateType).toBe('none');
    });

    it('POST /settings/assign-domain never carries the metrics agent token', async () => {
      const session = await signUp(httpServer, owner);
      traefikWriter.loadOrCreateConfig.mockResolvedValue({
        http: { routers: {}, services: {} },
      });
      await storeMetricsToken();

      const res = await request(httpServer)
        .post('/settings/assign-domain')
        .set('Cookie', session.cookie)
        .send({
          host: 'panel.example.com',
          certificateType: 'none',
          https: true,
        });

      expect(res.status).toBe(200);
      const body = res.body as {
        metricsConfig: { server: Record<string, unknown> };
      } & Record<string, unknown>;
      expect(body.metricsConfig.server).not.toHaveProperty('token');
      expect(res.text).not.toContain(METRICS_TOKEN);
      expect(body.metricsConfig.server.hasToken).toBe(true);
      // The rest of the row still answers the caller's write.
      expect(body.id).toBeTruthy();
      expect(body.host).toBe('panel.example.com');
      expect(body.https).toBe(true);
      expect(body.certificateType).toBe('none');
    });

    // The other half of the earlier fix: the projection is the controller's, not the
    // store's. `setupMonitoring` keeps a stored token when a write omits it by
    // reading it back through the internal getter, so that getter must keep
    // handing it over — including after the mutations above.
    it('the internal getter still hands the metrics agent token to internal callers', async () => {
      const session = await signUp(httpServer, owner);
      await storeMetricsToken();

      const ip = await request(httpServer)
        .post('/settings/ip')
        .set('Cookie', session.cookie)
        .send({ serverIp: '198.51.100.4' });
      expect(ip.status).toBe(200);

      const row = await settings.getWebServerSettings();
      expect(row.metricsConfig.server.token).toBe(METRICS_TOKEN);
      expect(row.serverIp).toBe('198.51.100.4');
    });
  });
});
