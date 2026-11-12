import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse } from 'yaml';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import * as schema from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikSetupService } from '../../src/settings/traefik-setup.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Which **root** a Server-scoped Traefik-files operation resolves (the
 * seventh site of the root change's class and the second live one, ADR-0018's atomicity
 * rule stated for roots).
 *
 * **What broke.** `mainTraefikDirectory()` was `localCloudgateDirectory()` —
 * *this process's* root — frozen into `MAIN_TRAEFIK_DIR` by a `useFactory`
 * called once at module construction, and every Server-scoped branch of
 * `TraefikFilesService` baked it into a command sent over SSH:
 * `execRemote(serverId, ['cat', configPath])`, an
 * `echo … | base64 -d > configPath`, and the `root_dir=` of the remote
 * directory walk. So on an install with `CLOUDGATE_DIRECTORY` set, every one of
 * them named `{localRoot}/traefik/…` on a host where `serverSetupCommand`
 * created `/etc/cloudgate/traefik` — `readMainConfigOn` read nothing,
 * `GET /settings/traefik/requests` answered `present: false` about a Server
 * that has a Traefik config, and `POST /settings/traefik/requests` answered
 * **404 "No Traefik configuration on this server"** for it. `validatePath`
 * refused the real remote path on top of that, so the by-path escape hatch
 * could not be used to work around any of it.
 *
 * **Why nothing caught it, which is why this file exists in this shape.** With
 * `CLOUDGATE_DIRECTORY` unset the two roots are the *same literal*, so every
 * pre-existing assertion about these paths passes whichever root resolves —
 * the root change measured **59** pre-existing tests green with all five of its sites
 * reverted and a later fix measured **262** and **256**. So this file sets the
 * variable and every expectation names the **resolved** path:
 * `/etc/cloudgate` exists and is writable on some development hosts, so a
 * silent fall back to the default would otherwise read as a pass.
 * `test/applications/source-tree-roots.e2e-spec.ts` and
 * `test/patch/patch-repo-roots.e2e-spec.ts` are the models.
 *
 * **And why the conversion is one commit.** ADR-0018: whoever creates an
 * artifact and whoever consumes it must answer this the same way. The main
 * config has a writer (`writeMainConfigOn`) and two readers — `readMainConfigOn`
 * over SSH, and the **bind mount** `TraefikSetupService` gives the container
 * that reads it — so converting one side alone moves the leak rather than
 * closing it. The decisive assertions below are therefore not any single path's
 * words but *"the bind source is the file the toggle wrote"* and *"the write
 * went where the read read"*, both taken from the dispatches themselves.
 *
 * **The one path here that does not fork, and why.** `accessLog.filePath` is
 * read by Traefik **inside its container**, and the dynamic directory's bind
 * *target* is the fixed literal `/etc/cloudgate/traefik/dynamic` on every
 * machine — `deploy/install.sh` and `TraefikSetupService` mount this instance's
 * relocatable tree *at* that path, and `serverSetupCommand` mounts a Server's
 * identically. So the toggle writes one literal for both machines, the same one
 * `deploy/traefik/traefik.yml.example` already writes for the platform host,
 * and the last test here is what holds those two together.
 *
 * `MAIN_TRAEFIK_DIR` is deliberately **not** overridden: the resolved root is
 * the subject, so a temp dir injected over it would answer the question this
 * file is asking. Doubles are the exec layer and the Docker factory, both
 * boundaries.
 */
describe('The root a Server-scoped Traefik file operation resolves (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let traefikSetup: TraefikSetupService;
  let serverId: string;
  let cookie: string;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  const dockerFactory = {
    getRemoteDocker: jest.fn<Promise<unknown>, [string | null | undefined]>(),
  };

  /** A real temp directory, so the two roots are genuinely two strings. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-traefik-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  /** The `{root}/traefik` a machine's own Traefik tree is rooted at. */
  const traefikRootOn = (id: string | null) =>
    id ? `${REMOTE_CLOUDGATE_DIRECTORY}/traefik` : `${configuredRoot}/traefik`;

  /**
   * A Server as `serverSetupCommand` actually left it: a `traefik.yml` at the
   * one path that script creates, and nothing at all under this instance's own
   * root. Modelling the *host* rather than the route is what makes the 404 in
   * the ticket reproducible instead of asserted.
   */
  const remoteFiles = (): Record<string, string> => ({
    [`${traefikRootOn(serverId)}/traefik.yml`]:
      'entryPoints:\n  web:\n    address: :80\n',
    [`${traefikRootOn(serverId)}/dynamic/custom.yml`]: 'http: {}\n',
  });

  const answers = (command: string): Promise<ExecResult> => {
    const cat = /^cat (\S+)$/.exec(command);
    if (cat) return Promise.resolve(ok(remoteFiles()[cat[1]] ?? ''));
    // The remote directory walk parses its stdout as JSON, so an empty answer
    // is a 500 rather than an empty tree — the shape of the listing is
    // `settings.e2e-spec.ts`', and what this file reads is the `root_dir=` the
    // script was built around.
    if (command.includes('process_items'))
      return Promise.resolve(
        ok(
          `[{"id":"${traefikRootOn(serverId)}/traefik.yml","name":"traefik.yml","type":"file"}]`,
        ),
      );
    if (command.includes('docker service inspect'))
      return Promise.resolve(ok('standalone\n'));
    return Promise.resolve(ok());
  };

  beforeAll(async () => {
    // Before `createTestApp`: `localCloudgateDirectory()` reads `process.env`
    // on every call, but `validateEnv` runs once at boot.
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: remoteExec },
        { provide: RemoteDockerFactory, useValue: dockerFactory },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    traefikSetup = ctx.app.get(TraefikSetupService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    remoteExec.execAsync.mockImplementation(answers);
    remoteExec.execAsyncRemote.mockImplementation((_id, command) =>
      answers(command),
    );
    fs.rmSync(configuredRoot, { recursive: true, force: true });
    fs.mkdirSync(configuredRoot, { recursive: true });

    const res = await request(httpServer).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    cookie = res.headers['set-cookie'];
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const [row] = await ctx.db
      .insert(schema.server)
      .values({
        name: 'srv',
        ipAddress: '198.51.100.4',
        port: 22,
        organizationId,
      })
      .returning();
    serverId = row.serverId;
  });

  /** Every command the exec layer was asked for, with the machine it was asked
   * of — `null` being the platform host (ADR-0008). */
  const dispatched = () => [
    ...remoteExec.execAsync.mock.calls.map(([command]) => ({
      serverId: null as string | null,
      command,
    })),
    ...remoteExec.execAsyncRemote.mock.calls.map(([id, command]) => ({
      serverId: id,
      command,
    })),
  ];

  const reads = () =>
    dispatched().filter(({ command }) => command.startsWith('cat '));

  const writes = () =>
    dispatched().filter(({ command }) => command.includes('base64 -d >'));

  /** The YAML a `base64 -d >` carried, decoded. */
  const payloadOf = (command: string) =>
    Buffer.from(/echo "([^"]+)"/.exec(command)?.[1] ?? '', 'base64').toString(
      'utf8',
    );

  const requestsStatus = (query: Record<string, string>) =>
    request(httpServer)
      .get('/settings/traefik/requests')
      .query(query)
      .set('Cookie', cookie);

  const toggleRequests = (body: Record<string, unknown>) =>
    request(httpServer)
      .post('/settings/traefik/requests')
      .set('Cookie', cookie)
      .send(body);

  const readFile = (query: Record<string, string>) =>
    request(httpServer)
      .get('/settings/traefik/file')
      .query(query)
      .set('Cookie', cookie);

  const writeFile = (body: Record<string, unknown>) =>
    request(httpServer)
      .post('/settings/traefik/file')
      .set('Cookie', cookie)
      .send(body);

  const directories = (query: Record<string, string>) =>
    request(httpServer)
      .get('/settings/traefik/directories')
      .query(query)
      .set('Cookie', cookie);

  describe('the readers', () => {
    /**
     * **The captured failure.** The Server has a `traefik.yml`, at the only path
     * `serverSetupCommand` creates. Under the local root the `cat` names a
     * directory that host has never had, and one boolean pair away the console
     * is told the Server has no Traefik installation.
     */
    it('reads the main config at the Server’s own root, never at this instance’s', async () => {
      const status = await requestsStatus({ serverId });

      expect(status.status).toBe(200);
      expect(status.body).toEqual({ present: true, enabled: false });
      expect(reads()).toEqual([
        {
          serverId,
          command: `cat ${traefikRootOn(serverId)}/traefik.yml`,
        },
      ]);
      expect(reads()[0].command).not.toContain(configuredRoot);
    });

    // The branch that has to keep working: this process reads where this
    // process writes, which is the whole reason CLOUDGATE_DIRECTORY exists.
    it('reads this instance’s configured root for the platform host', async () => {
      const write = await request(httpServer)
        .post('/settings/traefik/config')
        .set('Cookie', cookie)
        .send({ traefikConfig: 'entryPoints: {}\n' });
      expect(write.status).toBe(200);

      expect(
        fs.readFileSync(`${configuredRoot}/traefik/traefik.yml`, 'utf8'),
      ).toBe('entryPoints: {}\n');
      const status = await requestsStatus({});
      expect(status.body).toEqual({ present: true, enabled: false });
      // Nothing was sent to a machine, and nothing was looked for under the
      // literal a Server's tree is rooted at.
      expect(reads()).toEqual([]);
    });

    it('lists the Server’s own Traefik directory, not this instance’s', async () => {
      const listed = await directories({ serverId });

      expect(listed.status).toBe(200);
      const walk = dispatched().find(({ command }) =>
        command.includes('root_dir='),
      );
      expect(walk?.serverId).toBe(serverId);
      expect(walk?.command).toContain(`root_dir=${traefikRootOn(serverId)}\n`);
      expect(walk?.command).not.toContain(configuredRoot);
    });

    it('lists this instance’s own Traefik directory for the platform host', async () => {
      fs.mkdirSync(`${configuredRoot}/traefik/dynamic`, { recursive: true });
      fs.writeFileSync(`${configuredRoot}/traefik/traefik.yml`, 'x');

      const listed = await directories({});

      expect(listed.status).toBe(200);
      expect(
        (listed.body as { name: string }[]).map(({ name }) => name).sort(),
      ).toEqual(['dynamic', 'traefik.yml']);
    });
  });

  describe('the confinement', () => {
    /**
     * `validatePath` confined *both* branches to the local root, so the by-path
     * routes refused every path that exists on the Server they address — the
     * escape hatch the ticket says cannot be used to work around the rest.
     */
    it('admits a path in the Server’s own tree on the Server branch', async () => {
      const path = `${traefikRootOn(serverId)}/dynamic/custom.yml`;

      const read = await readFile({ serverId, path });

      expect(read.status).toBe(200);
      expect(read.text).toBe('http: {}\n');
      expect(reads()).toEqual([{ serverId, command: `cat ${path}` }]);
    });

    it('admits a write into the Server’s own tree', async () => {
      const path = `${traefikRootOn(serverId)}/dynamic/custom.yml`;

      const written = await writeFile({
        serverId,
        path,
        traefikConfig: 'tls: {}\n',
      });

      expect(written.status).toBe(200);
      expect(writes()).toHaveLength(1);
      expect(writes()[0].serverId).toBe(serverId);
      expect(writes()[0].command).toContain(`> ${path}`);
    });

    /**
     * The other direction, which a fix that merely widened the check to admit
     * both roots would break: this instance's tree is not the Server's, and a
     * Server's is not this instance's. A guard that admits either root on either
     * branch is a second copy of the same defect wearing a security hat.
     */
    it('refuses this instance’s own tree on the Server branch', async () => {
      const path = `${traefikRootOn(null)}/dynamic/custom.yml`;

      const read = await readFile({ serverId, path });
      const written = await writeFile({
        serverId,
        path,
        traefikConfig: 'tls: {}\n',
      });

      expect(read.status).toBe(400);
      expect((read.body as { message: string }).message).toBe('Invalid path');
      expect(written.status).toBe(400);
      expect(dispatched()).toEqual([]);
    });

    it('refuses a Server’s tree on the platform-host branch', async () => {
      const path = `${traefikRootOn(serverId)}/dynamic/custom.yml`;

      const read = await readFile({ path });
      const written = await writeFile({ path, traefikConfig: 'tls: {}\n' });

      expect(read.status).toBe(400);
      expect(written.status).toBe(400);
    });

    it('still refuses an escape from whichever tree it is confining', async () => {
      const traversal = `${traefikRootOn(serverId)}/../../etc/passwd`;

      expect((await readFile({ serverId, path: '/etc/passwd' })).status).toBe(
        400,
      );
      expect((await readFile({ serverId, path: traversal })).status).toBe(400);
      expect((await readFile({ path: '/etc/passwd' })).status).toBe(400);
      expect(
        (await readFile({ path: `${traefikRootOn(null)}/../escape.yml` }))
          .status,
      ).toBe(400);
      expect(dispatched()).toEqual([]);
    });
  });

  describe('the writer', () => {
    /**
     * The ticket's falsifiable claim, end to end: the Server has a Traefik
     * configuration and the route said it had none.
     */
    it('toggles request logging on a Server that has a Traefik config', async () => {
      const toggled = await toggleRequests({ enable: true, serverId });

      expect(toggled.status).toBe(200);
      // The Server's restart is part of the switch: none is owed.
      expect(toggled.body).toEqual({ written: true, restartRequired: false });
    });

    /**
     * The decisive assertion of this set: the write goes to the file the read
     * read. Both expectations come from the dispatches rather than from this
     * file's opinion, so a root that forks between them fails here whichever of
     * the two is wrong.
     */
    it('writes the config it read, on the machine it read it from', async () => {
      await toggleRequests({ enable: true, serverId });

      expect(reads()).toHaveLength(1);
      expect(writes()).toHaveLength(1);
      const [read] = reads();
      const [write] = writes();
      expect(write.serverId).toBe(read.serverId);
      expect(write.command).toContain(`> ${read.command.slice('cat '.length)}`);
      expect(write.command).not.toContain(configuredRoot);
    });

    it('writes this instance’s own config for the platform host', async () => {
      await request(httpServer)
        .post('/settings/traefik/config')
        .set('Cookie', cookie)
        .send({ traefikConfig: 'entryPoints: {}\n' });

      const toggled = await toggleRequests({ enable: true, serverId: null });

      expect(toggled.status).toBe(200);
      expect(writes()).toEqual([]);
      const config = parse(
        fs.readFileSync(`${configuredRoot}/traefik/traefik.yml`, 'utf8'),
      ) as { accessLog?: { filePath: string } };
      expect(config.accessLog?.filePath).toBeDefined();
    });

    /**
     * `accessLog.filePath` is the one path in this set that is **not** rooted on
     * the machine: Traefik reads it inside its container, where the dynamic
     * directory is mounted at a fixed literal whatever the host root is. So the
     * toggle writes the same string for both machines — and it has to be the
     * string `deploy/install.sh` and `deploy/traefik/traefik.yml.example`
     * already write, or `haveActivateRequests` reads a fresh install as off and
     * the first toggle rewrites a file that was already right. (Not
     * `serverSetupCommand`'s any more: a new remote Server is provisioned with
     * its access log off, ADR-0027.)
     */
    it('names the access log at the path Traefik sees, identically on both machines', async () => {
      await toggleRequests({ enable: true, serverId });
      const onServer = parse(payloadOf(writes()[0].command)) as {
        accessLog: { filePath: string };
      };

      await request(httpServer)
        .post('/settings/traefik/config')
        .set('Cookie', cookie)
        .send({ traefikConfig: 'entryPoints: {}\n' });
      await toggleRequests({ enable: true, serverId: null });
      const onHost = parse(
        fs.readFileSync(`${configuredRoot}/traefik/traefik.yml`, 'utf8'),
      ) as { accessLog: { filePath: string } };

      expect(onServer.accessLog.filePath).toBe(onHost.accessLog.filePath);
      expect(onServer.accessLog.filePath).not.toContain(configuredRoot);
      expect(
        fs.readFileSync(
          nodePath.resolve(
            __dirname,
            '../../../deploy/traefik/traefik.yml.example',
          ),
          'utf8',
        ),
      ).toContain(`filePath: ${onServer.accessLog.filePath}`);
    });
  });

  describe('the consumer', () => {
    /**
     * The third member of the set, and the reason the provider shape had to
     * change with the helpers rather than after them: the container that *reads*
     * `traefik.yml` gets it as a bind mount, and a mount source is a path on the
     * machine the daemon runs on. Under the local root a Traefik recreated on a
     * Server mounted a file that host does not have, and Docker would have
     * created a directory in its place.
     */
    const binds = async (id: string | null) => {
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
      remoteExec.execAsync.mockResolvedValue(ok('standalone\n'));
      remoteExec.execAsyncRemote.mockResolvedValue(ok('standalone\n'));

      await traefikSetup.writeTraefikSetup({ serverId: id, env: [] });
      const created = docker.createContainer.mock.calls[0][0] as {
        HostConfig: { Binds: string[] };
      };
      return created.HostConfig.Binds;
    };

    it('mounts the Server’s own Traefik tree into a Traefik it recreates there', async () => {
      const mounted = await binds(serverId);

      expect(mounted).toEqual([
        `${traefikRootOn(serverId)}/traefik.yml:/etc/traefik/traefik.yml`,
        `${traefikRootOn(serverId)}/dynamic:/etc/cloudgate/traefik/dynamic`,
        '/var/run/docker.sock:/var/run/docker.sock',
      ]);
      expect(mounted.join('\n')).not.toContain(configuredRoot);
    });

    /**
     * The platform host is the machine whose tree moves, and this is the pairing
     * that makes the fixed bind *target* legible: the source follows
     * CLOUDGATE_DIRECTORY, the target does not, and `accessLog.filePath` above
     * is a path on the target side.
     */
    it('mounts this instance’s relocated tree at the path Traefik expects', async () => {
      const mounted = await binds(null);

      expect(mounted).toEqual([
        `${configuredRoot}/traefik/traefik.yml:/etc/traefik/traefik.yml`,
        `${configuredRoot}/traefik/dynamic:/etc/cloudgate/traefik/dynamic`,
        '/var/run/docker.sock:/var/run/docker.sock',
      ]);
    });

    /**
     * And the writer/consumer pair held to each other: the file the toggle
     * rewrites is the file the container is given, taken from the toggle's own
     * dispatch. A root that forks between the two would rewrite one file and
     * serve another.
     */
    it('gives the container the file the toggle rewrote', async () => {
      await toggleRequests({ enable: true, serverId });
      const written = /> (\S+)$/.exec(writes()[0].command.trim())?.[1];

      const mounted = await binds(serverId);

      expect(written).toBeDefined();
      expect(mounted[0]).toBe(`${written}:/etc/traefik/traefik.yml`);
    });
  });
});
