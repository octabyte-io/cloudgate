import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { IncomingMessage } from 'node:http';
import request from 'supertest';
import { App } from 'supertest/types';
import WebSocket from 'ws';
import { ApplicationsService } from '../../src/applications/applications.service';
import { application } from '../../src/applications/application.schema';
import { session } from '../../src/auth/auth.schema';
import { deployment } from '../../src/deployments/deployment.schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import {
  DEPLOYMENT_LOG_RETENTION_DAYS,
  logPresenceProbeCommand,
} from '../../src/deployments/log-retention';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { LocalProcessChannelService } from '../../src/realtime/channels/local-process-channel.service';
import { PtyChannelService } from '../../src/realtime/channels/pty-channel.service';
import { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import type { StreamChannel } from '../../src/realtime/channels/stream-channel';
import { DOCKER_CLIENT } from '../../src/docker/docker-client.provider';
import { SERVER_STATS_COMMAND } from '../../src/monitoring/collectors/server-stats.collector';
import { ContainerLogsGateway } from '../../src/realtime/gateways/container-logs.gateway';
import { ContainerTerminalGateway } from '../../src/realtime/gateways/container-terminal.gateway';
import { DeploymentLogsGateway } from '../../src/realtime/gateways/deployment-logs.gateway';
import {
  DockerStatsGateway,
  STATS_CLOSE,
} from '../../src/realtime/gateways/docker-stats.gateway';
import {
  HOST_SHELL_REFUSAL,
  ServerTerminalGateway,
} from '../../src/realtime/gateways/server-terminal.gateway';
import {
  SHELL_OPEN_FRAME,
  TERMINAL_CLOSE,
} from '../../src/realtime/terminal-protocol';
import { LocalServerSetupService } from '../../src/realtime/local-server-setup.service';
import {
  REAPED_LOG_CLOSE_CODE,
  reapedLogCloseReason,
} from '../../src/realtime/socket-access';
import { HOST_DISKSTATS_COMMAND } from '../../src/realtime/host-stats.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { ServersService } from '../../src/servers/servers.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  secondOrganizationOwner,
  createOrganization,
} from '../utils/test-auth';
import {
  captureJournal,
  cookieHeader,
  FakeChannel,
  permissionCtx,
  waitFor,
} from './realtime.fixture';

jest.setTimeout(120_000);

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
  return { cookie: cookieHeader(res.headers['set-cookie']), id: user.id };
}

async function setUpOwner(httpServer: App) {
  const ownerSession = await signUp(httpServer, owner);
  const orgs = await request(httpServer)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;
  return { organizationId, owner: ownerSession };
}

/** A ws client double: EventEmitter for close/message wiring, spies for output. */
class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  send = jest.fn<void, [string]>();
  ping = jest.fn();
  // `terminate()` is what the keep-alive drops a peer that stopped answering
  // with, and it emits `'close'` on a real socket — so the double does too, or
  // nothing hung off `'close'` would be torn down in a spec.
  terminate = jest.fn(() => {
    this.readyState = 3;
    this.emit('close');
  });
  close = jest.fn<void, [number?, string?]>(() => {
    this.readyState = 3;
    this.emit('close');
  });
}

function wsRequest(pathWithQuery: string, cookie?: string): IncomingMessage {
  return {
    url: pathWithQuery,
    headers: { host: 'localhost', ...(cookie ? { cookie } : {}) },
  } as IncomingMessage;
}

describe('Realtime WebSocket gateways (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let wsAuth: WsAuthGuard;
  let containerLogs: ContainerLogsGateway;
  let deploymentLogs: DeploymentLogsGateway;
  let dockerStats: DockerStatsGateway;
  let containerTerminal: ContainerTerminalGateway;
  let serverTerminal: ServerTerminalGateway;
  let servers: ServersService;
  let sshKeys: SshKeysService;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let deployments: DeploymentsService;
  let permissions: PermissionService;

  const sshChannels = { open: jest.fn<Promise<StreamChannel>, unknown[]>() };
  const ptyChannels = { spawn: jest.fn<StreamChannel, unknown[]>() };
  const localProcesses = { spawn: jest.fn<StreamChannel, unknown[]>() };
  const dockerClient = {
    listContainers: jest.fn<Promise<unknown[]>, unknown[]>(),
  };
  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const localServerSetup = {
    setupSshKey: jest.fn<Promise<string>, []>(),
    getDockerHost: jest.fn<Promise<string>, []>(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: SshChannelService, useValue: sshChannels },
        { provide: PtyChannelService, useValue: ptyChannels },
        { provide: LocalProcessChannelService, useValue: localProcesses },
        { provide: DOCKER_CLIENT, useValue: dockerClient },
        { provide: RemoteExecService, useValue: remoteExec },
        { provide: LocalServerSetupService, useValue: localServerSetup },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    wsAuth = ctx.app.get(WsAuthGuard);
    containerLogs = ctx.app.get(ContainerLogsGateway);
    deploymentLogs = ctx.app.get(DeploymentLogsGateway);
    dockerStats = ctx.app.get(DockerStatsGateway);
    containerTerminal = ctx.app.get(ContainerTerminalGateway);
    serverTerminal = ctx.app.get(ServerTerminalGateway);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    deployments = ctx.app.get(DeploymentsService);
    permissions = ctx.app.get(PermissionService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    sshChannels.open.mockReset();
    ptyChannels.spawn.mockReset();
    localProcesses.spawn.mockReset();
    dockerClient.listContainers.mockReset();
    remoteExec.execAsync.mockReset();
    remoteExec.execAsyncRemote.mockReset();
    // A container-addressed gateway inspects its target's owner labels
    // before it streams. Unless a test says otherwise the target carries none,
    // which makes it an unmanaged container — reached through docker:read,
    // which every fixture's owner holds.
    //
    // This double answers every inspect the same way, which is what suits a file
    // about the plumbing and what makes it useless for the resolution itself: it
    // cannot express a name the daemon holds no container for, so it read a
    // swarm service as an unlabelled container and hid a gateway that had
    // stopped passing `runType`. The by-type double that can is in
    // `container-sockets.e2e-spec.ts`; ask authorization questions there.
    // Four fields: `{{.Name}}` leads the container template, and a
    // fixture still writing three is one short — the labels shift left, the
    // container reads as owned by nobody, and the failure arrives as an
    // authorization denial rather than a parse error.
    const unlabelled = {
      stdout: '/an-unlabelled-container|<no value>|<no value>|<no value>\n',
      stderr: '',
      exitCode: 0,
    };
    remoteExec.execAsync.mockResolvedValue(unlabelled);
    remoteExec.execAsyncRemote.mockResolvedValue(unlabelled);
    localServerSetup.setupSshKey.mockReset();
    localServerSetup.getDockerHost.mockReset();
    await ctx.resetDb();
  });

  async function setUpOwnerWithServer() {
    const { organizationId, owner: ownerSession } =
      await setUpOwner(httpServer);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);
    const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
    const created = await servers.create(ownerCtx, {
      name: 'worker-1',
      ipAddress: '203.0.113.10',
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      serverId: created.serverId,
    };
  }

  /** Creates a second organization and makes it the session's active org, so
   * the caller's cookie now resolves outside the fixture server's org. */
  async function switchToFreshOrganization(ownerSession: { cookie: string }) {
    const secondOrg = await createOrganization(
      httpServer,
      ctx.db,
      ownerSession.cookie,
      { name: 'Second Org' },
    );
    const secondOrgId = (secondOrg.body as { id: string }).id;
    await ctx.db.update(session).set({ activeOrganizationId: secondOrgId });
    return secondOrgId;
  }

  /**
   * An Application with one recorded Deployment — what `/listen-deployment` is
   * addressed by since ADR-0007. `remote` builds it on a Server, which is what
   * puts the log file on that machine rather than on the platform host.
   */
  async function setUpDeployment({ remote = false } = {}) {
    const { organizationId, owner: ownerSession } =
      await setUpOwner(httpServer);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    let serverId: string | null = null;
    if (remote) {
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const created = await servers.create(ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      serverId = created.serverId;
    }

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
      deployTarget: { kind: 'platform-host' },
    });
    const app = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'my-app',
      environmentId: environment.environmentId,
    });
    if (serverId) {
      await ctx.db
        .update(application)
        .set({ serverId })
        .where(eq(application.applicationId, app.applicationId));
    }

    const record = await deployments.create({
      kind: 'application',
      applicationId: app.applicationId,
      title: 'Manual deployment',
      description: '',
    });
    return { organizationId, ownerSession, ownerCtx, app, serverId, record };
  }

  /**
   * What `docker inspect` prints for a container owned by a Swarm service.
   *
   * The container's own `{{.Name}}` leads it — it is what tells the
   * platform's own containers from an operator's hand-started one, both of which
   * resolve to no Service.
   */
  const ownedBy = (swarmServiceName: string, name = '/abc123def456') => ({
    stdout: `${name}|${swarmServiceName}|<no value>|<no value>\n`,
    stderr: '',
    exitCode: 0,
  });

  /**
   * An Application in the owner's organization plus a base member who has *not*
   * been granted it — the shape that matters: authenticated, inside the
   * organization, and not entitled to the Service behind the container.
   */
  async function setUpWithheldService() {
    const { organizationId, owner: ownerSession } =
      await setUpOwner(httpServer);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
      deployTarget: { kind: 'platform-host' },
    });
    const app = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'my-app',
      environmentId: environment.environmentId,
    });

    const invite = await request(httpServer)
      .post('/organizations/invitations')
      .set('Cookie', ownerSession.cookie)
      .send({ email: 'invitee@example.com', role: 'member' });
    const inviteId = (invite.body as { id: string }).id;
    const su = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        password: 'super-secret-password',
      });
    const inviteeCookie = cookieHeader(su.headers['set-cookie']);
    const inviteeId = (su.body as { user: { id: string } }).user.id;
    await request(httpServer)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', inviteeCookie);

    return {
      organizationId,
      ownerSession,
      ownerCtx,
      app,
      invitee: { id: inviteeId, cookie: inviteeCookie },
    };
  }

  /**
   * `setUpWithheldService` plus a Deployment on the withheld Application, and
   * the invitee's session pointed at the organization — the caller the
   * entitlement check has to refuse: authenticated, in the right organization,
   * holding a real deployment id, and never granted the Service that owns it.
   */
  async function setUpWithheldDeployment() {
    const withheld = await setUpWithheldService();
    const record = await deployments.create({
      kind: 'application',
      applicationId: withheld.app.applicationId,
      title: 'Manual deployment',
      description: '',
    });
    await ctx.db
      .update(session)
      .set({ activeOrganizationId: withheld.organizationId })
      .where(eq(session.userId, withheld.invitee.id));
    return { ...withheld, record };
  }

  /**
   * A second signed-in user in the owner's organization, at the role given, and
   * with their session pointed at that organization.
   *
   * The shell on the platform host is what this exists for (ADR-0010): the
   * question there is not *which row* the caller may reach — there is no row —
   * but whether they administer this instance at all, so the fixture varies the
   * one thing that answers it.
   */
  async function setUpColleague(role: 'admin' | 'member') {
    const { organizationId, owner: ownerSession } =
      await setUpOwner(httpServer);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const invite = await request(httpServer)
      .post('/organizations/invitations')
      .set('Cookie', ownerSession.cookie)
      .send({ email: 'invitee@example.com', role });
    const inviteId = (invite.body as { id: string }).id;
    const su = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        password: 'super-secret-password',
      });
    const cookie = cookieHeader(su.headers['set-cookie']);
    const id = (su.body as { user: { id: string } }).user.id;
    await request(httpServer)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', cookie);
    await ctx.db
      .update(session)
      .set({ activeOrganizationId: organizationId })
      .where(eq(session.userId, id));

    return {
      organizationId,
      ownerSession,
      ownerCtx,
      colleague: { id, cookie },
    };
  }

  describe('WS auth', () => {
    it('closes the connection when the request carries no valid session', async () => {
      const ws = new FakeWs();
      const result = await wsAuth.authenticate(
        ws,
        wsRequest('/terminal?serverId=local'),
      );

      expect(result).toBeNull();
      expect(ws.close).toHaveBeenCalledWith();
    });

    it('resolves the user and active organization from the session cookie', async () => {
      const { organizationId, owner: ownerSession } =
        await setUpOwner(httpServer);

      const ws = new FakeWs();
      const result = await wsAuth.authenticate(
        ws,
        wsRequest('/terminal?serverId=local', ownerSession.cookie),
      );

      expect(result).not.toBeNull();
      expect(result?.user.email).toBe(owner.email);
      expect(result?.session.activeOrganizationId).toBe(organizationId);
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe('container logs (/docker-container-logs)', () => {
    it('rejects a missing containerId before auth with 4000', async () => {
      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest('/docker-container-logs'),
      );
      expect(ws.close).toHaveBeenCalledWith(4000, 'containerId not provided');
    });

    it('rejects an invalid tail parameter with 4000', async () => {
      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest('/docker-container-logs?containerId=web-app&tail=99999'),
      );
      expect(ws.close).toHaveBeenCalledWith(4000, 'Invalid tail parameter');
    });

    it('reads follow only once the caller is known: an anonymous caller gets the bare auth close, an owner the 4000', async () => {
      const anonymous = new FakeWs();
      await containerLogs.handleConnection(
        anonymous,
        wsRequest('/docker-container-logs?containerId=web-app&follow=maybe'),
      );
      expect(anonymous.close).toHaveBeenCalledWith();

      const { owner: ownerSession } = await setUpOwner(httpServer);
      const known = new FakeWs();
      await containerLogs.handleConnection(
        known,
        wsRequest(
          '/docker-container-logs?containerId=web-app&follow=maybe',
          ownerSession.cookie,
        ),
      );
      expect(known.close).toHaveBeenCalledWith(
        4000,
        'Invalid follow parameter',
      );
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
    });

    it('closes unauthenticated connections without opening any channel', async () => {
      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest('/docker-container-logs?containerId=web-app'),
      );
      expect(ws.close).toHaveBeenCalledWith();
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
      expect(sshChannels.open).not.toHaveBeenCalled();
    });

    it('streams local docker logs through a pty, forwards input, kills it on close', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest(
          '/docker-container-logs?containerId=web-app',
          ownerSession.cookie,
        ),
      );

      expect(ptyChannels.spawn).toHaveBeenCalledWith(
        expect.any(String),
        [
          '-c',
          'docker container logs --timestamps  --tail 100  --follow web-app',
        ],
        expect.objectContaining({
          name: 'xterm-256color',
          encoding: 'utf8',
          cols: 80,
          rows: 30,
        }),
      );

      channel.emitData('log line 1\n');
      channel.emitData('log line 2\n');
      expect(ws.send).toHaveBeenNthCalledWith(1, 'log line 1\n');
      expect(ws.send).toHaveBeenNthCalledWith(2, 'log line 2\n');

      ws.emit('message', Buffer.from('q'));
      expect(channel.write).toHaveBeenCalledWith('q');

      ws.close();
      expect(channel.close).toHaveBeenCalled();
    });

    it('applies the search filter to the local command', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      ptyChannels.spawn.mockReturnValue(new FakeChannel());

      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest(
          '/docker-container-logs?containerId=web-app&search=error%20500',
          ownerSession.cookie,
        ),
      );

      expect(ptyChannels.spawn).toHaveBeenCalledWith(
        expect.any(String),
        [
          '-c',
          'docker container logs --timestamps  --tail 100  --follow web-app 2>&1 | grep --line-buffered -iF "error 500"',
        ],
        expect.anything(),
      );
      ws.close();
    });

    it('follows remote logs over SSH honoring serverId, with swarm/since/search applied', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const channel = new FakeChannel();
      sshChannels.open.mockResolvedValue(channel);

      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest(
          `/docker-container-logs?containerId=web-app&serverId=${serverId}&runType=swarm&tail=200&since=1h&search=needle`,
          ownerSession.cookie,
        ),
      );

      expect(sshChannels.open).toHaveBeenCalledWith(
        { serverId },
        {
          command:
            'docker service logs --timestamps --raw --tail 200 --since 1h --follow web-app 2>&1 | grep --line-buffered -iF "needle"',
          pty: true,
        },
      );

      channel.emitData('remote line\n');
      channel.emitStderr('remote err\n');
      expect(ws.send).toHaveBeenNthCalledWith(1, 'remote line\n');
      expect(ws.send).toHaveBeenNthCalledWith(2, 'remote err\n');

      // the remote stream closing closes the socket
      channel.emitClose();
      expect(ws.close).toHaveBeenCalled();
    });

    it('closes the socket when the remote stream ends and tears the channel down on ws close', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const channel = new FakeChannel();
      sshChannels.open.mockResolvedValue(channel);

      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest(
          `/docker-container-logs?containerId=web-app&serverId=${serverId}`,
          ownerSession.cookie,
        ),
      );

      ws.close();
      expect(channel.close).toHaveBeenCalled();
    });

    it('reports SSH failures and closes', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      sshChannels.open.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest(
          `/docker-container-logs?containerId=web-app&serverId=${serverId}`,
          ownerSession.cookie,
        ),
      );

      expect(ws.send).toHaveBeenCalledWith('SSH error: connect ECONNREFUSED');
      expect(ws.close).toHaveBeenCalled();
    });

    /**
     * The gateway authenticated the caller and then never asked what the
     * caller was entitled to reach. A container that resolves to a Service is
     * now gated on entitlement to that Service.
     */
    it('closes with 4003 when the container belongs to a Service the caller may not reach', async () => {
      const { ownerSession, invitee, organizationId } =
        await setUpWithheldService();
      await ctx.db
        .update(session)
        .set({ activeOrganizationId: organizationId })
        .where(eq(session.userId, invitee.id));
      remoteExec.execAsync.mockResolvedValue(ownedBy('my-app'));

      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest(
          '/docker-container-logs?containerId=abc123def456',
          invitee.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith(4003, 'Not found or not permitted');
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
      expect(ownerSession).toBeDefined();
    });

    it('streams a managed container to the member entitled to its Service', async () => {
      const { invitee, organizationId, app } = await setUpWithheldService();
      await permissions.addNewService(
        {
          user: { id: invitee.id },
          session: { activeOrganizationId: organizationId },
        },
        app.applicationId,
      );
      await ctx.db
        .update(session)
        .set({ activeOrganizationId: organizationId })
        .where(eq(session.userId, invitee.id));
      remoteExec.execAsync.mockResolvedValue(ownedBy('my-app'));
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest(
          '/docker-container-logs?containerId=abc123def456',
          invitee.cookie,
        ),
      );

      expect(ptyChannels.spawn).toHaveBeenCalled();
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('closes silently for a server outside the active organization', async () => {
      const { serverId, ownerSession } = await setUpOwnerWithServer();
      await switchToFreshOrganization(ownerSession);

      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest(
          `/docker-container-logs?containerId=web-app&serverId=${serverId}`,
          ownerSession.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith();
      expect(ws.send).not.toHaveBeenCalled();
      expect(sshChannels.open).not.toHaveBeenCalled();
    });
  });

  /**
   * ADR-0007: the socket is addressed by deployment id. `logPath` and
   * `serverId` are not read off the URL any more — the gateway resolves both
   * from the row, which is what confines a caller to log files that belong to
   * a Deployment they are entitled to.
   */
  describe('deployment logs (/listen-deployment)', () => {
    it('rejects a missing deploymentId with 4000, once the caller is known', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);

      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest('/listen-deployment', ownerSession.cookie),
      );
      expect(ws.close).toHaveBeenCalledWith(4000, 'deploymentId not provided');
    });

    /**
     * Authentication runs before the query is read, so nothing an anonymous
     * caller gets back describes the request. A *real* deployment id is in the
     * comparison deliberately: the criterion is that an unauthenticated caller
     * cannot tell a valid id from an invalid one, which a test comparing two
     * ids that both do not exist would pass without proving. Validating first
     * made the 4000 an oracle for the gateway's contract, and left the
     * parameter handling one reordering away from being one for the ids.
     */
    it('authenticates before it reads the query', async () => {
      const { record } = await setUpDeployment();
      const closes: unknown[][] = [];

      for (const query of [
        `?deploymentId=${record.deploymentId}`, // exists, and is readable by someone
        '?deploymentId=no-such-deployment',
        '', // no parameter at all
      ]) {
        const ws = new FakeWs();
        await deploymentLogs.handleConnection(
          ws,
          wsRequest(`/listen-deployment${query}`),
        );
        expect(ws.send).not.toHaveBeenCalled();
        closes.push(ws.close.mock.calls.flat());
      }

      // The bare auth close, carrying no code and no reason, three times over.
      expect(closes[0]).toEqual([]);
      expect(closes[1]).toEqual(closes[0]);
      expect(closes[2]).toEqual(closes[0]);
      expect(localProcesses.spawn).not.toHaveBeenCalled();
    });

    it('closes unauthenticated connections without spawning tail', async () => {
      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest('/listen-deployment?deploymentId=dep-1'),
      );
      expect(ws.close).toHaveBeenCalledWith();
      expect(localProcesses.spawn).not.toHaveBeenCalled();
    });

    it('replays the local log from the first line and streams new lines', async () => {
      const { ownerSession, record } = await setUpDeployment();
      const channel = new FakeChannel();
      localProcesses.spawn.mockReturnValue(channel);

      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest(
          `/listen-deployment?deploymentId=${record.deploymentId}`,
          ownerSession.cookie,
        ),
      );

      // tail -n +1 -f: replay the whole file, then follow. The path is the
      // row's, never the caller's.
      expect(localProcesses.spawn).toHaveBeenCalledWith('tail', [
        '-n',
        '+1',
        '-f',
        record.logPath,
      ]);

      channel.emitData('existing log content\n');
      channel.emitData('a new line\n');
      expect(ws.send).toHaveBeenNthCalledWith(1, 'existing log content\n');
      expect(ws.send).toHaveBeenNthCalledWith(2, 'a new line\n');

      channel.emitStderr('no such file\n');
      expect(ws.send).toHaveBeenNthCalledWith(3, 'tail error: no such file\n');

      channel.emitClose(0);
      expect(ws.close).toHaveBeenCalled();
    });

    it('kills the tail process when the socket closes', async () => {
      const { ownerSession, record } = await setUpDeployment();
      const channel = new FakeChannel();
      localProcesses.spawn.mockReturnValue(channel);

      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest(
          `/listen-deployment?deploymentId=${record.deploymentId}`,
          ownerSession.cookie,
        ),
      );

      ws.close();
      expect(channel.close).toHaveBeenCalled();
    });

    it('tails the remote log over SSH via the base64-encoded path', async () => {
      const { ownerSession, serverId, record } = await setUpDeployment({
        remote: true,
      });
      const channel = new FakeChannel();
      sshChannels.open.mockResolvedValue(channel);

      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest(
          `/listen-deployment?deploymentId=${record.deploymentId}`,
          ownerSession.cookie,
        ),
      );

      // The build Server comes off the Application the Deployment belongs to,
      // not off the URL.
      const expectedPath = Buffer.from(record.logPath).toString('base64');
      expect(sshChannels.open).toHaveBeenCalledWith(
        { serverId },
        {
          command: `tail -n +1 -f "$(echo '${expectedPath}' | base64 -d)"`,
        },
      );

      channel.emitData('remote deployment log\n');
      expect(ws.send).toHaveBeenCalledWith('remote deployment log\n');

      channel.emitClose();
      expect(ws.close).toHaveBeenCalled();
    });

    it('ignores a caller-supplied logPath entirely', async () => {
      const { ownerSession, record } = await setUpDeployment();
      const channel = new FakeChannel();
      localProcesses.spawn.mockReturnValue(channel);

      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest(
          `/listen-deployment?deploymentId=${record.deploymentId}` +
            '&logPath=/etc/cloudgate/ssh/id_rsa',
          ownerSession.cookie,
        ),
      );

      expect(localProcesses.spawn).toHaveBeenCalledWith('tail', [
        '-n',
        '+1',
        '-f',
        record.logPath,
      ]);
    });

    /**
     * The shape the entitlement check is really about: authenticated, inside
     * the organization that owns the Deployment, and never granted the Service
     * behind it. An organization mismatch is the easy half — this is the
     * row-level half, and it is the one the entitlement model exists for.
     *
     * The frame count is asserted, not just the close: the vulnerability
     * delivered the host's SSH private key in a single frame 38 ms after open,
     * so a gateway that refuses *after* sending something has still leaked the
     * file it was refusing.
     */
    it('sends zero frames to a member not entitled to the owning Service', async () => {
      const { invitee, record } = await setUpWithheldDeployment();

      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest(
          `/listen-deployment?deploymentId=${record.deploymentId}`,
          invitee.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith(4003, 'Not found or not permitted');
      expect(ws.send).toHaveBeenCalledTimes(0);
      expect(localProcesses.spawn).not.toHaveBeenCalled();
      expect(sshChannels.open).not.toHaveBeenCalled();
    });

    it('streams the log to a member granted the owning Service', async () => {
      const { organizationId, app, invitee, record } =
        await setUpWithheldDeployment();
      await permissions.addNewService(
        permissionCtx(invitee.id, organizationId),
        app.applicationId,
      );
      const channel = new FakeChannel();
      localProcesses.spawn.mockReturnValue(channel);

      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest(
          `/listen-deployment?deploymentId=${record.deploymentId}`,
          invitee.cookie,
        ),
      );

      expect(localProcesses.spawn).toHaveBeenCalledWith('tail', [
        '-n',
        '+1',
        '-f',
        record.logPath,
      ]);
      expect(ws.close).not.toHaveBeenCalled();
    });

    /**
     * The denial is byte-identical for a deployment that does not exist and one
     * the caller may not read, so the socket cannot be used to enumerate
     * deployment ids across organizations.
     */
    it('closes with 4003 for a deployment in another organization', async () => {
      const { ownerSession, record } = await setUpDeployment();
      await switchToFreshOrganization(ownerSession);

      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest(
          `/listen-deployment?deploymentId=${record.deploymentId}`,
          ownerSession.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith(4003, 'Not found or not permitted');
      expect(localProcesses.spawn).not.toHaveBeenCalled();
      expect(sshChannels.open).not.toHaveBeenCalled();
    });

    /**
     * The other half of the byte-identical denial. The wire deliberately loses
     * the difference between "no such deployment" and "not yours", so the
     * journal is the only place it survives — and an operator who cannot tell a
     * broken client from someone walking the id space of another organization
     * has lost the reason the distinction was kept at all. Asserted as
     * carefully as the frames are, because nothing else would notice if the line
     * quietly stopped naming the caller or the id.
     */
    it('records in the journal what the wire refuses to distinguish', async () => {
      const { ownerSession, record } = await setUpDeployment();
      await switchToFreshOrganization(ownerSession);
      const journalOf = captureJournal();

      const notPermitted = new FakeWs();
      await deploymentLogs.handleConnection(
        notPermitted,
        wsRequest(
          `/listen-deployment?deploymentId=${record.deploymentId}`,
          ownerSession.cookie,
        ),
      );

      const notFound = new FakeWs();
      await deploymentLogs.handleConnection(
        notFound,
        wsRequest(
          '/listen-deployment?deploymentId=no-such-deployment',
          ownerSession.cookie,
        ),
      );

      // Identical on the wire, down to the argument list.
      expect(notPermitted.close.mock.calls).toEqual(notFound.close.mock.calls);

      // Told apart in the journal, each line naming the caller and the id.
      const journal = journalOf();
      const refusedRow = journal.find((l) => l.includes(record.deploymentId));
      const refusedUnknown = journal.find((l) =>
        l.includes('no-such-deployment'),
      );
      expect(journal).toHaveLength(2);
      // Not merely two different strings — the interpolated ids alone would
      // satisfy that, and would go on satisfying it if both lines carried the
      // same reason. The reason is the half that tells an operator which of the
      // two actually happened.
      // The row is read org-scoped, so the reason for a foreign id is
      // the one the journal alone carries, not the 404's message.
      expect(refusedRow).toContain(
        'Deployment belongs to another organization',
      );
      expect(refusedRow).not.toContain('Deployment not found');
      expect(refusedUnknown).toContain('Deployment not found');
      expect(refusedRow).toContain(ownerSession.id);
      expect(refusedUnknown).toContain(ownerSession.id);
    });

    it('closes with the same 4003 for a deployment that does not exist', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);

      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest(
          '/listen-deployment?deploymentId=no-such-deployment',
          ownerSession.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith(4003, 'Not found or not permitted');
      expect(localProcesses.spawn).not.toHaveBeenCalled();
    });

    /**
     * ADR-0020 keeps a deployment log for 90 days and reaps what
     * is older; `GET /deployments/:id/logs` answers a sentence naming the
     * window past it. This socket follows the *same* `logPath` (ADR-0007) and
     * answered nothing at all — `tail -n +1 -f` on a file that is not there
     * follows nothing for ever — so the two readers of one artifact disagreed
     * about whether its absence was explicable. ADR-0020's last bullet recorded
     * exactly this as filed rather than fixed.
     */
    describe('a log retention has reaped', () => {
      /** Ages the row rather than the file, which is what a reaped log is:
       *  the exec layer is doubled here and no file was ever written, so the
       *  row's own `createdAt` is the only thing that separates *"reaped"* from
       *  *"this build has written nothing yet"* — `log-retention.ts`'s whole
       *  argument, and the same helper `log-retention.e2e-spec.ts` uses. */
      async function age(deploymentId: string, days: number) {
        await ctx.db
          .update(deployment)
          .set({
            createdAt: new Date(
              Date.now() - days * 24 * 60 * 60 * 1000,
            ).toISOString(),
          })
          .where(eq(deployment.deploymentId, deploymentId));
      }

      /**
       * What the machine answers when the gateway asks whether the log file is
       * still there — the probe `logPresenceProbeCommand` sends and
       * `readLogFileAbsence` reads.
       *
       * Every test in this block says which of the two answers the machine
       * gives, and that is the property rather than fixture noise: past the
       * window the close is a claim about **the file**, so a test that does not
       * say what the file is cannot make that claim. The close used to be
       * decided by the row's age alone, and every test here passed without ever
       * naming a file state — which is how the socket came to close `4013` on a
       * log `GET /deployments/:id/logs` was still streaming.
       */
      const probeSays = (
        answer: 'present' | 'absent',
        logPath: string,
        otherwise: ExecResult = { stdout: '', stderr: '', exitCode: 0 },
      ) => {
        // Matched against the program the code builds rather than against a
        // string this file spells, so the double cannot answer a probe the
        // gateway has stopped sending — the same rule as asserting on
        // `logPresenceProbeCommand`'s output below.
        const probe = logPresenceProbeCommand(logPath);
        const reply = (command: string) =>
          Promise.resolve(
            command === probe
              ? { stdout: `${answer}\n`, stderr: '', exitCode: 0 }
              : otherwise,
          );
        remoteExec.execAsync.mockImplementation(reply);
        remoteExec.execAsyncRemote.mockImplementation(
          (_serverId: string, command: string) => reply(command),
        );
      };

      it('closes with the retention notice rather than following a file that is gone', async () => {
        const { ownerSession, record } = await setUpDeployment();
        await age(record.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 10);
        probeSays('absent', record.logPath);

        const ws = new FakeWs();
        await deploymentLogs.handleConnection(
          ws,
          wsRequest(
            `/listen-deployment?deploymentId=${record.deploymentId}`,
            ownerSession.cookie,
          ),
        );

        expect(ws.close).toHaveBeenCalledWith(
          REAPED_LOG_CLOSE_CODE,
          reapedLogCloseReason(),
        );
        // The notice reaches the operator on the *close*, not in the stream.
        // Nothing was sent, so nothing can render in the log well as though
        // the build had printed it.
        expect(ws.send).toHaveBeenCalledTimes(0);
        expect(localProcesses.spawn).not.toHaveBeenCalled();
        expect(sshChannels.open).not.toHaveBeenCalled();
      });

      /**
       * The assertion this whole block is about. An earlier fix closed a
       * disagreement between the two readers of one log and left the *same*
       * disagreement pointing the other way: HTTP asks absence **and** age
       * (`readLogs`: `if (!stdout.trim() && isPastLogRetention(createdAt))`)
       * while the socket asked age **alone**. So for a Deployment past the
       * window whose file is still there — which is not hypothetical: the sweep
       * is a nightly cron, `-mtime +N` keeps a file up to a day longer than the
       * constant says, and a Server unreachable at 04:20 is skipped entirely
       * while every row on it keeps ageing — HTTP streamed the log and the
       * socket said it had been reaped.
       */
      it('streams a past-retention Deployment whose log file is still there, because absence is the question and age is only the proxy', async () => {
        const { ownerSession, record } = await setUpDeployment();
        await age(record.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 400);
        probeSays('present', record.logPath);
        const channel = new FakeChannel();
        localProcesses.spawn.mockReturnValue(channel);

        const ws = new FakeWs();
        await deploymentLogs.handleConnection(
          ws,
          wsRequest(
            `/listen-deployment?deploymentId=${record.deploymentId}`,
            ownerSession.cookie,
          ),
        );

        expect(localProcesses.spawn).toHaveBeenCalledWith('tail', [
          '-n',
          '+1',
          '-f',
          record.logPath,
        ]);
        // Not closed, and in particular not `4013`: telling an operator their
        // log was reaped while the other reader is serving it is the defect,
        // not a conservative answer.
        expect(ws.close).not.toHaveBeenCalled();
      });

      it('reads the same log the HTTP route reads, in the one state the two disagreed in', async () => {
        // The ticket's own falsifiable claim, both readers in one test and in
        // one state: the row is past the window and the file is still there.
        // Asserted as *what each one does with the machine* rather than
        // against a literal, so neither can drift into answering the notice
        // again on its own.
        const { ownerSession, ownerCtx, record } = await setUpDeployment();
        await age(record.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 400);
        probeSays('present', record.logPath, {
          stdout: 'Initializing deployment\n',
          stderr: '',
          exitCode: 0,
        });
        localProcesses.spawn.mockReturnValue(new FakeChannel());

        const overHttp = await deployments.readLogs(
          ownerCtx,
          record.deploymentId,
          100,
        );
        const ws = new FakeWs();
        await deploymentLogs.handleConnection(
          ws,
          wsRequest(
            `/listen-deployment?deploymentId=${record.deploymentId}`,
            ownerSession.cookie,
          ),
        );

        expect(overHttp).toBe('Initializing deployment\n');
        expect(localProcesses.spawn).toHaveBeenCalled();
        expect(ws.close).not.toHaveBeenCalled();
      });

      it('asks the machine that holds the log, with the program the read would have used', async () => {
        // The probe is one round trip on the rare past-retention path and it
        // goes to the build host, not to the platform host — a probe answered
        // by the wrong machine would say `absent` about every remote build's
        // log at once (ADR-0018).
        const { ownerSession, record, serverId } = await setUpDeployment({
          remote: true,
        });
        await age(record.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 10);
        probeSays('absent', record.logPath);

        await deploymentLogs.handleConnection(
          new FakeWs(),
          wsRequest(
            `/listen-deployment?deploymentId=${record.deploymentId}`,
            ownerSession.cookie,
          ),
        );

        expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
          serverId,
          logPresenceProbeCommand(record.logPath),
        );
        expect(remoteExec.execAsync).not.toHaveBeenCalledWith(
          logPresenceProbeCommand(record.logPath),
        );
      });

      it('streams rather than closing when the probe cannot answer at all', async () => {
        // `isPastLogRetention`'s own bias, one artifact along: an unreadable
        // `createdAt` reads as *inside* the window because telling an operator
        // their log was reaped when the truth is that nothing could tell is
        // worse than saying nothing. An unreachable machine is the same
        // ignorance, so the socket falls through to the tail — which then
        // reports the transport failure itself, exactly as it did before this
        // gateway knew about retention at all.
        const { ownerSession, record } = await setUpDeployment();
        await age(record.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 10);
        remoteExec.execAsync.mockRejectedValue(new Error('no route to host'));
        localProcesses.spawn.mockReturnValue(new FakeChannel());

        const ws = new FakeWs();
        await deploymentLogs.handleConnection(
          ws,
          wsRequest(
            `/listen-deployment?deploymentId=${record.deploymentId}`,
            ownerSession.cookie,
          ),
        );

        expect(ws.close).not.toHaveBeenCalledWith(
          REAPED_LOG_CLOSE_CODE,
          expect.anything(),
        );
        expect(localProcesses.spawn).toHaveBeenCalled();
      });

      it('says the same thing the HTTP read says about the same Deployment', async () => {
        // The property the ticket is actually about: one artifact, two readers,
        // one answer. Asserted against the route rather than against a literal,
        // so a reworded notice cannot leave the two disagreeing again — the
        // socket's is the route's sentence, elided to fit a close frame.
        const { ownerSession, ownerCtx, record } = await setUpDeployment();
        await age(record.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 1);
        // The file is gone on both readers' side of the machine: the probe says
        // so, and what `tail … 2>/dev/null || echo ""` answers for a file that
        // is not there is the same thing it answers for one that is empty.
        probeSays('absent', record.logPath);

        const overHttp = await deployments.readLogs(
          ownerCtx,
          record.deploymentId,
          100,
        );

        const ws = new FakeWs();
        await deploymentLogs.handleConnection(
          ws,
          wsRequest(
            `/listen-deployment?deploymentId=${record.deploymentId}`,
            ownerSession.cookie,
          ),
        );
        const [, reason] = ws.close.mock.calls[0] as [number, string];

        expect(overHttp.trim().startsWith(reason.replace(/…$/, ''))).toBe(true);
      });

      it('still streams a Deployment one day inside the window', async () => {
        // The boundary in the direction that matters: a socket that refused a
        // log still on disk would be a worse defect than the silence it
        // replaces, and `-mtime +N` keeps a file up to a day longer than the
        // constant says, so the read errs the same way.
        const { ownerSession, record } = await setUpDeployment();
        await age(record.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS - 1);
        const channel = new FakeChannel();
        localProcesses.spawn.mockReturnValue(channel);

        const ws = new FakeWs();
        await deploymentLogs.handleConnection(
          ws,
          wsRequest(
            `/listen-deployment?deploymentId=${record.deploymentId}`,
            ownerSession.cookie,
          ),
        );

        expect(localProcesses.spawn).toHaveBeenCalledWith('tail', [
          '-n',
          '+1',
          '-f',
          record.logPath,
        ]);
        expect(ws.close).not.toHaveBeenCalled();
        // And the common case pays nothing for this: inside the window a
        // missing file is still *"nothing written yet"* and the socket still
        // waits for it, so there is no question to ask the machine. (The one
        // call this double has already seen is `initializeLog`'s, from
        // `setUpDeployment`.)
        expect(remoteExec.execAsync).not.toHaveBeenCalledWith(
          logPresenceProbeCommand(record.logPath),
        );
      });

      it('records the reaped close under its own verb, not as a refusal', async () => {
        // Not a refusal — nobody was denied anything — so the verb is its own
        // and `grep -c 'Refused socket:'` stays the count of connect-time
        // denials. The count this one buys is its own: how often
        // operators reach for a log the window has already taken is the
        // evidence that would reopen the size of the window.
        const { ownerSession, record } = await setUpDeployment();
        await age(record.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 10);
        probeSays('absent', record.logPath);
        const refusals = captureJournal();
        const lines = jest.spyOn(Logger.prototype, 'log');

        try {
          await deploymentLogs.handleConnection(
            new FakeWs(),
            wsRequest(
              `/listen-deployment?deploymentId=${record.deploymentId}`,
              ownerSession.cookie,
            ),
          );

          const reaped = lines.mock.calls
            .map(([message]) => String(message))
            .filter((message) => message.startsWith('Reaped log socket:'));
          expect(reaped).toHaveLength(1);
          expect(reaped[0]).toContain(record.deploymentId);
          expect(reaped[0]).toContain(ownerSession.id);
          expect(refusals()).toEqual([]);
        } finally {
          lines.mockRestore();
        }
      });
    });
  });

  describe('docker stats (/listen-docker-stats-monitoring)', () => {
    // The wss handler's per-container docker stats format (it also carries
    // the Container placeholder, unlike the metrics agent's).
    const statsCommand = (id: string) =>
      `docker stats ${id} --no-stream --format '{"BlockIO":"{{.BlockIO}}","CPUPerc":"{{.CPUPerc}}","Container":"{{.Container}}","ID":"{{.ID}}","MemPerc":"{{.MemPerc}}","MemUsage":"{{.MemUsage}}","Name":"{{.Name}}","NetIO":"{{.NetIO}}"}'`;

    const statsLine = JSON.stringify({
      BlockIO: '1.2MB / 3.4MB',
      CPUPerc: '12.34%',
      Container: 'abc123',
      ID: 'abc123',
      MemPerc: '25.50%',
      MemUsage: '512.5MiB / 2GiB',
      Name: 'testapp-x1',
      NetIO: '1.45kB / 656B',
    });

    const ok = (stdout: string): ExecResult => ({
      stdout,
      stderr: '',
      exitCode: 0,
    });

    // The same hand-worked composite output as the monitoring suite: cpu 25%,
    // mem 6/8 GB = 75%, disk 5/9 of 100 GB, net 101/51 MB.
    const HOST_STATS_OUTPUT = `===CLOUDGATE_CPU===
cpu  1000 50 300 8000 200 0 50 0 0 0
cpu  1200 60 330 8700 250 0 60 0 0 0
===CLOUDGATE_CPUINFO===
processor\t: 0
===CLOUDGATE_MEMINFO===
MemTotal:        8388608 kB
MemAvailable:    2097152 kB
===CLOUDGATE_DISK===
Filesystem        1-blocks        Used   Available Capacity Mounted on
/dev/vda1     107374182400 53687091200 42949672960      56% /
===CLOUDGATE_NET===
Inter-|   Receive                                                |  Transmit
    lo: 1048576    1000    0    0    0     0          0         0  1048576    1000    0    0    0     0       0          0
  eth0: 104857600  50000    0    0    0     0          0         0 52428800   30000    0    0    0     0       0          0
===CLOUDGATE_UPTIME===
123456.78 654321.90
===CLOUDGATE_HOST===
5.15.0-91-generic
x86_64
1
===CLOUDGATE_OS===
PRETTY_NAME="Ubuntu 22.04.3 LTS"
`;

    // sda: 2048 sectors read (1 MiB), 4096 written (2 MiB); loop0 excluded.
    const DISKSTATS_OUTPUT = `   8       0 sda 5000 0 2048 100 3000 0 4096 200 0 0 0
   7       0 loop0 100 0 99999 10 50 0 88888 5 0 0 0
`;

    /** Addressed by appName, so it resolves its owner without inspecting
     * anything — and was the one of the three with no server check at all. */
    it('closes with 4003 when appName names a Service the caller may not reach', async () => {
      const { invitee, organizationId } = await setUpWithheldService();
      await ctx.db
        .update(session)
        .set({ activeOrganizationId: organizationId })
        .where(eq(session.userId, invitee.id));

      const ws = new FakeWs();
      await dockerStats.handleConnection(
        ws,
        wsRequest(
          '/listen-docker-stats-monitoring?appName=my-app',
          invitee.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith(4003, 'Not found or not permitted');
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('rejects a missing appName with 4000', async () => {
      const ws = new FakeWs();
      await dockerStats.handleConnection(
        ws,
        wsRequest('/listen-docker-stats-monitoring'),
      );
      expect(ws.close).toHaveBeenCalledWith(4000, 'appName not provided');
    });

    it('streams the container sample each tick takes', async () => {
      dockerClient.listContainers.mockResolvedValue([
        { Id: 'abc123', State: 'running' },
      ]);
      remoteExec.execAsync.mockResolvedValue(ok(statsLine));

      const ws = new FakeWs();
      await dockerStats.collectAndSend(ws, 'testapp', 'application', 'service');

      expect(dockerClient.listContainers).toHaveBeenCalledWith({
        filters: JSON.stringify({
          status: ['running'],
          label: ['com.docker.swarm.service.name=testapp'],
        }),
      });
      expect(remoteExec.execAsync).toHaveBeenCalledWith(statsCommand('abc123'));

      expect(ws.send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(ws.send.mock.calls[0][0]) as {
        data: Record<string, { value: unknown } | null>;
      };
      expect(payload.data.cpu?.value).toBe('12.34%');
      expect(payload.data.memory?.value).toEqual({
        used: '512.5MiB',
        total: '2GiB',
      });
      expect(payload.data.network?.value).toEqual({
        inputMb: '1.45kB',
        outputMb: '656B',
      });
      expect(payload.data.block?.value).toEqual({
        readMb: '1.2MB',
        writeMb: '3.4MB',
      });
      expect(payload.data.disk).toBeNull();

      // Each tick sends the sample it just took.
      remoteExec.execAsync.mockResolvedValue(
        ok(statsLine.replace('12.34%', '99.99%')),
      );
      await dockerStats.collectAndSend(ws, 'testapp', 'application', 'service');
      const second = JSON.parse(ws.send.mock.calls[1][0]) as {
        data: { cpu: { value: string } };
      };
      expect(second.data.cpu.value).toBe('99.99%');
    });

    it('filters by task name for stacks and by project label or exact name for compose', async () => {
      dockerClient.listContainers.mockResolvedValue([]);

      await dockerStats.collectAndSend(
        new FakeWs(),
        'stackapp',
        'stack',
        'container',
      );
      expect(dockerClient.listContainers).toHaveBeenLastCalledWith({
        filters: JSON.stringify({
          status: ['running'],
          label: ['com.docker.swarm.task.name=stackapp'],
        }),
      });

      // A Compose the socket was authorized as is its own project's
      // containers, by an exact label rather than Docker's substring `name`
      // filter.
      await dockerStats.collectAndSend(
        new FakeWs(),
        'composeapp',
        'docker-compose',
        'service',
      );
      expect(dockerClient.listContainers).toHaveBeenLastCalledWith({
        filters: JSON.stringify({
          status: ['running'],
          label: ['com.docker.compose.project=composeapp'],
        }),
      });

      // A container name is narrowed by the daemon's filter and then kept
      // only on an exact match.
      await dockerStats.collectAndSend(
        new FakeWs(),
        'composeapp',
        'docker-compose',
        'container',
      );
      expect(dockerClient.listContainers).toHaveBeenLastCalledWith({
        filters: JSON.stringify({
          status: ['running'],
          name: ['composeapp'],
        }),
      });
    });

    /**
     * Was `'closes with 4000 when no matching container is running'`.
     * That code was the connect-time validators' band, and reusing it for a
     * post-authorization runtime state is what made "no Service owns this name"
     * distinguishable from "a Service in another organization does" — the
     * enumeration oracle ADR-0008 forbids. This caller has already been
     * authorized against this container, so a specific reason costs nothing.
     */
    it('closes with 4011 and a reason that names no id when the container it was sampling stops', async () => {
      dockerClient.listContainers.mockResolvedValue([]);

      const ws = new FakeWs();
      await dockerStats.collectAndSend(ws, 'testapp', 'application', 'service');

      expect(ws.close).toHaveBeenCalledWith(
        STATS_CLOSE.workloadGone,
        STATS_CLOSE.workloadGoneReason,
      );
      expect(STATS_CLOSE.workloadGoneReason).not.toContain('testapp');
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('streams host system stats for the cloudgate appName', async () => {
      remoteExec.execAsync.mockImplementation((command: string) => {
        if (command === SERVER_STATS_COMMAND) {
          return Promise.resolve(ok(HOST_STATS_OUTPUT));
        }
        if (command === HOST_DISKSTATS_COMMAND) {
          return Promise.resolve(ok(DISKSTATS_OUTPUT));
        }
        return Promise.reject(new Error(`unexpected command: ${command}`));
      });

      const ws = new FakeWs();
      await dockerStats.collectAndSend(
        ws,
        'cloudgate',
        'application',
        'container',
      );

      expect(dockerClient.listContainers).not.toHaveBeenCalled();
      const payload = JSON.parse(ws.send.mock.calls[0][0]) as {
        data: Record<string, { value: unknown }>;
      };
      expect(payload.data.cpu.value).toBe('25.00%');
      expect(payload.data.memory.value).toEqual({
        used: '6.00GiB',
        total: '8.00GiB',
      });
      // MiB, what the collector divides by.
      expect(payload.data.network.value).toEqual({
        inputMb: '101.00MiB',
        outputMb: '51.00MiB',
      });
      expect(payload.data.block.value).toEqual({
        readMb: '1.00MiB',
        writeMb: '2.00MiB',
      });
      expect(payload.data.disk.value).toEqual({
        diskTotal: 100,
        diskUsedPercentage: 55.56,
        diskUsage: 55.56,
        diskFree: 44.44,
      });
    });

    /**
     * Was `'closes the tick loop with the error message when sampling fails'`
     * — it pinned the leak. `Error: ${message}` on the wire was an
     * internal detail no HTTP route would have been allowed to return (§2.5),
     * from a catch covering `listContainers`, `execAsync`, `JSON.parse` and
     * `advancedStats.record`. And a failure is the system failing to *answer*
     * rather than answering "no", so ADR-0005's split says it must not end a
     * stream: a socket whose peer or authorization has genuinely gone is ended
     * by the keep-alive and the lease, not by one bad tick.
     */
    it('keeps the socket open and journals a tick that failed', async () => {
      dockerClient.listContainers.mockRejectedValue(new Error('daemon down'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      try {
        const ws = new FakeWs();
        await dockerStats.collectAndSend(
          ws,
          'testapp',
          'application',
          'service',
        );

        expect(ws.close).not.toHaveBeenCalled();
        expect(
          warn.mock.calls.some(([line]) =>
            String(line).includes('daemon down'),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('samples on an interval and stops when the socket closes', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      dockerClient.listContainers.mockResolvedValue([
        { Id: 'abc123', State: 'running' },
      ]);
      remoteExec.execAsync.mockResolvedValue(ok(statsLine));

      const ws = new FakeWs();
      await dockerStats.handleConnection(
        ws,
        wsRequest(
          '/listen-docker-stats-monitoring?appName=testapp',
          ownerSession.cookie,
        ),
      );

      /**
       * **Waited for rather than slept through.** The gateway samples every
       * 1300ms (`docker-stats.gateway.ts`), so a fixed 1500ms sleep left 200ms
       * of slack and failed intermittently — caught in a full run where 79
       * containerised suites were competing for the machine, and passing on its
       * own every time. A poll asserts the same thing without racing the clock.
       */
      await waitFor(() => ws.send.mock.calls.length > 0);

      ws.close();
      const sends = ws.send.mock.calls.length;
      // Still a fixed wait, and it can stay one: this asserts nothing *more*
      // arrives, so a slow machine cannot make it pass when it should fail.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(ws.send.mock.calls.length).toBe(sends);
    });
  });

  describe('container terminal (/docker-container-terminal)', () => {
    it('rejects a missing containerId with 4000', async () => {
      const ws = new FakeWs();
      await containerTerminal.handleConnection(
        ws,
        wsRequest('/docker-container-terminal'),
      );
      expect(ws.close).toHaveBeenCalledWith(4000, 'containerId not provided');
    });

    it('rejects a shell outside the allowlist', async () => {
      const ws = new FakeWs();
      await containerTerminal.handleConnection(
        ws,
        wsRequest(
          '/docker-container-terminal?containerId=web-app&activeWay=perl',
        ),
      );
      expect(ws.close).toHaveBeenCalledWith(4000, 'Invalid shell specified');
    });

    it('execs into the local container through a pty, defaulting to sh', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const ws = new FakeWs();
      await containerTerminal.handleConnection(
        ws,
        wsRequest(
          '/docker-container-terminal?containerId=web-app',
          ownerSession.cookie,
        ),
      );

      // The session variable is what a close ends the shell by.
      expect(ptyChannels.spawn).toHaveBeenCalledWith(
        'docker',
        [
          'exec',
          '-it',
          '-e',
          expect.stringMatching(/^CLOUDGATE_TERMINAL=[0-9a-f]{32}$/),
          '-w',
          '/',
          'web-app',
          'sh',
        ],
        {},
      );

      channel.emitData('$ ');
      expect(ws.send).toHaveBeenCalledWith('$ ');

      ws.emit('message', Buffer.from('ls -la\r'));
      expect(channel.write).toHaveBeenCalledWith('ls -la\r');

      ws.close();
      expect(channel.close).toHaveBeenCalled();
    });

    /**
     * The shape React StrictMode gives every Shell-tab visit: a socket opened
     * and closed at once, while the gateway is still authenticating it. Its
     * `'close'` has already fired by the time a shell would start, so the
     * reaper hangs off an event that will not come again, and the
     * shell stayed in the container for good.
     */
    it('starts no shell for a socket that closed while it was being authorized', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      ptyChannels.spawn.mockReturnValue(new FakeChannel());

      const ws = new FakeWs();
      const connecting = containerTerminal.handleConnection(
        ws,
        wsRequest(
          '/docker-container-terminal?containerId=web-app',
          ownerSession.cookie,
        ),
      );
      ws.close();
      await connecting;

      expect(ptyChannels.spawn).not.toHaveBeenCalled();
    });

    it('execs into the remote container over SSH with the chosen shell', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const channel = new FakeChannel();
      sshChannels.open.mockResolvedValue(channel);

      const ws = new FakeWs();
      await containerTerminal.handleConnection(
        ws,
        wsRequest(
          `/docker-container-terminal?containerId=web-app&activeWay=bash&serverId=${serverId}`,
          ownerSession.cookie,
        ),
      );

      expect(sshChannels.open).toHaveBeenCalledWith(
        { serverId },
        {
          command: expect.stringMatching(
            /^docker exec -it -e CLOUDGATE_TERMINAL\\=[0-9a-f]{32} -w \/ web-app bash$/,
          ) as string,
          pty: true,
        },
      );

      channel.emitData('root@web-app:/# ');
      expect(ws.send).toHaveBeenCalledWith('root@web-app:/# ');

      ws.emit('message', 'exit\r');
      expect(channel.write).toHaveBeenCalledWith('exit\r');

      // The shell ended, not the container, and the socket ends with it
      // — `container-terminal-close.spec.ts` has the rest of that.
      channel.emitClose(0);
      expect(ws.send).toHaveBeenCalledWith(
        '\r\nThe shell exited with code 0.\r\n',
      );
      expect(ws.close).toHaveBeenCalledWith(1000, 'shell exited with code 0');
    });

    /**
     * The sharp one: an interactive shell inside any container on the host was
     * reachable with authentication alone, on a platform whose containers hold
     * application secrets and database data.
     */
    it('closes with 4003 when the container belongs to a Service the caller may not reach', async () => {
      const { invitee, organizationId } = await setUpWithheldService();
      await ctx.db
        .update(session)
        .set({ activeOrganizationId: organizationId })
        .where(eq(session.userId, invitee.id));
      remoteExec.execAsync.mockResolvedValue(ownedBy('my-app'));

      const ws = new FakeWs();
      await containerTerminal.handleConnection(
        ws,
        wsRequest(
          '/docker-container-terminal?containerId=abc123def456',
          invitee.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith(4003, 'Not found or not permitted');
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
    });

    /** A base member's role grants `docker: []`, so an unmanaged container —
     * Traefik, the platform's own — stays out of reach. */
    it('closes with 4003 for an unmanaged container reached by a base member', async () => {
      const { invitee, organizationId } = await setUpWithheldService();
      await ctx.db
        .update(session)
        .set({ activeOrganizationId: organizationId })
        .where(eq(session.userId, invitee.id));

      const ws = new FakeWs();
      await containerTerminal.handleConnection(
        ws,
        wsRequest(
          '/docker-container-terminal?containerId=abc123def456',
          invitee.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith(4003, 'Not found or not permitted');
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
    });

    it('closes silently for a server outside the active organization', async () => {
      const { serverId, ownerSession } = await setUpOwnerWithServer();
      await switchToFreshOrganization(ownerSession);

      const ws = new FakeWs();
      await containerTerminal.handleConnection(
        ws,
        wsRequest(
          `/docker-container-terminal?containerId=web-app&serverId=${serverId}`,
          ownerSession.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith();
      expect(sshChannels.open).not.toHaveBeenCalled();
    });

    it('resizes the container pty on a control frame and types everything else', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const ws = new FakeWs();
      await containerTerminal.handleConnection(
        ws,
        wsRequest(
          '/docker-container-terminal?containerId=web-app',
          ownerSession.cookie,
        ),
      );

      ws.emit('message', Buffer.from('\x00{"cols":120,"rows":40}'));
      expect(channel.resize).toHaveBeenCalledWith(120, 40);

      // Ctrl-Space is a NUL and is a keystroke, not a control frame.
      ws.emit('message', Buffer.from('\x00'));
      // A control frame asking for an impossible window is refused, and is not
      // typed into the shell either.
      ws.emit('message', Buffer.from('\x00{"cols":0,"rows":40}'));
      ws.emit('message', Buffer.from('top\r'));

      expect(channel.write.mock.calls).toEqual([['\x00'], ['top\r']]);
      expect(channel.resize).toHaveBeenCalledTimes(1);
    });

    it('opens the remote container pty at the size the browser sent while SSH was dialling', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      sshChannels.open.mockResolvedValue(new FakeChannel());

      const ws = new FakeWs();
      const connected = containerTerminal.handleConnection(
        ws,
        wsRequest(
          `/docker-container-terminal?containerId=web-app&serverId=${serverId}`,
          ownerSession.cookie,
        ),
      );
      // The browser sizes itself the moment the socket opens, which is well
      // before the SSH channel behind it exists.
      ws.emit('message', Buffer.from('\x00{"cols":150,"rows":45}'));
      await connected;

      expect(sshChannels.open).toHaveBeenCalledWith(
        { serverId },
        {
          command: expect.stringMatching(
            /^docker exec -it -e CLOUDGATE_TERMINAL\\=[0-9a-f]{32} -w \/ web-app sh$/,
          ) as string,
          pty: true,
          cols: 150,
          rows: 45,
        },
      );
    });
  });

  describe('server terminal (/terminal)', () => {
    it('closes when no serverId is provided', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest('/terminal', ownerSession.cookie),
      );
      expect(ws.close).toHaveBeenCalledWith(
        TERMINAL_CLOSE.badRequest,
        'serverId not provided',
      );
      expect(sshChannels.open).not.toHaveBeenCalled();
    });

    it('dials nothing for a socket that closed while it was being authorized', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      sshChannels.open.mockResolvedValue(new FakeChannel());

      const ws = new FakeWs();
      const connecting = serverTerminal.handleConnection(
        ws,
        wsRequest(`/terminal?serverId=${serverId}`, ownerSession.cookie),
      );
      ws.close();
      await connecting;

      expect(sshChannels.open).not.toHaveBeenCalled();
    });

    it('opens an SSH shell on the server and bridges input/output', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const channel = new FakeChannel();
      sshChannels.open.mockResolvedValue(channel);

      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest(`/terminal?serverId=${serverId}`, ownerSession.cookie),
      );

      expect(sshChannels.open).toHaveBeenCalledWith({ serverId }, {});
      // Connecting banner, then the shell-open frame the console's pill waits
      // for, then the terminal-clear escape once ready.
      expect(ws.send).toHaveBeenNthCalledWith(1, 'Connecting...\r\n');
      expect(ws.send).toHaveBeenNthCalledWith(2, SHELL_OPEN_FRAME);
      expect(ws.send).toHaveBeenNthCalledWith(3, '\x1bc');

      channel.emitData('Welcome to Ubuntu\n');
      expect(ws.send).toHaveBeenCalledWith('Welcome to Ubuntu\n');

      ws.emit('message', Buffer.from('uptime\r'));
      expect(channel.write).toHaveBeenCalledWith('uptime\r');

      channel.emitClose(0);
      // Not "Container": the far end of `/terminal` is a pty behind an SSH
      // channel, on a Server or on the platform host.
      expect(ws.send).toHaveBeenCalledWith(
        '\r\nThe shell exited with code 0.\r\n',
      );
    });

    it('reports an SSH authentication failure', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const authError = Object.assign(new Error('Auth failed'), {
        level: 'client-authentication',
      });
      sshChannels.open.mockRejectedValue(authError);

      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest(`/terminal?serverId=${serverId}`, ownerSession.cookie),
      );

      expect(ws.send).toHaveBeenCalledWith(
        'Authentication failed: Unauthorized private SSH key or username.\r\n❌  Error: Auth failed client-authentication',
      );
    });

    it('reports non-auth SSH connection errors', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      sshChannels.open.mockRejectedValue(new Error('connect ETIMEDOUT'));

      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest(`/terminal?serverId=${serverId}`, ownerSession.cookie),
      );

      expect(ws.send).toHaveBeenCalledWith(
        'SSH connection error: connect ETIMEDOUT ❌ ',
      );
    });

    it('connects to the local docker host with the generated key', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      localServerSetup.setupSshKey.mockResolvedValue('PRIVATE_KEY');
      localServerSetup.getDockerHost.mockResolvedValue('localhost');
      const channel = new FakeChannel();
      sshChannels.open.mockResolvedValue(channel);

      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest(
          '/terminal?serverId=local&port=2222&username=root',
          ownerSession.cookie,
        ),
      );

      expect(ws.send).toHaveBeenNthCalledWith(
        1,
        'Setting up private SSH key...\r\n',
      );
      expect(ws.send).toHaveBeenNthCalledWith(
        2,
        'Found Docker host: localhost\r\n',
      );
      expect(ws.send).toHaveBeenNthCalledWith(3, 'Connecting...\r\n');
      expect(sshChannels.open).toHaveBeenCalledWith(
        {
          connection: {
            host: 'localhost',
            port: 2222,
            username: 'root',
            privateKey: 'PRIVATE_KEY',
            // The platform host has no Server row to record a host key on.
            hostKey: expect.objectContaining({
              verifier: expect.any(Function) as unknown,
            }) as unknown,
          },
        },
        {},
      );
    });

    /**
     * Who may open a shell on the machine Cloudgate runs on (ADR-0010).
     *
     * `serverId=local` is not an id in anyone's id space: it names the host
     * serving the console, it has no Server row, and so `findAuthorizedServer`
     * — the check the other branch of this gateway makes — has nothing to
     * resolve. Until this gate the branch asked only whether the caller was
     * signed in, which handed a root shell on the platform host to every member
     * of every organization on the instance, and the "This host" card turned
     * that from a hand-built URL into a button.
     */
    describe('a shell on the platform host', () => {
      it('refuses a base member of the organization, saying why', async () => {
        const { colleague } = await setUpColleague('member');
        const refusals = captureJournal();

        const ws = new FakeWs();
        await serverTerminal.handleConnection(
          ws,
          wsRequest(
            '/terminal?serverId=local&port=22&username=root',
            colleague.cookie,
          ),
        );

        expect(ws.close).toHaveBeenCalledWith(
          TERMINAL_CLOSE.forbidden,
          HOST_SHELL_REFUSAL,
        );
        // Nothing on the host was touched: no key generated, no SSH dialled.
        expect(localServerSetup.setupSshKey).not.toHaveBeenCalled();
        expect(sshChannels.open).not.toHaveBeenCalled();
        // The operator's copy names who it was.
        expect(refusals()).toContainEqual(
          expect.stringContaining(colleague.id),
        );
      });

      it('opens it for an admin', async () => {
        const { colleague } = await setUpColleague('admin');
        localServerSetup.setupSshKey.mockResolvedValue('PRIVATE_KEY');
        localServerSetup.getDockerHost.mockResolvedValue('localhost');
        sshChannels.open.mockResolvedValue(new FakeChannel());

        const ws = new FakeWs();
        await serverTerminal.handleConnection(
          ws,
          wsRequest(
            '/terminal?serverId=local&port=22&username=root',
            colleague.cookie,
          ),
        );

        expect(sshChannels.open).toHaveBeenCalledWith(
          {
            connection: {
              host: 'localhost',
              port: 22,
              username: 'root',
              privateKey: 'PRIVATE_KEY',
              // The platform host has no Server row to record a host key on.
              hostKey: expect.objectContaining({
                verifier: expect.any(Function) as unknown,
              }) as unknown,
            },
          },
          {},
        );
      });

      /**
       * H-63. ADR-0010 answered "do you administer this instance" with the
       * caller's role in whichever organization they happened to be acting in,
       * and said so in its own last consequence: *"There is no instance-level
       * authority in this codebase to gate on … If an instance-level role is
       * ever introduced, this is one of the call sites that should move to
       * it."* ADR-0013 introduced one, and this is the call site it named.
       *
       * Until it moved, an owner of a second Organization — never a Member of
       * the first — held a **root shell on the platform host**: every
       * organization's containers, the Postgres this instance runs on, and the
       * encryption secret every `encryptedText` column is sealed with. Strictly
       * more than any Traefik file H-52 was fixed to protect, behind the same
       * question asked of the wrong organization.
       *
       * The two tests above vary the *role* inside one organization, which is
       * what ADR-0010's gate could tell apart. Neither varies the organization,
       * which is the only thing that distinguishes the old answer from the new
       * one — and a gateway is where the sweep's tell is least visible, because
       * there is no `checkServerAccess` call here to look absent.
       */
      it("refuses another organization's owner, saying why", async () => {
        const { owner: ownerSession } = await setUpOwner(httpServer);
        const mallory = await secondOrganizationOwner(
          httpServer,
          ctx.db,
          ownerSession.cookie,
        );
        const refusals = captureJournal();

        const ws = new FakeWs();
        await serverTerminal.handleConnection(
          ws,
          wsRequest(
            '/terminal?serverId=local&port=22&username=root',
            cookieHeader(mallory.cookie),
          ),
        );

        expect(ws.close).toHaveBeenCalledWith(
          TERMINAL_CLOSE.forbidden,
          HOST_SHELL_REFUSAL,
        );
        // Nothing on the host was touched: no key generated, no SSH dialled.
        expect(localServerSetup.setupSshKey).not.toHaveBeenCalled();
        expect(sshChannels.open).not.toHaveBeenCalled();
        // The operator's copy names who it was.
        expect(refusals()).toContainEqual(expect.stringContaining(mallory.id));
      });

      /**
       * The no-op claim: on the single-organization install `deploy/install.sh`
       * produces, the one Organization is the instance organization, so its
       * owner keeps the host shell. The admin case is the test above this
       * block, which now passes for the new reason rather than the old one.
       */
      it("leaves the single-organization install's owner exactly as they were", async () => {
        const { owner: ownerSession } = await setUpOwner(httpServer);
        localServerSetup.setupSshKey.mockResolvedValue('PRIVATE_KEY');
        localServerSetup.getDockerHost.mockResolvedValue('localhost');
        sshChannels.open.mockResolvedValue(new FakeChannel());

        const ws = new FakeWs();
        await serverTerminal.handleConnection(
          ws,
          wsRequest(
            '/terminal?serverId=local&port=22&username=root',
            ownerSession.cookie,
          ),
        );

        expect(ws.close).not.toHaveBeenCalled();
        expect(sshChannels.open).toHaveBeenCalled();
      });
    });

    /**
     * The Server branch asks the same question the Server's own routes ask.
     * `GET /servers/:id` is `@RequirePermission('server', 'read')` and
     * `memberRole` grants no `server` action at all, so a base member cannot so
     * much as list the fleet — and could still be handed a root SSH shell on
     * any machine in it by naming its id here.
     */
    it('refuses a Server shell to a member, byte-identically to an unknown id', async () => {
      const { ownerCtx, colleague } = await setUpColleague('member');
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const created = await servers.create(ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });

      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest(`/terminal?serverId=${created.serverId}`, colleague.cookie),
      );

      // Silent and codeless, exactly as for a Server that does not exist:
      // a member cannot see the fleet, so this must not confirm an id (ADR-0008).
      expect(ws.close).toHaveBeenCalledWith();
      expect(sshChannels.open).not.toHaveBeenCalled();
    });

    it('closes the local terminal when port or username is missing', async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);

      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest('/terminal?serverId=local&port=2222', ownerSession.cookie),
      );

      // Not a bare close: 1005 with no reason is the bug, since it is
      // indistinguishable from a dropped connection.
      expect(ws.close).toHaveBeenCalledWith(
        TERMINAL_CLOSE.badRequest,
        'port and username are required for serverId=local',
      );
      expect(localServerSetup.setupSshKey).not.toHaveBeenCalled();
    });

    it('closes silently for a server outside the active organization', async () => {
      const { serverId, ownerSession } = await setUpOwnerWithServer();
      await switchToFreshOrganization(ownerSession);

      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest(`/terminal?serverId=${serverId}`, ownerSession.cookie),
      );

      expect(ws.close).toHaveBeenCalledWith();
      expect(sshChannels.open).not.toHaveBeenCalled();
    });

    it('resizes the shell on a control frame and types everything else', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const channel = new FakeChannel();
      sshChannels.open.mockResolvedValue(channel);

      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest(`/terminal?serverId=${serverId}`, ownerSession.cookie),
      );

      ws.emit('message', Buffer.from('\x00{"cols":200,"rows":50}'));
      ws.emit('message', Buffer.from('vim\r'));

      expect(channel.resize).toHaveBeenCalledWith(200, 50);
      // The literal JSON must never reach the shell — the whole point of the
      // resize message.
      expect(channel.write.mock.calls).toEqual([['vim\r']]);
    });

    it('opens the shell at the size the browser sent while SSH was dialling', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      sshChannels.open.mockResolvedValue(new FakeChannel());

      const ws = new FakeWs();
      const connected = serverTerminal.handleConnection(
        ws,
        wsRequest(`/terminal?serverId=${serverId}`, ownerSession.cookie),
      );
      ws.emit('message', Buffer.from('\x00{"cols":150,"rows":45}'));
      await connected;

      expect(sshChannels.open).toHaveBeenCalledWith(
        { serverId },
        { cols: 150, rows: 45 },
      );
    });
  });

  describe('WebSocket upgrade round-trip', () => {
    it('routes a real ws connection by path, authenticates the cookie and streams', async () => {
      const { ownerSession, record } = await setUpDeployment();
      const channel = new FakeChannel();
      localProcesses.spawn.mockReturnValue(channel);

      await ctx.app.listen(0);
      const address = (
        ctx.app.getHttpServer() as unknown as {
          address(): { port: number };
        }
      ).address();

      const client = new WebSocket(
        `ws://127.0.0.1:${address.port}/listen-deployment?deploymentId=${record.deploymentId}`,
        { headers: { cookie: ownerSession.cookie } },
      );
      const received: string[] = [];
      client.on('message', (data) =>
        received.push((data as Buffer).toString()),
      );
      await new Promise((resolve, reject) => {
        client.on('open', resolve);
        client.on('error', reject);
      });

      // handleConnection authenticates asynchronously after the upgrade.
      await waitFor(() => localProcesses.spawn.mock.calls.length > 0);
      channel.emitData('streamed over a real socket\n');
      await waitFor(() => received.length > 0);

      expect(received).toEqual(['streamed over a real socket\n']);

      client.close();
      await waitFor(() => channel.close.mock.calls.length > 0);
    });

    it('closes an unauthenticated real ws connection', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${
          (
            ctx.app.getHttpServer() as unknown as {
              address(): { port: number };
            }
          ).address().port
        }/listen-deployment?deploymentId=dep-1`,
      );

      const closed = await new Promise<boolean>((resolve, reject) => {
        client.on('close', () => resolve(true));
        client.on('error', reject);
      });
      expect(closed).toBe(true);
      expect(localProcesses.spawn).not.toHaveBeenCalled();
    });
  });
});
