import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import * as path from 'node:path';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { session } from '../../src/auth/auth.schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { DOCKER_CLIENT } from '../../src/docker/docker-client.provider';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { organizationRole } from '../../src/enterprise/custom-roles/custom-role.schema';
import { licenseKey } from '../../src/enterprise/license/license.schema';
import { member } from '../../src/organizations/organizations.schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { LocalProcessChannelService } from '../../src/realtime/channels/local-process-channel.service';
import { PtyChannelService } from '../../src/realtime/channels/pty-channel.service';
import { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import type { StreamChannel } from '../../src/realtime/channels/stream-channel';
import { ContainerLogsGateway } from '../../src/realtime/gateways/container-logs.gateway';
import { ContainerTerminalGateway } from '../../src/realtime/gateways/container-terminal.gateway';
import { DeploymentLogsGateway } from '../../src/realtime/gateways/deployment-logs.gateway';
import { DockerStatsGateway } from '../../src/realtime/gateways/docker-stats.gateway';
import { ServerSetupGateway } from '../../src/realtime/gateways/server-setup.gateway';
import { ServerTerminalGateway } from '../../src/realtime/gateways/server-terminal.gateway';
import {
  LEASE_CLOSE_CODE,
  LEASE_CLOSE_REASON,
  LEASE_RENEWAL_INTERVAL,
} from '../../src/realtime/socket-access';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner } from '../utils/test-auth';
import {
  cookieHeader,
  FakeChannel,
  permissionCtx,
  waitFor,
} from './realtime.fixture';

jest.setTimeout(120_000);

/**
 * Every gateway holds an authorization lease, and none of them may stop
 * (ADR-0012).
 *
 * **This file is deliberately an enumeration.** A type cannot express "call this
 * function", so nothing in the compiler notices a seventh gateway that
 * authorizes at connect and never again — which is exactly the defect this
 * guards, once present in all six at once. So the cases below are keyed by the
 * *filenames* in `src/realtime/gateways/`, and the first test asserts that key
 * set against the directory: adding a gateway without giving it a lease fails
 * here, by name, before it can ship. It is the same move ADR-0009 makes in
 * asserting an exact key set rather than the absence of one field, because the
 * invariant is about what a future edit might add.
 *
 * The renewal interval is shortened through its DI token — the one override the
 * constant exists to allow — because what is under test is the lifecycle, not
 * the 30 seconds.
 */
const RENEWAL_MS = 50;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** A ws client double: EventEmitter for the close wiring, spies for output. */
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

function wsRequest(pathWithQuery: string, cookie: string): IncomingMessage {
  return {
    url: pathWithQuery,
    headers: { host: 'localhost', cookie },
  } as IncomingMessage;
}

describe('Realtime gateway leases (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let containerLogs: ContainerLogsGateway;
  let containerTerminal: ContainerTerminalGateway;
  let deploymentLogs: DeploymentLogsGateway;
  let dockerStats: DockerStatsGateway;
  let serverTerminal: ServerTerminalGateway;
  let serverSetup: ServerSetupGateway;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let deployments: DeploymentsService;
  let servers: ServersService;
  let sshKeys: SshKeysService;

  const sshChannels = { open: jest.fn<Promise<StreamChannel>, unknown[]>() };
  const ptyChannels = { spawn: jest.fn<StreamChannel, unknown[]>() };
  const localProcesses = { spawn: jest.fn<StreamChannel, unknown[]>() };
  const dockerClient = {
    listContainers: jest.fn<Promise<unknown[]>, unknown[]>(),
  };
  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<
      Promise<ExecResult>,
      [string, string, ((data: string) => void)?]
    >(),
  });
  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: SshChannelService, useValue: sshChannels },
        { provide: PtyChannelService, useValue: ptyChannels },
        { provide: LocalProcessChannelService, useValue: localProcesses },
        { provide: DOCKER_CLIENT, useValue: dockerClient },
        { provide: RemoteExecService, useValue: remoteExec },
        { provide: LEASE_RENEWAL_INTERVAL, useValue: RENEWAL_MS },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    containerLogs = ctx.app.get(ContainerLogsGateway);
    containerTerminal = ctx.app.get(ContainerTerminalGateway);
    deploymentLogs = ctx.app.get(DeploymentLogsGateway);
    dockerStats = ctx.app.get(DockerStatsGateway);
    serverTerminal = ctx.app.get(ServerTerminalGateway);
    serverSetup = ctx.app.get(ServerSetupGateway);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    deployments = ctx.app.get(DeploymentsService);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
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
    sshChannels.open.mockResolvedValue(new FakeChannel());
    ptyChannels.spawn.mockReturnValue(new FakeChannel());
    localProcesses.spawn.mockReturnValue(new FakeChannel());
    dockerClient.listContainers.mockResolvedValue([]);
    // An unlabelled container: unmanaged, so reached through machine-level
    // `docker:read`, which the fixture's owner holds. What is under test is the
    // lease, not which branch of the resolution granted the socket.
    //
    // Four fields, not three: `inspectContainerCommand` reads `{{.Name}}` ahead
    // of the three owner labels, and the name is what tells a
    // container this instance runs for itself from one an operator started by
    // hand. `/lonely` is neither the platform's nor a Service's.
    const unlabelled = {
      stdout: '/lonely|<no value>|<no value>|<no value>\n',
      stderr: '',
      exitCode: 0,
    };
    remoteExec.execAsync.mockResolvedValue(unlabelled);
    // A provisioning run that never ends on its own, so the only thing that can
    // close the setup socket is its lease.
    remoteExec.execAsyncRemote.mockReturnValue(
      new Promise<ExecResult>(() => undefined),
    );
    await ctx.resetDb();
  });

  async function signUpOwner(): Promise<{
    cookie: string;
    id: string;
    organizationId: string;
  }> {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    const cookie = cookieHeader(res.headers['set-cookie']);
    const id = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', cookie);
    return {
      cookie,
      id,
      organizationId: (orgs.body as { id: string }[])[0].id,
    };
  }

  /** An Application the caller owns, and one recorded Deployment of it. */
  async function setUpApplication(caller: {
    id: string;
    organizationId: string;
  }) {
    const ownerCtx = permissionCtx(caller.id, caller.organizationId);
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const app = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'my-app',
      environmentId: environment.environmentId,
    });
    const record = await deployments.create({
      kind: 'application',
      applicationId: app.applicationId,
      title: 'Manual deployment',
      description: '',
    });
    return { app, record };
  }

  /** A Server in the caller's organization, reachable and with a key. */
  async function setUpServer(caller: { id: string; organizationId: string }) {
    const ownerCtx = permissionCtx(caller.id, caller.organizationId);
    const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
    const created = await servers.create(ownerCtx, {
      name: 'worker-1',
      ipAddress: '203.0.113.10',
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
    });
    return created;
  }

  /**
   * One live socket per gateway, keyed by the file the gateway lives in.
   *
   * Each opener leaves a stream that nothing but its lease can end: a `tail -f`
   * on a finished deployment's log, a shell at a prompt, a provisioning run held
   * open. That is the shape this is about — a socket with no natural end.
   */
  const openers: Record<string, () => Promise<FakeWs>> = {
    'container-logs.gateway.ts': async () => {
      const caller = await signUpOwner();
      const ws = new FakeWs();
      await containerLogs.handleConnection(
        ws,
        wsRequest(
          '/docker-container-logs?containerId=aaaaaaaaaaaa',
          caller.cookie,
        ),
      );
      expect(ptyChannels.spawn).toHaveBeenCalled();
      return ws;
    },

    'container-terminal.gateway.ts': async () => {
      const caller = await signUpOwner();
      const ws = new FakeWs();
      await containerTerminal.handleConnection(
        ws,
        wsRequest(
          '/docker-container-terminal?containerId=aaaaaaaaaaaa',
          caller.cookie,
        ),
      );
      expect(ptyChannels.spawn).toHaveBeenCalled();
      return ws;
    },

    'deployment-logs.gateway.ts': async () => {
      const caller = await signUpOwner();
      const { record } = await setUpApplication(caller);
      const ws = new FakeWs();
      await deploymentLogs.handleConnection(
        ws,
        wsRequest(
          `/listen-deployment?deploymentId=${record.deploymentId}`,
          caller.cookie,
        ),
      );
      expect(localProcesses.spawn).toHaveBeenCalled();
      return ws;
    },

    'docker-stats.gateway.ts': async () => {
      const caller = await signUpOwner();
      await setUpApplication(caller);
      const ws = new FakeWs();
      await dockerStats.handleConnection(
        ws,
        wsRequest(
          '/listen-docker-stats-monitoring?appName=my-app',
          caller.cookie,
        ),
      );
      return ws;
    },

    'server-setup.gateway.ts': async () => {
      const caller = await signUpOwner();
      const server = await setUpServer(caller);
      const ws = new FakeWs();
      await serverSetup.handleConnection(
        ws,
        wsRequest(
          // A start-dial: a bare dial only watches, and with no run in
          // flight closes 4015 before any lease is armed.
          `/listen-server-setup?serverId=${server.serverId}&start=true`,
          caller.cookie,
        ),
      );
      await waitFor(() => remoteExec.execAsyncRemote.mock.calls.length > 0);
      return ws;
    },

    'server-terminal.gateway.ts': async () => {
      const caller = await signUpOwner();
      const server = await setUpServer(caller);
      const ws = new FakeWs();
      await serverTerminal.handleConnection(
        ws,
        wsRequest(`/terminal?serverId=${server.serverId}`, caller.cookie),
      );
      expect(sshChannels.open).toHaveBeenCalled();
      return ws;
    },
  };

  it('covers every gateway in src/realtime/gateways', () => {
    const onDisk = fs
      .readdirSync(path.join(__dirname, '../../src/realtime/gateways'))
      .filter((file) => file.endsWith('.gateway.ts'))
      .sort();

    expect(onDisk).toEqual(Object.keys(openers).sort());
  });

  /**
   * §2.10's last rule, asserted rather than remembered.
   *
   * "Guard every send with `ws.readyState === ws.OPEN`" was already the standard
   * and was unmet at sixteen of the twenty-six sends in this directory, in every
   * shape the omission takes — a one-line `channel.onData` passthrough, an error
   * frame written just before a close, a five-thousand-chunk buffer replayed into
   * whoever attached. Nothing in the compiler notices, and a real `ws` does not
   * throw for it either: the error goes to a callback, or to the socket's
   * `'error'` event when there is none, so an unguarded send is silent in
   * production *and* invisible in a test that drives it. The keep-alive above is
   * what made it urgent rather than untidy — `terminate()` can now end a socket
   * on any tick, from a timer no gateway is watching.
   *
   * So the guard was made structural: every send goes through
   * `sendIfOpen(ws, …)`, and what this asserts is the *absence* of the raw call.
   * A text rule over the directory is worth more than twenty-six remembered
   * checks because it is the only form that also binds a seventh gateway — and
   * it is checked on `.send(` rather than on `ws.send(` so that renaming the
   * socket parameter does not slip past it.
   */
  it('sends nothing from a gateway without going through sendIfOpen', () => {
    const dir = path.join(__dirname, '../../src/realtime/gateways');
    const offenders = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.gateway.ts'))
      .filter((file) =>
        /\.send\(/.test(fs.readFileSync(path.join(dir, file), 'utf8')),
      );

    expect(offenders).toEqual([]);
  });

  /**
   * A keep-alive that cannot say who it reaped is most of the record gone
   * — and "did you pass the logger" is exactly the kind of thing a type
   * cannot ask for once the fields are optional-looking at the call site. The
   * bare form is what every gateway had, so its *absence* is the assertion.
   *
   * Making `logger`, `caller` and `subject` required in `KeepAlive` is the
   * primary gate and `pnpm --filter backend typecheck` is where it fires; this
   * text rule is the half that survives someone widening the interface again,
   * which is how the fields went missing in the first place.
   */
  it('arms no keep-alive without a journal to reap into', () => {
    const dir = path.join(__dirname, '../../src/realtime/gateways');
    const offenders = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.gateway.ts'))
      .filter((file) =>
        /armKeepAlive\(\{\s*ws\s*\}\)/.test(
          fs.readFileSync(path.join(dir, file), 'utf8'),
        ),
      );

    expect(offenders).toEqual([]);
  });

  /**
   * The other thing a socket must arm, guarded by the same enumeration.
   *
   * A lease is what ends a socket whose *authorization* went away; a keep-alive
   * is what ends one whose *peer* went away. Neither substitutes for the other,
   * and the gateway that had only the lease is the one where the difference was
   * measured: its 1.3 s sampler kept spawning `docker stats` subprocesses for
   * nine minutes after the tab was closed with zero TCP connections to the port,
   * and the lease reaped it only because a test happened to re-scope the session.
   *
   * The listener rather than a ping observed: the interval is 45 seconds by
   * design and this suite is not going to wait for one, while the `'pong'`
   * listener is the half that was missing from both hand-rolled pings — they
   * pinged and never checked for an answer, which is worse than no ping at all
   * because it defeats the proxy idle timeout that would have ended the socket.
   */
  it.each(Object.entries(openers))(
    '%s arms a keep-alive that can notice its peer is gone',
    async (_file, openSocket) => {
      const ws = await openSocket();

      expect(ws.listenerCount('pong')).toBe(1);
    },
  );

  /**
   * The credential itself going away is the vector that needs no entitlement to
   * have changed: the caller signed out, an operator revoked the session, a
   * banned account had its sessions deleted. Deleting the row is what a socket
   * cannot see any other way, because it kept no credential — only its id.
   */
  it.each(Object.entries(openers))(
    '%s closes 4010 when the credential behind the socket is gone',
    async (_file, openSocket) => {
      const ws = await openSocket();
      expect(ws.close).not.toHaveBeenCalled();

      await ctx.db.delete(session);

      await waitFor(() => ws.close.mock.calls.length > 0);
      expect(ws.close.mock.calls[0]).toEqual([
        LEASE_CLOSE_CODE,
        LEASE_CLOSE_REASON,
      ]);
      // One reason on the wire and nothing written into the stream: the close
      // frame carries the sentence, and a server-authored line in a log buffer
      // would be indistinguishable from something `tail` printed.
      expect(ws.send).not.toHaveBeenCalledWith(
        expect.stringContaining('authoriz'),
      );
    },
  );

  /**
   * And the same for a socket whose caller is still perfectly authenticated. A
   * lease renewal re-runs the *authorization*, not a list of ways it can be
   * withdrawn, which is why a session that is still valid does not save a stream
   * whose entitlement is gone.
   */
  it.each(Object.entries(openers))(
    '%s closes 4010 when the session outlives the entitlement',
    async (_file, openSocket) => {
      const ws = await openSocket();
      expect(ws.close).not.toHaveBeenCalled();

      // The membership, not the session: the credential stays alive and
      // re-readable, so nothing but re-running the authorization notices.
      await ctx.db.delete(member);
      expect(await ctx.db.select().from(session)).toHaveLength(1);

      await waitFor(() => ws.close.mock.calls.length > 0);
      expect(ws.close.mock.calls[0]).toEqual([
        LEASE_CLOSE_CODE,
        LEASE_CLOSE_REASON,
      ]);
    },
  );

  /**
   * The defect in its own words, through the surface that produces it.
   *
   * `removeMember` deletes the member row and never touches the session, which
   * is why "close on session expiry" was rejected as the mechanism: the case in
   * the issue's own title survives it. So this drives the real route with the
   * owner's cookie, on a stream a Member had legitimately opened and was
   * receiving frames on a moment earlier.
   */
  it('closes a Member stream when they are removed from the Organization', async () => {
    const ownerCaller = await signUpOwner();
    const { app } = await setUpApplication(ownerCaller);
    const invitee = await inviteMember(ownerCaller, app.applicationId);
    // The container resolves to the Service the Member was granted, so this is
    // a stream they are entitled to rather than one nobody owns.
    remoteExec.execAsync.mockResolvedValue({
      // `{{.Name}}` first — with the leading slash a real `docker inspect`
      // renders and `resolveTarget` strips — then the three owner
      // labels, the first of which names the Swarm service.
      stdout: '/my-app.1.abc|my-app|<no value>|<no value>\n',
      stderr: '',
      exitCode: 0,
    });
    const channel = new FakeChannel();
    ptyChannels.spawn.mockReturnValue(channel);

    const ws = new FakeWs();
    await containerLogs.handleConnection(
      ws,
      wsRequest(
        '/docker-container-logs?containerId=aaaaaaaaaaaa',
        invitee.cookie,
      ),
    );
    channel.emitData('listening on port 3000\n');
    expect(ws.send).toHaveBeenCalledWith('listening on port 3000\n');

    const removal = await request(httpServer)
      .delete(`/organizations/members/${invitee.memberId}`)
      .set('Cookie', ownerCaller.cookie);
    expect(removal.status).toBe(200);
    // The half of the defect that made expiry useless as a mechanism.
    expect(await ctx.db.select().from(session)).toHaveLength(2);

    await waitFor(() => ws.close.mock.calls.length > 0);
    expect(ws.close.mock.calls[0]).toEqual([
      LEASE_CLOSE_CODE,
      LEASE_CLOSE_REASON,
    ]);
    // And the stream behind it is torn down rather than left running for a
    // socket nobody is reading: closing is what every gateway hangs its
    // channel cleanup off, so ending the lease ends the `docker logs` too.
    expect(channel.close).toHaveBeenCalled();
  });

  /**
   * The instance-authority half of the lease, and the reason the new check went
   * into `authorizeAppNames` rather than into `authorizeContainer`.
   *
   * An unmanaged container on the **platform host** now takes instance
   * authority as well as `docker:read`, and instance authority is member rows —
   * mutable, exactly the kind a lease exists to re-read. `authorizeContainer`
   * is the connect-time call and is deliberately *not* what a renewal re-runs:
   * it inspects the container, which ADR-0012 captures once. So a check placed
   * there would be asked at connect and never again, and the socket would keep
   * streaming an operator's sidecar for as long as the caller held it open —
   * the connect-only defect, one gate down.
   *
   * **The caller is built so that only the new check can withdraw.** Mallory
   * owns a second Organization *and* holds an admin row in the instance
   * organization, and her session is active in her own. Deleting only her
   * instance-organization row leaves `docker:read` intact — that is read from
   * her member row in the *active* Organization, where she is still owner — so
   * the old gate still passes and nothing but instance authority has changed.
   * A test that deleted every member row instead would close the socket either
   * way, on `findMember`, and could not fail.
   */
  it('closes a platform-host container stream when instance authority is withdrawn', async () => {
    const ownerCaller = await signUpOwner();
    const mallory = await secondOrganizationOwner(
      httpServer,
      ctx.db,
      ownerCaller.cookie,
    );
    // Her admin row in the instance organization, written directly: the
    // invitation flow only reaches a user who has no account yet, and what is
    // under test is the row the check reads rather than how it was made — the
    // same reason `secondOrganizationOwner` writes her owner role directly.
    const [instanceAdmin] = await ctx.db
      .insert(member)
      .values({
        organizationId: mallory.instanceOrganizationId,
        userId: mallory.id,
        role: 'admin',
        createdAt: new Date(),
      })
      .returning();
    const channel = new FakeChannel();
    ptyChannels.spawn.mockReturnValue(channel);

    // `/lonely` from the `beforeEach`: unmanaged, and no `serverId` on the URL,
    // so the target is the platform host.
    const ws = new FakeWs();
    await containerLogs.handleConnection(
      ws,
      wsRequest(
        '/docker-container-logs?containerId=aaaaaaaaaaaa',
        mallory.cookie,
      ),
    );
    // Streaming first, so the close below is a socket being ended rather than
    // one that was never authorized.
    channel.emitData('level=info msg="sidecar up"\n');
    expect(ws.send).toHaveBeenCalledWith('level=info msg="sidecar up"\n');
    expect(ws.close).not.toHaveBeenCalled();

    await ctx.db.delete(member).where(eq(member.id, instanceAdmin.id));
    // The credential is untouched and so is her own Organization's owner row,
    // which is what `docker:read` is read from.
    expect(await ctx.db.select().from(session)).toHaveLength(2);

    await waitFor(() => ws.close.mock.calls.length > 0);
    expect(ws.close.mock.calls[0]).toEqual([
      LEASE_CLOSE_CODE,
      LEASE_CLOSE_REASON,
    ]);
    expect(channel.close).toHaveBeenCalled();
  });

  /**
   * A shell takes `service:update`, and the renewal asks for it again.
   *
   * The caller is built so that only the action can withdraw: a licensed
   * custom role holding `service: ['read', 'update']`, entitled to the one
   * Service by its member row. Taking `update` off the role leaves the
   * membership, the row-level grant, the session and `service:read` all
   * standing — so a renewal that re-asked for `read`, the action every other
   * container socket renews on, would keep the shell open, and this could not
   * pass.
   */
  it('closes a shell when service:update is taken off its role', async () => {
    const ownerCaller = await signUpOwner();
    const { app } = await setUpApplication(ownerCaller);
    const invitee = await inviteMember(ownerCaller, app.applicationId);
    await ctx.db.insert(licenseKey).values({
      organizationId: ownerCaller.organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    const [role] = await ctx.db
      .insert(organizationRole)
      .values({
        organizationId: ownerCaller.organizationId,
        role: 'shell-operator',
        permission: { service: ['read', 'update'] },
      })
      .returning();
    await ctx.db
      .update(member)
      .set({ role: 'shell-operator' })
      .where(eq(member.userId, invitee.id));
    remoteExec.execAsync.mockResolvedValue({
      stdout: '/my-app.1.abc|my-app|<no value>|<no value>\n',
      stderr: '',
      exitCode: 0,
    });
    const channel = new FakeChannel();
    ptyChannels.spawn.mockReturnValue(channel);

    const ws = new FakeWs();
    await containerTerminal.handleConnection(
      ws,
      wsRequest(
        '/docker-container-terminal?containerId=aaaaaaaaaaaa',
        invitee.cookie,
      ),
    );
    // Open first, so the close below is a shell being ended rather than one
    // that was never authorized.
    expect(ptyChannels.spawn).toHaveBeenCalled();
    channel.emitData('/ # ');
    expect(ws.send).toHaveBeenCalledWith('/ # ');
    expect(ws.close).not.toHaveBeenCalled();

    await ctx.db
      .update(organizationRole)
      .set({ permission: { service: ['read'] } })
      .where(eq(organizationRole.id, role.id));

    await waitFor(() => ws.close.mock.calls.length > 0);
    expect(ws.close.mock.calls[0]).toEqual([
      LEASE_CLOSE_CODE,
      LEASE_CLOSE_REASON,
    ]);
    expect(channel.close).toHaveBeenCalled();
  });

  /**
   * A base Member of the owner's Organization, granted exactly one Service and
   * acting in that Organization — the caller whose entitlement can be withdrawn
   * without touching their account.
   */
  async function inviteMember(
    ownerCaller: { cookie: string; organizationId: string },
    serviceId: string,
  ): Promise<{ id: string; cookie: string; memberId: string }> {
    const invite = await request(httpServer)
      .post('/organizations/invitations')
      .set('Cookie', ownerCaller.cookie)
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
    const cookie = cookieHeader(su.headers['set-cookie']);
    const id = (su.body as { user: { id: string } }).user.id;
    await request(httpServer)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', cookie);

    // A freshly accepted invitation does not leave the joined organization
    // active on the session, and the socket authorizes in the active one.
    await ctx.db
      .update(session)
      .set({ activeOrganizationId: ownerCaller.organizationId })
      .where(eq(session.userId, id));
    // Granted the one Service, so the stream below is theirs by entitlement.
    const [memberRecord] = await ctx.db
      .update(member)
      .set({ accessedServices: [serviceId] })
      .where(eq(member.userId, id))
      .returning();

    return { id, cookie, memberId: memberRecord.id };
  }
});
