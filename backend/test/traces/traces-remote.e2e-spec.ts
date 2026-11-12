import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application,
  compose,
  licenseKey,
  member,
  organizationRole,
  server as serverTable,
  traceStore,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ServerConnection } from '../../src/remote/server-key.provider';
import { SERVER_KEY_PROVIDER } from '../../src/remote/server-key.provider';
import { SshForwardService } from '../../src/remote/ssh-forward.service';
import { withArgvExec } from '../utils/exec-double';
import { startSshForwardServer } from '../utils/ssh-forward-server';
import type { SshForwardServer } from '../utils/ssh-forward-server';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Traces on a remote Server (spec slice 3, ADR-0028): the Trace
 * store of a Service on a remote Server is started, sized, read and reclaimed
 * **on that Server**, and read through the backend over an SSH `forwardOut`
 * channel — never through the Server's edge.
 *
 * The doubles are the spec's, plus one real thing:
 * - `RemoteExecService` records every command with the machine it was sent to
 *   (`null` being the platform host), so each test says which machine and that
 *   the other was asked nothing — a wrong-machine defect is invisible to a test
 *   that asserts only the words (ADR-0018).
 * - The Trace store's UI is a local stub HTTP server.
 * - **The remote Server's sshd is a real SSH server in this process**
 *   (`test/utils/ssh-forward-server.ts`), which dials the forwarded port here,
 *   as sshd dials it on its own machine. `SERVER_KEY_PROVIDER` points at it,
 *   so the proxy's channel is the real `SshForwardService` over real SSH, and
 *   the test observes what the Server was asked to reach.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The store's container, spelled out rather than rebuilt (§1.7). */
const STORE = 'cloudgate-trace-store-application-web';
/** Its directory on a remote Server, whose platform root is `/etc/cloudgate`. */
const REMOTE_STORE_DIRECTORY = '/etc/cloudgate/applications/web/traces';

type ExecOptions = { env?: Record<string, string | undefined> };

describe('Traces on a remote Server (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let sshd: SshForwardServer;

  /** Whether the remote daemon answers the store's inspect as running. */
  let storeRunning: boolean;
  /** Whether the remote Server answers SSH at all. */
  let serverReachable: boolean;
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string): Promise<ExecResult> => {
    if (command.startsWith('docker container inspect')) {
      return storeRunning
        ? Promise.resolve(ok('true\n'))
        : Promise.reject(new Error(`Error: No such container: ${STORE}`));
    }
    if (command.startsWith('docker port')) {
      return storeRunning
        ? Promise.resolve(ok(`127.0.0.1:${storePort}\n`))
        : Promise.reject(new Error(`Error: No such container: ${STORE}`));
    }
    if (command.startsWith('du -sk')) {
      return storeRunning
        ? Promise.resolve(ok(`2048\t${REMOTE_STORE_DIRECTORY}\n`))
        : Promise.reject(new Error('du: cannot access: No such file'));
    }
    return Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, ExecOptions?]>(),
    execAsyncRemote: jest.fn<
      Promise<ExecResult>,
      [string, string, unknown?, ExecOptions?]
    >(),
  });

  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };

  /** Which SSH endpoint the key provider answers for the remote Server. */
  const getConnection = jest.fn<Promise<ServerConnection>, [string]>();

  const storeHears: {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
  }[] = [];
  const store: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      storeHears.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":["frontend"]}');
    });
  });
  let storePort: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => store.listen(0, '127.0.0.1', resolve));
    storePort = (store.address() as AddressInfo).port;
    sshd = await startSshForwardServer();
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: SERVER_KEY_PROVIDER, useValue: { getConnection } },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    await sshd.close();
    store.closeAllConnections();
    await new Promise((resolve) => store.close(resolve));
  });

  let ownerCookie: string;
  let environmentId: string;
  let serverId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    storeRunning = false;
    serverReachable = true;
    storeHears.length = 0;
    // A Server's pooled SSH connection outlives a request; each test starts
    // with none, so what it counts is its own.
    ctx.app.get(SshForwardService).closeAll();
    await sshd.allClosed();
    sshd.forwards.length = 0;
    sshd.connections.length = 0;
    sshd.execs.length = 0;
    // The remote Server's shell, as the pooled connection's `exec` reaches it:
    // `docker port` prints the store's loopback port while it runs.
    sshd.execAnswer = (command) =>
      command.startsWith('docker port') && storeRunning
        ? { stdout: `127.0.0.1:${storePort}\n`, code: 0 }
        : { stderr: `Error: No such container: ${STORE}\n`, code: 1 };
    getConnection.mockReset().mockResolvedValue(sshd.connection);
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) =>
        serverReachable
          ? machine(command)
          : Promise.reject(
              new Error(
                'SSH connection error: connect ETIMEDOUT 203.0.113.9:22',
              ),
            ),
      );
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks
      .mockReset()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-09-29T00:00:00Z' } },
      ]);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', ownerCookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    serverId = await addServer(organizationId, 'hetzner-eu', '203.0.113.9');
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', ownerCookie)
      .send({ name: 'shop' });
    const environment = await request(httpServer)
      .post('/environments')
      .set('Cookie', ownerCookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
        // The organization has a Server, so the choice is asked for.
        deployTarget: { kind: 'server', serverId },
      });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;
  });

  async function addServer(organizationId: string, name: string, ip: string) {
    const [row] = await ctx.db
      .insert(serverTable)
      .values({ name, ipAddress: ip, port: 22, organizationId })
      .returning();
    return row.serverId;
  }

  /** An Application on the remote Server that ships a prebuilt image. */
  async function addApplication(appName = 'web'): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({ name: appName, appName, environmentId, serverId });
    expect(res.status).toBe(201);
    const { applicationId } = res.body as { applicationId: string };
    const patched = await request(httpServer)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', ownerCookie)
      .send({ sourceType: 'docker', dockerImage: 'nginx:1.27' });
    expect(patched.status).toBe(200);
    return applicationId;
  }

  function putTraces(serviceId: string, body: Record<string, unknown>) {
    return request(httpServer)
      .put(`/traces/${serviceId}?serviceType=application`)
      .set('Cookie', ownerCookie)
      .send(body);
  }

  async function tracedApplication(): Promise<string> {
    const applicationId = await addApplication();
    expect((await putTraces(applicationId, { enabled: true })).status).toBe(
      200,
    );
    return applicationId;
  }

  async function deploy(applicationId: string): Promise<void> {
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(applicationId);
    await ctx.app.get(DeploymentEngineService).deploy(deployable);
  }

  /** Every command, with the machine it was sent to (`null`: platform host). */
  function dispatched(): {
    serverId: string | null;
    command: string;
    env: Record<string, string | undefined>;
  }[] {
    return [
      ...execMock.execAsync.mock.calls.map(([command, options]) => ({
        serverId: null,
        command,
        env: options?.env ?? {},
      })),
      ...execMock.execAsyncRemote.mock.calls.map(
        ([on, command, , options]) => ({
          serverId: on,
          command,
          env: options?.env ?? {},
        }),
      ),
    ];
  }

  /** The commands that name this store, on whichever machine. */
  const aboutTheStore = () =>
    dispatched().filter(
      ({ command }) =>
        command.includes(STORE) || command.includes(REMOTE_STORE_DIRECTORY),
    );

  const clearExec = () => {
    execMock.execAsync.mockClear();
    execMock.execAsyncRemote.mockClear();
  };

  async function memberOn(accessedServices: string[]): Promise<string> {
    const member_ = await signUpMember(httpServer, ownerCookie);
    const [row] = await ctx.db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, member_.id));
    await ctx.db.insert(licenseKey).values({
      organizationId: row.organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values({
      organizationId: row.organizationId,
      role: 'reader',
      permission: { service: ['read'] },
    });
    await ctx.db
      .update(member)
      .set({ role: 'reader', accessedServices })
      .where(
        and(
          eq(member.userId, member_.id),
          eq(member.organizationId, row.organizationId),
        ),
      );
    return member_.cookie;
  }

  describe('the store on its Server', () => {
    it('starts the store on the remote Server at deploy, and nothing on the platform host', async () => {
      const applicationId = await tracedApplication();
      clearExec();

      await deploy(applicationId);

      const starts = aboutTheStore().filter(({ command }) =>
        command.includes('docker run'),
      );
      expect(starts).toHaveLength(1);
      expect(starts[0].serverId).toBe(serverId);
      expect(starts[0].command).toContain(REMOTE_STORE_DIRECTORY);
      // shell-quoted: `127.0.0.1\:\:16686`, loopback only.
      expect(starts[0].command).toMatch(/--publish 127\.0\.0\.1\\:\\:16686 /);
      expect(starts[0].env.CG_TRACE_STORE_CONFIG).toContain(
        `base_path: "/backend/traces/${applicationId}/ui"`,
      );
      expect(aboutTheStore().filter(({ serverId: on }) => on === null)).toEqual(
        [],
      );

      const call = docker.createService.mock.lastCall as unknown[];
      const env = (
        call[call.length - 1] as {
          TaskTemplate: { ContainerSpec: { Env: string[] } };
        }
      ).TaskTemplate.ContainerSpec.Env;
      expect(env).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT=http://${STORE}:4318`);
    });

    it('reads the store’s state and size on the remote Server, and nothing on the platform host', async () => {
      const applicationId = await tracedApplication();
      storeRunning = true;
      clearExec();

      const read = await request(httpServer)
        .get(`/traces/${applicationId}?serviceType=application`)
        .set('Cookie', ownerCookie);

      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        storeRunning: true,
        storeSizeBytes: 2048 * 1024,
      });
      expect(
        aboutTheStore().map(({ serverId: on, command }) => [on, command]),
      ).toEqual(
        expect.arrayContaining([
          [
            serverId,
            expect.stringMatching(
              /^docker container inspect .* cloudgate-trace-store-application-web$/,
            ),
          ],
          [serverId, `du -sk ${REMOTE_STORE_DIRECTORY}`],
        ]),
      );
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('removes the store container and directory on the remote Server when traces are turned off', async () => {
      const applicationId = await tracedApplication();
      await deploy(applicationId);
      clearExec();

      const off = await putTraces(applicationId, { enabled: false });

      expect(off.status).toBe(200);
      expect(off.body).not.toHaveProperty('unreclaimedArtifacts');
      expect(
        aboutTheStore().map(({ serverId: on, command }) => [on, command]),
      ).toEqual([
        [serverId, `docker rm --force ${STORE}`],
        [serverId, `rm -rf ${REMOTE_STORE_DIRECTORY}`],
      ]);
    });

    it('removes the store container and directory on the remote Server when the Application is deleted', async () => {
      const applicationId = await tracedApplication();
      await deploy(applicationId);
      clearExec();

      const deleted = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);

      expect(deleted.status).toBe(200);
      expect(deleted.body).not.toHaveProperty('unreclaimedArtifacts');
      expect(
        aboutTheStore().map(({ serverId: on, command }) => [on, command]),
      ).toEqual([
        [serverId, `docker rm --force ${STORE}`],
        [serverId, `rm -rf ${REMOTE_STORE_DIRECTORY}`],
      ]);
      expect(await ctx.db.select().from(traceStore)).toEqual([]);
    });

    /**
     * ADR-0018's rule for a Server that cannot be reached, applied as
     * written: the presence read cannot confirm the workload gone, so the
     * Delete is refused and keeps everything, the store included; with
     * `?force=true` it goes ahead and names what it left on that Server.
     */
    it('follows the unreachable-Server rule: refused without force, and with it deleted with the store named as left behind', async () => {
      const applicationId = await tracedApplication();
      await deploy(applicationId);
      serverReachable = false;

      const refused = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);
      expect(refused.status).toBe(409);
      expect(await ctx.db.select().from(traceStore)).toHaveLength(1);

      const forced = await request(httpServer)
        .delete(`/applications/${applicationId}?force=true`)
        .set('Cookie', ownerCookie);

      expect(forced.status).toBe(200);
      const left = (
        forced.body as { unreclaimedArtifacts: { kind: string }[] }
      ).unreclaimedArtifacts.filter(({ kind }) => kind === 'trace-store');
      expect(left).toEqual([
        { kind: 'trace-store', appName: 'web', serverId, path: STORE },
        {
          kind: 'trace-store',
          appName: 'web',
          serverId,
          path: REMOTE_STORE_DIRECTORY,
        },
      ]);
      expect(
        await ctx.db
          .select()
          .from(application)
          .where(eq(application.applicationId, applicationId)),
      ).toEqual([]);
      expect(aboutTheStore().filter(({ serverId: on }) => on === null)).toEqual(
        [],
      );
    });
  });

  /**
   * Where `cookie`'s Trace store frame sends its requests, as the backend
   * receives them: minted with the session, then used without it, as the
   * sandboxed frame does (ADR-0075).
   */
  async function framed(serviceId: string, cookie: string): Promise<string> {
    const res = await request(httpServer)
      .get(`/traces/${serviceId}/frame`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { uiPath: string }).uiPath.slice('/backend'.length);
  }

  describe('the proxy', () => {
    it('carries an entitled Member’s read over an SSH channel to the store’s loopback port on its Server', async () => {
      const applicationId = await tracedApplication();
      storeRunning = true;
      const cookie = await memberOn([applicationId]);
      const path = await framed(applicationId, cookie);
      clearExec();

      const res = await request(httpServer)
        .get(`${path}/api/v3/services`)
        .query('limit=5');

      expect(res.status).toBe(200);
      expect(res.text).toBe('{"data":["frontend"]}');
      // The Server's sshd was asked for its own loopback port, the one
      // `docker port` read on that Server.
      expect(getConnection).toHaveBeenCalledWith(serverId);
      expect(sshd.forwards).toEqual([
        { destIP: '127.0.0.1', destPort: storePort },
      ]);
      // Read over the same SSH connection the channel then took: one
      // handshake for both, and no exec of its own.
      expect(sshd.execs).toEqual([`docker port ${STORE} 16686`]);
      expect(sshd.connections).toHaveLength(1);
      expect(aboutTheStore()).toEqual([]);
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(storeHears.map(({ method, url }) => [method, url])).toEqual([
        ['GET', `/backend/traces/${applicationId}/ui/api/v3/services?limit=5`],
      ]);
      const [row] = await ctx.db.select().from(traceStore);
      expect(storeHears[0].headers.authorization).toBe(
        `Basic ${Buffer.from(`cloudgate:${row.queryCredential}`).toString('base64')}`,
      );
      expect(storeHears[0].headers.cookie).toBeUndefined();
      // The connection is kept for the next request, and ended at shutdown.
      expect(sshd.connections).toEqual([{ closed: false }]);
      ctx.app.get(SshForwardService).closeAll();
      await sshd.allClosed();
    });

    it('carries a burst of concurrent reads, as one UI page makes, over one SSH connection', async () => {
      const applicationId = await tracedApplication();
      storeRunning = true;
      const path = await framed(applicationId, ownerCookie);

      const answers = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          request(httpServer).get(`${path}/static/asset-${i}.js`),
        ),
      );

      expect(answers.map((res) => res.status)).toEqual(Array(12).fill(200));
      expect(sshd.connections).toHaveLength(1);
      expect(sshd.execs).toHaveLength(12);
      expect(sshd.forwards).toHaveLength(12);
      expect(storeHears).toHaveLength(12);
    });

    it('refuses a Member entitled only to another Service before any channel opens', async () => {
      const applicationId = await tracedApplication();
      storeRunning = true;
      const other = await addApplication('api');
      const cookie = await memberOn([other]);
      clearExec();

      // No frame token for them, so nothing their browser could send.
      const res = await request(httpServer)
        .get(`/traces/${applicationId}/frame`)
        .set('Cookie', cookie);

      expect(res.status).toBe(403);
      expect(getConnection).not.toHaveBeenCalled();
      expect(sshd.connections).toEqual([]);
      expect(sshd.forwards).toEqual([]);
      expect(dispatched()).toEqual([]);
      expect(storeHears).toEqual([]);
    });

    it('answers 502 when the Server’s SSH cannot be reached, naming neither the machine nor the failure', async () => {
      const applicationId = await tracedApplication();
      storeRunning = true;
      getConnection.mockResolvedValue({
        ...sshd.connection,
        privateKey: sshd.wrongKey,
      });

      const res = await request(httpServer).get(
        `${await framed(applicationId, ownerCookie)}/search`,
      );

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        message: "The Trace store's Server could not be reached over SSH",
      });
      expect(res.text).not.toMatch(/Authentication|127\.0\.0\.1|203\.0\.113/);
      expect(storeHears).toEqual([]);
      await sshd.allClosed();
    });

    it('answers 409 when the store on the remote Server is not running, and opens no channel to it', async () => {
      const applicationId = await tracedApplication();

      const res = await request(httpServer).get(
        `${await framed(applicationId, ownerCookie)}/search`,
      );

      expect(res.status).toBe(409);
      expect(sshd.execs).toEqual([`docker port ${STORE} 16686`]);
      expect(sshd.forwards).toEqual([]);
    });
  });

  /**
   * No operation moves a Service to another Server: `serverId` is set when the
   * Service is created and never after. ADR-0028's move rule — reclaim the old
   * store, start an empty one on the new Server, never migrate traces — exists
   * only on paper, and the Trace store code assumes the Server never changes.
   * **If either update route ever accepts `serverId`, that rule must be built
   * with it**, and this pin is what goes red first.
   *
   * Today both update schemas strip an unknown key rather than answering 400,
   * so a `serverId` is dropped and the rest of the update applies. Each case
   * sends a rename beside it, because an update with nothing left to set
   * answers 500 (drizzle's "No values to set"), which is its own defect.
   */
  describe('create-only serverId', () => {
    it('does not move an Application to another Server on update', async () => {
      const applicationId = await addApplication();
      const [row] = await ctx.db
        .select({ organizationId: serverTable.organizationId })
        .from(serverTable)
        .where(eq(serverTable.serverId, serverId));
      const elsewhere = await addServer(
        row.organizationId,
        'hetzner-us',
        '198.51.100.20',
      );

      const res = await request(httpServer)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie)
        .send({ name: 'Renamed', serverId: elsewhere });

      // The route drops the key and applies the rest.
      expect(res.status).toBe(200);
      const [stored] = await ctx.db
        .select({ serverId: application.serverId })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(stored.serverId).toBe(serverId);
    });

    it('does not move a Compose to another Server on update', async () => {
      const created = await request(httpServer)
        .post('/compose')
        .set('Cookie', ownerCookie)
        .send({ name: 'stack', appName: 'stack', environmentId, serverId });
      expect(created.status).toBe(201);
      const { composeId } = created.body as { composeId: string };
      const [row] = await ctx.db
        .select({ organizationId: serverTable.organizationId })
        .from(serverTable)
        .where(eq(serverTable.serverId, serverId));
      const elsewhere = await addServer(
        row.organizationId,
        'hetzner-us',
        '198.51.100.20',
      );

      const res = await request(httpServer)
        .patch(`/compose/${composeId}`)
        .set('Cookie', ownerCookie)
        .send({ name: 'Renamed', serverId: elsewhere });

      // The route drops the key and applies the rest.
      expect(res.status).toBe(200);
      const [stored] = await ctx.db
        .select({ serverId: compose.serverId })
        .from(compose)
        .where(eq(compose.composeId, composeId));
      expect(stored.serverId).toBe(serverId);
    });
  });
});
