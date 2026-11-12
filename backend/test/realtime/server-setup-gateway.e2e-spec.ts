import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import request from 'supertest';
import { App } from 'supertest/types';
import WebSocket from 'ws';
import { session } from '../../src/auth/auth.schema';
import { ServerSetupGateway } from '../../src/realtime/gateways/server-setup.gateway';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { cookieHeader, waitFor } from './realtime.fixture';
import { createOrganization } from '../utils/test-auth';

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

/** Collapses supertest's set-cookie array into a request cookie header. */
/** A ws client double: EventEmitter for close wiring, spies for output. */
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

  /** Everything sent, as one string — the log an operator would be reading. */
  output(): string {
    return this.send.mock.calls.map(([chunk]) => chunk).join('');
  }
}

function wsRequest(pathWithQuery: string, cookie?: string): IncomingMessage {
  return {
    url: pathWithQuery,
    headers: { host: 'localhost', ...(cookie ? { cookie } : {}) },
  } as IncomingMessage;
}

/**
 * A setup run the test holds open: `execAsyncRemote` resolves only when the test
 * says so, and `emit` is the `onData` callback the service handed it. This is the
 * whole point of the gateway — output has to arrive *during* the run, not after.
 */
interface HeldRun {
  emit: (chunk: string) => void;
  succeed: () => void;
  fail: (error: Error) => void;
  /** The command the service asked the host to run. */
  command: string;
}

describe('Server setup gateway (/listen-server-setup) (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let gateway: ServerSetupGateway;
  let servers: ServersService;
  let sshKeys: SshKeysService;

  const remoteExec = {
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<
      Promise<ExecResult>,
      [string, string, ((data: string) => void)?]
    >(),
  };

  /** The next `execAsyncRemote` is held open and handed back to the test. */
  function holdNextRun(): Promise<HeldRun> {
    return new Promise<HeldRun>((handOver) => {
      remoteExec.execAsyncRemote.mockImplementationOnce(
        (_serverId, command, onData) =>
          new Promise<ExecResult>((resolve, reject) => {
            handOver({
              command,
              emit: (chunk) => onData?.(chunk),
              succeed: () => resolve({ stdout: '', stderr: '', exitCode: 0 }),
              fail: reject,
            });
          }),
      );
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: remoteExec }],
    });
    httpServer = ctx.app.getHttpServer() as App;
    gateway = ctx.app.get(ServerSetupGateway);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    remoteExec.execAsync.mockReset();
    remoteExec.execAsyncRemote.mockReset();
    await ctx.resetDb();
  });

  const permissionCtx = (userId: string, organizationId: string) => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  async function setUpOwnerWithServer() {
    const ownerSession = await signUp(httpServer, owner);
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
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

  /** Owner org plus one accepted member, whose role grants no `server` action. */
  async function setUpOwnerWithMemberAndServer() {
    const fixture = await setUpOwnerWithServer();

    const invite = await request(httpServer)
      .post('/organizations/invitations')
      .set('Cookie', fixture.ownerSession.cookie)
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
    const memberCookie = cookieHeader(su.headers['set-cookie']);
    const accept = await request(httpServer)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', memberCookie);
    expect(accept.status).toBe(201);

    // Both sessions now resolve to the fixture Server's organization, so the
    // only thing separating the two callers is their role.
    await ctx.db
      .update(session)
      .set({ activeOrganizationId: fixture.organizationId });

    return { ...fixture, memberCookie };
  }

  describe('what it refuses before it touches the host', () => {
    it('rejects a missing serverId with 4000, before it even authenticates', async () => {
      const ws = new FakeWs();
      await gateway.handleConnection(ws, wsRequest('/listen-server-setup'));

      expect(ws.close).toHaveBeenCalledWith(4000, 'serverId not provided');
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('closes an unauthenticated connection without provisioning anything', async () => {
      const { serverId } = await setUpOwnerWithServer();

      const ws = new FakeWs();
      await gateway.handleConnection(
        ws,
        wsRequest(`/listen-server-setup?serverId=${serverId}&start=true`),
      );

      expect(ws.close).toHaveBeenCalledWith();
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('closes silently for a server outside the active organization', async () => {
      const { serverId, ownerSession } = await setUpOwnerWithServer();
      const secondOrg = await createOrganization(
        httpServer,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      await ctx.db
        .update(session)
        .set({ activeOrganizationId: (secondOrg.body as { id: string }).id });

      const ws = new FakeWs();
      await gateway.handleConnection(
        ws,
        wsRequest(
          `/listen-server-setup?serverId=${serverId}&start=true`,
          ownerSession.cookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith();
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('refuses a member with 4003: seeing a Server is not being allowed to provision it', async () => {
      const { serverId, memberCookie } = await setUpOwnerWithMemberAndServer();

      const ws = new FakeWs();
      await gateway.handleConnection(
        ws,
        wsRequest(
          `/listen-server-setup?serverId=${serverId}&start=true`,
          memberCookie,
        ),
      );

      expect(ws.close).toHaveBeenCalledWith(
        4003,
        'Not allowed to run setup on this Server',
      );
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });
  });

  it('streams the provisioning run as it happens and reports that it finished', async () => {
    const { ownerSession, serverId } = await setUpOwnerWithServer();
    const held = holdNextRun();

    const ws = new FakeWs();
    await gateway.handleConnection(
      ws,
      wsRequest(
        `/listen-server-setup?serverId=${serverId}&start=true`,
        ownerSession.cookie,
      ),
    );
    const run = await held;

    // The default provisioning script, not something this gateway invented.
    expect(run.command).toContain('docker swarm init');

    run.emit('1. Installing required packages\n');
    run.emit(' - Docker is installed.\n');
    expect(ws.send).toHaveBeenNthCalledWith(
      1,
      '1. Installing required packages\n',
    );
    expect(ws.send).toHaveBeenNthCalledWith(2, ' - Docker is installed.\n');
    // Still open: the run is not over, so neither is the socket.
    expect(ws.close).not.toHaveBeenCalled();

    run.succeed();
    await waitFor(() => ws.close.mock.calls.length > 0);

    expect(ws.output()).toContain('✅ Setup finished.');
    expect(ws.close).toHaveBeenCalledWith(1000, 'Setup finished');
  });

  it('runs a stored custom command instead of the default script', async () => {
    const { ownerSession, ownerCtx, serverId } = await setUpOwnerWithServer();
    await servers.update(ownerCtx, serverId, { command: 'echo custom-setup' });
    const held = holdNextRun();

    await gateway.handleConnection(
      new FakeWs(),
      wsRequest(
        `/listen-server-setup?serverId=${serverId}&start=true`,
        ownerSession.cookie,
      ),
    );
    const run = await held;

    expect(run.command).toBe('echo custom-setup');
  });

  it('says the run failed, in the output and not only in the close code', async () => {
    const { ownerSession, serverId } = await setUpOwnerWithServer();
    const held = holdNextRun();

    const ws = new FakeWs();
    await gateway.handleConnection(
      ws,
      wsRequest(
        `/listen-server-setup?serverId=${serverId}&start=true`,
        ownerSession.cookie,
      ),
    );
    const run = await held;

    run.emit('2. Installing Docker\n');
    run.fail(new Error('Remote command failed with exit code 1'));
    await waitFor(() => ws.close.mock.calls.length > 0);

    // Everything the run managed to say is still there, and then why it stopped.
    expect(ws.output()).toContain('2. Installing Docker\n');
    expect(ws.output()).toContain(
      '❌ Setup failed: Remote command failed with exit code 1',
    );
    expect(ws.close).toHaveBeenCalledWith(4001, 'Setup failed');
  });

  describe('the run belongs to the machine, not to the socket', () => {
    it('keeps provisioning after the last watcher goes away, and replays what it missed to the next one', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const held = holdNextRun();

      const first = new FakeWs();
      await gateway.handleConnection(
        first,
        wsRequest(
          `/listen-server-setup?serverId=${serverId}&start=true`,
          ownerSession.cookie,
        ),
      );
      const run = await held;
      run.emit('1. Installing required packages\n');

      // Somebody closes the tab. Nothing about the host changes.
      first.close();
      run.emit(' - Docker installed successfully.\n');

      // Coming back attaches to the same run — it does not start a second one.
      // A watch-dial, the way a page opened later comes back (ADR-0058).
      const second = new FakeWs();
      await gateway.handleConnection(
        second,
        wsRequest(
          `/listen-server-setup?serverId=${serverId}`,
          ownerSession.cookie,
        ),
      );

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledTimes(1);
      expect(second.output()).toBe(
        '1. Installing required packages\n - Docker installed successfully.\n',
      );

      run.emit('Swarm initialized ✅\n');
      run.succeed();
      await waitFor(() => second.close.mock.calls.length > 0);

      expect(second.output()).toContain('Swarm initialized ✅\n');
      expect(second.close).toHaveBeenCalledWith(1000, 'Setup finished');
      // The socket that left never heard the outcome, and was never written to
      // again — a closed socket is not an error to report.
      expect(first.output()).not.toContain('Setup finished');
    });

    it('tells a run that failed apart from a socket that merely stopped listening', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const held = holdNextRun();
      const target = wsRequest(
        `/listen-server-setup?serverId=${serverId}&start=true`,
        ownerSession.cookie,
      );

      // Somebody watches, then leaves. That is "we stopped listening": the run
      // has said nothing about how it went, because it has not gone yet.
      const left = new FakeWs();
      await gateway.handleConnection(left, target);
      const run = await held;
      run.emit('2. Installing Docker\n');
      left.close();

      expect(left.output()).not.toContain('❌');
      expect(left.output()).not.toContain('✅');
      expect(left.close).toHaveBeenCalledWith();

      // Somebody else picks the same run back up and is still there when it
      // fails. That is "the run failed", and it arrives as a statement.
      const stayed = new FakeWs();
      await gateway.handleConnection(stayed, target);
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledTimes(1);

      run.fail(new Error('Docker installation failed'));
      await waitFor(() => stayed.close.mock.calls.length > 0);

      expect(stayed.output()).toContain(
        '❌ Setup failed: Docker installation failed',
      );
      expect(stayed.close).toHaveBeenCalledWith(4001, 'Setup failed');
      // Still nothing written to the socket that left.
      expect(left.output()).toBe('2. Installing Docker\n');
    });

    it('replays nothing into a watcher that is already gone, and does not keep it', async () => {
      // `attach` is the one send site in the module where the failure is a
      // buffer rather than a frame: a wedged run holds up to MAX_BUFFERED_CHUNKS,
      // and `handleConnection` awaits authentication and the entitlement check
      // before it gets here, so the socket really can be gone by then — and since
      // its `'close'` has already fired, the listener `attach` registers would
      // never run and the dead watcher would sit in the set for the life of the
      // run. Guarded once before the replay for that reason, and per frame
      // through `sendIfOpen` for the reason every other send is (§2.10).
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const held = holdNextRun();
      const target = wsRequest(
        `/listen-server-setup?serverId=${serverId}&start=true`,
        ownerSession.cookie,
      );

      const first = new FakeWs();
      await gateway.handleConnection(first, target);
      const run = await held;
      run.emit('1. Installing required packages\n');

      // A socket whose peer vanished before the handler reached `attach`: closed,
      // and its close event already delivered.
      const gone = new FakeWs();
      gone.readyState = 3;
      await gateway.handleConnection(gone, target);

      expect(gone.output()).toBe('');
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledTimes(1);

      // And it was never added as a watcher, so nothing later in the run reaches
      // for it either.
      run.emit('2. Installing Docker\n');
      run.succeed();
      await waitFor(() => first.close.mock.calls.length > 0);

      expect(gone.output()).toBe('');
      expect(gone.close).not.toHaveBeenCalled();
      // The live watcher is unaffected: this is about the dead one only.
      expect(first.output()).toContain('2. Installing Docker\n');
      expect(first.close).toHaveBeenCalledWith(1000, 'Setup finished');
    });

    it('gives two watchers the same run rather than provisioning the host twice', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const held = holdNextRun();
      const target = wsRequest(
        `/listen-server-setup?serverId=${serverId}&start=true`,
        ownerSession.cookie,
      );

      const first = new FakeWs();
      await gateway.handleConnection(first, target);
      const run = await held;

      const second = new FakeWs();
      await gateway.handleConnection(second, target);

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledTimes(1);

      run.emit('Traefik already exists ✅\n');
      expect(first.output()).toContain('Traefik already exists ✅\n');
      expect(second.output()).toContain('Traefik already exists ✅\n');

      run.succeed();
      await waitFor(() => first.close.mock.calls.length > 0);
      expect(first.close).toHaveBeenCalledWith(1000, 'Setup finished');
      expect(second.close).toHaveBeenCalledWith(1000, 'Setup finished');
    });
  });

  it('routes a real ws connection by path and streams the run over it', async () => {
    const { ownerSession, serverId } = await setUpOwnerWithServer();
    const held = holdNextRun();

    await ctx.app.listen(0);
    const { port } = (
      ctx.app.getHttpServer() as unknown as {
        address(): { port: number };
      }
    ).address();

    const client = new WebSocket(
      `ws://127.0.0.1:${port}/listen-server-setup?serverId=${serverId}&start=true`,
      { headers: { cookie: ownerSession.cookie } },
    );
    const received: string[] = [];
    client.on('message', (data) => received.push((data as Buffer).toString()));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.on('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });
    await new Promise((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });

    const run = await held;
    run.emit('Running as root\n');
    await waitFor(() => received.length > 0);
    run.succeed();

    expect(await closed).toEqual({ code: 1000, reason: 'Setup finished' });
    expect(received.join('')).toBe('Running as root\n\n✅ Setup finished.\n');
  });
});
