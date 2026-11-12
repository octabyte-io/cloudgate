import { Logger } from '@nestjs/common';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import WebSocket from 'ws';

import { ApplicationsService } from '../../src/applications/applications.service';
import { session } from '../../src/auth/auth.schema';
import {
  licenseKey,
  member as memberRow,
  organizationRole,
} from '../../src/db/schema';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { DOCKER_CLIENT } from '../../src/docker/docker-client.provider';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { SERVER_STATS_COMMAND } from '../../src/monitoring/collectors/server-stats.collector';
import { previewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { PtyChannelService } from '../../src/realtime/channels/pty-channel.service';
import { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import type { StreamChannel } from '../../src/realtime/channels/stream-channel';
import { SHELL_OPEN_FRAME } from '../../src/realtime/terminal-protocol';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  captureJournal,
  cookieHeader,
  FakeChannel,
  permissionCtx,
  waitFor,
} from './realtime.fixture';
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

/**
 * What the container gateways do on the wire.
 *
 * `realtime.e2e-spec.ts` drives `handleConnection` directly with a socket
 * double, which is the right seam for the plumbing — which command was built,
 * what a resize frame does. It is the wrong seam for an authorization fix:
 * calling the handler proves the handler refuses, not that a browser dialling
 * the path is refused, and the whole defect was a check that existed one
 * layer up and was never reached from the transport. So every test here
 * performs a real WebSocket upgrade against a listening app and reads the close
 * frame and the payload frames the client actually got.
 */
describe('Container sockets (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let port: number;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let postgres: PostgresService;
  let permissions: PermissionService;
  let servers: ServersService;
  let sshKeys: SshKeysService;

  const sshChannels = { open: jest.fn<Promise<StreamChannel>, unknown[]>() };
  const ptyChannels = { spawn: jest.fn<StreamChannel, unknown[]>() };
  const dockerClient = {
    listContainers: jest.fn<Promise<unknown[]>, unknown[]>(),
  };
  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: SshChannelService, useValue: sshChannels },
        { provide: PtyChannelService, useValue: ptyChannels },
        { provide: DOCKER_CLIENT, useValue: dockerClient },
        { provide: RemoteExecService, useValue: remoteExec },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    postgres = ctx.app.get(PostgresService);
    permissions = ctx.app.get(PermissionService);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);

    // A real upgrade needs a real listener; the gateways are bound already.
    await ctx.app.listen(0);
    port = (httpServer as unknown as { address(): { port: number } }).address()
      .port;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    sshChannels.open.mockReset();
    ptyChannels.spawn.mockReset();
    dockerClient.listContainers.mockReset();
    remoteExec.execAsync.mockReset();
    remoteExec.execAsyncRemote.mockReset();
    inspectAnswers.clear();
    remoteExec.execAsync.mockImplementation((command) =>
      answerInspect(command),
    );
    remoteExec.execAsyncRemote.mockImplementation((_serverId, command) =>
      answerInspect(command),
    );
    await ctx.resetDb();
  });

  /**
   * What the docker daemon in these tests knows, keyed by the object name the
   * command asks about.
   *
   * A stub that answers every `docker inspect` the same way cannot express the
   * behaviour the swarm branch exists for, which is that **the two inspect
   * types disagree about the same name**: `docker inspect --type container` on a
   * swarm *service* name does not return empty labels, it exits non-zero. So the
   * double answers by type, and a name it holds no container for fails the way
   * the daemon fails.
   */
  const inspectAnswers = new Map<
    string,
    { container?: string[]; service?: [string, string] }
  >();

  /** `<no value>` is what a Go template renders for a key that is not there. */
  const NO_VALUE = '<no value>';

  function answerInspect(command: string): Promise<ExecResult> {
    const asService = command.includes('--type service');
    const name = command.trim().split(/\s+/).pop() as string;
    const known = inspectAnswers.get(name);

    if (asService) {
      if (!known?.service) {
        return Promise.reject(new Error(`Error: no such service: ${name}`));
      }
      return ok(known.service.join('|'));
    }
    if (!known?.container) {
      return Promise.reject(new Error(`Error: No such container: ${name}`));
    }
    return ok(known.container.join('|'));
  }

  function ok(stdout: string): Promise<ExecResult> {
    return Promise.resolve({ stdout: `${stdout}\n`, stderr: '', exitCode: 0 });
  }

  /** A swarm *service* of this name, as `docker inspect --type service` sees it. */
  function swarmService(
    serviceName: string,
    { stackNamespace = NO_VALUE } = {},
  ) {
    inspectAnswers.set(serviceName, {
      service: [serviceName, stackNamespace],
    });
  }

  /**
   * A container carrying the owner labels a managed container carries.
   *
   * Its `{{.Name}}` leads the inspect output, with the slash Docker puts on it,
   * because that is what tells the platform's own containers from an operator's
   * hand-started one — both resolve to no Service. It defaults to the id
   * the socket was pointed at, which is what a name-addressed container answers.
   */
  function containerOwnedBy(
    containerId: string,
    labels: {
      swarmService?: string;
      composeProject?: string;
      stackNamespace?: string;
      name?: string;
    },
  ) {
    inspectAnswers.set(containerId, {
      container: [
        labels.name ?? `/${containerId}`,
        labels.swarmService ?? NO_VALUE,
        labels.composeProject ?? NO_VALUE,
        labels.stackNamespace ?? NO_VALUE,
      ],
    });
  }

  async function setUpOwner() {
    const ownerSession = await signUp(httpServer, owner);
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    return {
      organizationId,
      ownerSession,
      ownerCtx: permissionCtx(ownerSession.id, organizationId),
    };
  }

  /**
   * A base member of the owner's organization: authenticated, inside the
   * organization, and granted no Service — the caller this file is about.
   */
  async function inviteMember(
    ownerCookie: string,
    organizationId?: string,
  ): Promise<{ id: string; cookie: string }> {
    const invite = await request(httpServer)
      .post('/organizations/invitations')
      .set('Cookie', ownerCookie)
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

    // The socket authorizes in the session's active organization, which for a
    // freshly accepted invitation is not yet the one just joined.
    if (organizationId) {
      await ctx.db
        .update(session)
        .set({ activeOrganizationId: organizationId })
        .where(eq(session.userId, id));
    }

    return { id, cookie };
  }

  /**
   * Moves the caller into a second organization they own, and returns to it.
   *
   * A wholly separate tenant cannot be built through the API on one instance —
   * `organizations.create` admits only a user whose *instance* role is owner or
   * admin, so an invited member cannot own an organization. What the check under
   * test actually compares is the resolved Service's organization against the
   * **session's active** one, and this produces that mismatch with the caller in
   * the strongest possible role: owner of the organization they are asking from,
   * which is the role `checkServiceAccess` skips its row-level half for.
   */
  async function switchToFreshOrganization(caller: {
    id: string;
    cookie: string;
  }): Promise<string> {
    const created = await createOrganization(
      httpServer,
      ctx.db,
      caller.cookie,
      { name: 'Second Org' },
    );
    expect(created.status).toBe(201);
    const organizationId = (created.body as { id: string }).id;
    await ctx.db
      .update(session)
      .set({ activeOrganizationId: organizationId })
      .where(eq(session.userId, caller.id));
    return organizationId;
  }

  async function setUpEnvironment(ownerCtx: {
    user: { id: string };
    session: { activeOrganizationId: string };
  }) {
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    return environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
  }

  /**
   * The lines the **gate** wrote, as against the socket's own refusal line.
   *
   * `captureJournal` filters to `Refused socket:` — the line
   * `authorizedOrDeny` writes, which quotes whatever was thrown. Now
   * every container denial throws the same message, so the specific cause lives
   * on its own `Refused container:` line one layer down, and that is where
   * ADR-0008's *"the distinction goes to the journal"* now has to be asserted.
   *
   * Everything *but* `Refused socket:`, rather than a second prefix allowlist:
   * the causes are written by two different sites — `Refused container:` for a
   * judgement the gate made, `Could not inspect` for a target the daemon would
   * not answer for — and a test that enumerated the prefixes would go quietly
   * blind to a third.
   *
   * Reads the same `Logger.prototype.warn` spy `captureJournal` installed —
   * `jest.spyOn` hands back the existing mock rather than wrapping it twice — so
   * restoration stays the fixture's `afterEach` and no second spy can leak.
   * Only meaningful after `captureJournal()` has been called.
   */
  const causeLines = (): string[] =>
    (jest.spyOn(Logger.prototype, 'warn').mock.calls as [unknown][])
      .map(([line]) => String(line))
      .filter((line) => !line.startsWith('Refused socket:'));

  /**
   * A live socket: the frames it received, and the close frame when it comes.
   *
   * Both are recorded from the moment of `open`, because the assertions
   * needed are about what a refused caller *did not* get — a zero-frame
   * assertion is only worth anything if a frame arriving late would have been
   * counted.
   */
  /**
   * Close from the browser and wait for the server's side of that close.
   *
   * A terminal's close runs a second exec that ends the shell it started.
   * Left to land whenever it does, that exec is recorded by the *next*
   * test's freshly reset mocks, as a spawn that test never made.
   */
  async function hangUp(socket: { close: () => void }, channel: FakeChannel) {
    socket.close();
    await waitFor(() => channel.close.mock.calls.length > 0);
  }

  /**
   * What the container wrote, without the terminal socket's own
   * `SHELL_OPEN_FRAME`: a shell says it is open before any of its
   * bytes, and these tests are about the bytes. A log socket sends no such
   * frame, so this is its frames unchanged.
   */
  const output = (socket: { frames: string[] }) =>
    socket.frames.filter((frame) => frame !== SHELL_OPEN_FRAME);

  function dial(pathWithQuery: string, cookie?: string) {
    const client = new WebSocket(`ws://127.0.0.1:${port}${pathWithQuery}`, {
      headers: cookie ? { cookie } : {},
    });
    const frames: string[] = [];
    let closed: { code: number; reason: string } | null = null;

    client.on('message', (data) => frames.push((data as Buffer).toString()));
    client.on('close', (code, reason) => {
      closed = { code, reason: reason.toString() };
    });

    return {
      client,
      frames,
      opened: new Promise<void>((resolve, reject) => {
        client.on('open', () => resolve());
        client.on('error', reject);
      }),
      closure: async () => {
        await waitFor(() => closed !== null);
        return closed as unknown as { code: number; reason: string };
      },
      close: () => client.close(),
    };
  }

  /**
   * The reason the swarm branch has to be reachable from here: a
   * database's log view is addressed by `appName` with `runType=swarm`, because
   * `docker service logs` takes a service name and a managed database's Swarm
   * service is named exactly its `appName` (`features/database/container-log.tsx`).
   * Nothing on that screen sends a container id.
   */
  describe('a swarm-addressed target', () => {
    it('streams to the owner of the database it names', async () => {
      const { ownerCtx, ownerSession } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      const database = await postgres.create(ownerCtx, {
        name: 'Primary',
        appName: 'primary-db',
        databaseName: 'app',
        databaseUser: 'app',
        databasePassword: 'secret',
        environmentId: environment.environmentId,
      });
      expect(database.appName).toBe('primary-db');
      swarmService('primary-db');
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const socket = dial(
        '/docker-container-logs?containerId=primary-db&runType=swarm',
        ownerSession.cookie,
      );
      await socket.opened;
      await waitFor(() => ptyChannels.spawn.mock.calls.length > 0);
      channel.emitData('database is ready to accept connections\n');
      await waitFor(() => output(socket).length > 0);

      expect(output(socket)).toEqual([
        'database is ready to accept connections\n',
      ]);
      await hangUp(socket, channel);
    });
  });

  /**
   * The wire tells a refused caller nothing about which refusal it was, and the
   * journal tells an operator everything (ADR-0008). Both halves are one
   * requirement: byte-identical frames are what stop the socket being a
   * container-enumeration oracle, and they are only affordable because the
   * distinction survives somewhere an operator can read it.
   */
  describe('the three ways a container socket refuses', () => {
    it('are byte-identical on the wire and distinguished in the journal', async () => {
      const { ownerCtx, organizationId, ownerSession } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'my-app',
        environmentId: environment.environmentId,
      });
      // `appName` is unique per service table and not across them, so an
      // Application and a database may both answer to `twin`.
      await applications.create(ownerCtx, {
        name: 'Twin App',
        appName: 'twin',
        environmentId: environment.environmentId,
      });
      await postgres.create(ownerCtx, {
        name: 'Twin DB',
        appName: 'twin',
        databaseName: 'app',
        databaseUser: 'app',
        databasePassword: 'secret',
        environmentId: environment.environmentId,
      });
      const member = await inviteMember(ownerSession.cookie, organizationId);
      containerOwnedBy('aaaaaaaaaaaa', { swarmService: 'my-app' });
      containerOwnedBy('cccccccccccc', { swarmService: 'twin' });

      const journalOf = captureJournal();
      const refusals: {
        containerId: string;
        closure: { code: number; reason: string };
      }[] = [];
      // Not entitled, unknown container, ambiguous resolution.
      for (const containerId of [
        'aaaaaaaaaaaa',
        'bbbbbbbbbbbb',
        'cccccccccccc',
      ]) {
        const socket = dial(
          `/docker-container-logs?containerId=${containerId}`,
          member.cookie,
        );
        await socket.opened;
        refusals.push({ containerId, closure: await socket.closure() });
      }
      const journal = journalOf();

      const [notEntitled, unknown, ambiguous] = refusals;
      expect(notEntitled.closure).toEqual({
        code: 4003,
        reason: 'Not found or not permitted',
      });
      expect(unknown.closure).toEqual(notEntitled.closure);
      expect(ambiguous.closure).toEqual(notEntitled.closure);
      expect(ptyChannels.spawn).not.toHaveBeenCalled();

      // Three refusals, told apart, each naming who asked and what for.
      expect(journal).toHaveLength(3);
      expect(new Set(journal).size).toBe(3);
      for (const [index, line] of journal.entries()) {
        expect(line).toContain(refusals[index].containerId);
        expect(line).toContain(member.id);
      }
      // And the *reason* each was refused, which the socket line no longer
      // carries: it quotes one message for all three, so the
      // distinction ADR-0008 requires survive lives here.
      const causes = causeLines();
      expect(causes.some((line) => line.includes('Could not inspect'))).toBe(
        true,
      );
      expect(
        causes.some((line) => line.includes('resolve to 2 services')),
      ).toBe(true);
    });
  });

  /**
   * The fourth way it used to refuse, which was not a refusal at all.
   *
   * A `503` does not reach a WebSocket client, and both container gateways wrap
   * `authorizeContainer` in a **blanket catch**, so a Server that answered
   * nothing at all closed `4003 Not found or not permitted` — an
   * *authorization* claim about a machine nothing spoke to, told to an operator
   * whose containers were merely unreachable. It is the species the uniform
   * denial closed, one turn worse: that oracle lied about which containers
   * exist, and this lied
   * about who the reader is.
   *
   * **Added beside the three above rather than folded into them, and every case
   * here is paired with a reachable one**, because the uniform denial's
   * guarantee is the thing a reader of this diff has to be able to check: on a
   * Server that answers, the three refusals stay byte-identical, and only a
   * Server that answers nothing gets `4012`. The split is `ExecError.exitCode`
   * and never a message match (`host-reachability.ts`), so `docker inspect`
   * having run and said *no such container* is still a denial — which is why
   * the three cases above, whose daemon double rejects with a plain `Error`,
   * stay green untouched.
   */
  describe('a container on a machine that could not be reached', () => {
    /** An owner, a Server of theirs, and an Application it runs. */
    async function setUpServer() {
      const { ownerCtx, ownerSession, organizationId } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const created = await servers.create(ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'my-app',
        environmentId: environment.environmentId,
        serverId: created.serverId,
      });
      containerOwnedBy('eeeeeeeeeeee', { swarmService: 'my-app' });
      return { ownerSession, organizationId, serverId: created.serverId };
    }

    /**
     * What the SSH transport rejects with off the `ssh2` client's `'error'`
     * event: no shell ran, so there is no exit code to carry. A Server pointed
     * at a closed port produces exactly this.
     */
    const unreachable = () =>
      new ExecError(
        'SSH connection error: connect ECONNREFUSED 203.0.113.10:22',
        { command: 'docker inspect', serverId: null },
      );

    /** What it rejects with once `docker` has run and answered. */
    const dockerAnswered = () =>
      new ExecError('Remote command failed with exit code 1', {
        command: 'docker inspect',
        serverId: null,
        exitCode: 1,
        stderr: 'Error: No such container: eeeeeeeeeeee',
      });

    const paths: [string, string][] = [
      ['logs', '/docker-container-logs'],
      ['terminal', '/docker-container-terminal'],
    ];

    it.each(paths)(
      'closes the %s socket with 4012 and the Server’s own sentence',
      async (_name, basePath) => {
        const { ownerSession, serverId } = await setUpServer();
        remoteExec.execAsyncRemote.mockRejectedValue(unreachable());
        const journalOf = captureJournal();

        const socket = dial(
          `${basePath}?containerId=eeeeeeeeeeee&serverId=${serverId}`,
          ownerSession.cookie,
        );
        await socket.opened;
        const closure = await socket.closure();

        // The literal rather than the constant, as the `4003` cases above are:
        // the number *is* the wire contract, and the console keeps its own copy
        // of it (`frontend/src/lib/realtime/terminals.ts`).
        expect(closure).toEqual({
          code: 4012,
          reason: 'This Server could not be reached',
        });
        expect(socket.frames).toHaveLength(0);
        // Nothing was started on any machine — a different answer, not a laxer
        // gate.
        expect(sshChannels.open).not.toHaveBeenCalled();
        expect(ptyChannels.spawn).not.toHaveBeenCalled();
        // And nobody was refused anything, so the denial count does not move
        // `Refused socket:` is how an operator counts denials.
        expect(journalOf()).toHaveLength(0);
        expect(
          causeLines().some((line) =>
            line.startsWith('Unreachable socket: container eeeeeeeeeeee'),
          ),
        ).toBe(true);
      },
    );

    it.each(paths)(
      'names the platform host on the %s socket when the target is on it',
      async (_name, basePath) => {
        // ADR-0008 makes an absent `serverId` the platform host, and §2.5 names
        // the entity: a Server and the host Cloudgate runs on are two different
        // things to be told about.
        //
        // **This case guards the platform host's code as well as the
        // unreachable code, and it caught it.** The former gave the platform
        // host a `code` of its own so the console could stop saying the Server
        // sentence about it — and `isHostUnreachable`, which is what turns the
        // gate's throw into this frame, asked for `HOST_UNREACHABLE` by name.
        // So the second code sent this socket straight back to `4003 Not found
        // or not permitted`: an authorization claim about a machine nothing
        // spoke to, on a container the platform host runs. The guard reads
        // either arm now (`isUnreachableCode`), and the *reason* needed
        // nothing, because it is the exception's own message rather than a
        // constant.
        const { ownerSession } = await setUpServer();
        remoteExec.execAsync.mockRejectedValue(unreachable());

        const socket = dial(
          `${basePath}?containerId=eeeeeeeeeeee`,
          ownerSession.cookie,
        );
        await socket.opened;

        expect(await socket.closure()).toEqual({
          code: 4012,
          reason: 'The platform host could not be reached',
        });
      },
    );

    it.each(paths)(
      'still closes the %s socket 4003 when the Server answered',
      async (_name, basePath) => {
        // The pairing, and the case that catches a fix written as "any exec
        // rejection is a transport failure": `docker inspect` reached a shell,
        // ran, and exited nonzero, so the resolution happened and its outcome
        // is a denial — byte-identical with every other denial (ADR-0008).
        const { ownerSession, serverId } = await setUpServer();
        remoteExec.execAsyncRemote.mockRejectedValue(dockerAnswered());

        const socket = dial(
          `${basePath}?containerId=eeeeeeeeeeee&serverId=${serverId}`,
          ownerSession.cookie,
        );
        await socket.opened;

        expect(await socket.closure()).toEqual({
          code: 4003,
          reason: 'Not found or not permitted',
        });
        expect(socket.frames).toHaveLength(0);
      },
    );

    it.each(paths)(
      'still closes the %s socket 4003 for a caller the Service is withheld from',
      async (_name, basePath) => {
        // The uniform denial's guarantee re-pinned against the split, and
        // deliberately the **same Server, the same container id and the same
        // socket** as the 4012 case above: the only thing that differs is
        // whether the machine answered. A reachable Server still refuses
        // byte-identically, and the caller learns nothing about the container
        // from the frame.
        const { ownerSession, organizationId, serverId } = await setUpServer();
        const member = await inviteMember(ownerSession.cookie, organizationId);

        const socket = dial(
          `${basePath}?containerId=eeeeeeeeeeee&serverId=${serverId}`,
          member.cookie,
        );
        await socket.opened;

        expect(await socket.closure()).toEqual({
          code: 4003,
          reason: 'Not found or not permitted',
        });
        expect(socket.frames).toHaveLength(0);
      },
    );
  });

  /**
   * The host branch, which was found wide open: with no `serverId`
   * the gateways never ran the organization-scoped server lookup, so the only
   * question ever asked about a container on the platform host was whether the
   * caller was signed in. A self-hosted instance runs every organization's
   * workloads on that host.
   *
   * The caller here is an **owner** of their own organization deliberately.
   * `checkServiceAccess` skips its row-level half for owners and admins, so this
   * is the case that passes if the resolution is handed to it without comparing
   * organizations first.
   */
  describe('a container owned outside the active organization', () => {
    it.each([
      ['logs', '/docker-container-logs?containerId=dddddddddddd'],
      ['terminal', '/docker-container-terminal?containerId=dddddddddddd'],
      ['stats', '/listen-docker-stats-monitoring?appName=their-app'],
    ])('is refused on the %s socket, with no frames', async (_name, path) => {
      const { ownerCtx, ownerSession } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      await applications.create(ownerCtx, {
        name: 'Their App',
        appName: 'their-app',
        environmentId: environment.environmentId,
      });
      await switchToFreshOrganization(ownerSession);
      containerOwnedBy('dddddddddddd', { swarmService: 'their-app' });

      const journalOf = captureJournal();
      const socket = dial(path, ownerSession.cookie);
      await socket.opened;
      const closure = await socket.closure();
      const journal = journalOf();

      expect(closure).toEqual({
        code: 4003,
        reason: 'Not found or not permitted',
      });
      expect(socket.frames).toHaveLength(0);
      // Nothing was started on any machine for a caller who was refused.
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
      expect(sshChannels.open).not.toHaveBeenCalled();
      expect(dockerClient.listContainers).not.toHaveBeenCalled();
      // Refused for the organization mismatch, not for want of entitlement:
      // this caller owns their own organization, so the entitlement half would
      // have passed them.
      //
      // The cause is on its own `Refused container:` line rather
      // than interpolated into the socket's: the message the socket line quotes
      // is now the same for every denial, because that message is also what the
      // REST routes return and it must not tell a foreign container from a
      // nonexistent one.
      expect(journal).toHaveLength(1);
      expect(journal[0]).toContain(ownerSession.id);
      expect(journal[0]).not.toContain('another organization');
      expect(
        causeLines().some(
          (line) =>
            line.includes('their-app') && line.includes('in organization'),
        ),
      ).toBe(true);
    });
  });

  /**
   * The other side of the gate. A container that traces back to no Service —
   * Traefik, the platform's own, anything an operator started by hand — has no
   * Service to ask about, so machine-level `docker:read` governs it instead
   * (ADR-0008). Under the current roles that is owner and admin only, and this
   * is the asymmetry this started from: `memberRole` grants `docker: []`, so a
   * base member is refused `GET /docker/containers` and used to be handed an
   * interactive shell in the same container over a socket.
   *
   * **That is owner and admin of the *instance* organization when
   * the target is on the platform host**, which is every case in this block
   * because none of them sends a `serverId`. The callers here are the first
   * signed-up user and a Member of their Organization, so the instance
   * organization is theirs and every expectation below is unchanged; the caller
   * who is newly refused is a second Organization's owner, and
   * `container-access.e2e-spec.ts`'s
   * `an unmanaged container on the platform host` is where that is asserted —
   * this seam is the one all three gateways share, and each of them only turns
   * what it throws into one close frame.
   */
  describe('an unmanaged container', () => {
    it.each([
      ['logs', '/docker-container-logs?containerId=traefik-proxy'],
      ['terminal', '/docker-container-terminal?containerId=traefik-proxy'],
    ])('streams to an owner on the %s socket', async (_name, path) => {
      const { ownerSession } = await setUpOwner();
      // Traefik carries none of the three owner labels.
      containerOwnedBy('traefik-proxy', {});
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const socket = dial(path, ownerSession.cookie);
      await socket.opened;
      await waitFor(() => ptyChannels.spawn.mock.calls.length > 0);
      channel.emitData('level=info msg="Configuration loaded"\n');
      await waitFor(() => output(socket).length > 0);

      expect(output(socket)).toEqual([
        'level=info msg="Configuration loaded"\n',
      ]);
      await hangUp(socket, channel);
    });

    it.each([
      ['logs', '/docker-container-logs?containerId=traefik-proxy'],
      ['terminal', '/docker-container-terminal?containerId=traefik-proxy'],
    ])(
      'is refused to a base member on the %s socket, with no frames',
      async (_name, path) => {
        const { ownerSession, organizationId } = await setUpOwner();
        const member = await inviteMember(ownerSession.cookie, organizationId);
        containerOwnedBy('traefik-proxy', {});

        const socket = dial(path, member.cookie);
        await socket.opened;

        expect(await socket.closure()).toEqual({
          code: 4003,
          reason: 'Not found or not permitted',
        });
        expect(socket.frames).toHaveLength(0);
        expect(ptyChannels.spawn).not.toHaveBeenCalled();
      },
    );

    /**
     * The mirror of the pair above, and the caller is an **owner**
     * deliberately: `cloudgate-traefik` carries no labels either, so it took the
     * same machine branch and streamed — the platform's ingress log, and an
     * interactive shell in the container that holds `/var/run/docker.sock`, to
     * an owner of any organization on the host.
     */
    it.each([
      ['logs', '/docker-container-logs?containerId=cloudgate-traefik'],
      ['terminal', '/docker-container-terminal?containerId=cloudgate-traefik'],
      [
        'swarm-addressed logs',
        '/docker-container-logs?containerId=cloudgate-traefik&runType=swarm',
      ],
    ])(
      "refuses the platform's own Traefik on the %s socket, with no frames",
      async (_name, path) => {
        const { ownerSession } = await setUpOwner();
        // Both shapes in one entry, because `containerOwnedBy` and
        // `swarmService` write the same key and the second would replace the
        // first — leaving the standalone cases refused because the daemon
        // double had no container of that name, which is a refusal the fix does
        // not cause and a test that cannot fail.
        inspectAnswers.set('cloudgate-traefik', {
          container: ['/cloudgate-traefik', NO_VALUE, NO_VALUE, NO_VALUE],
          // On a swarm install Traefik is a service, and `.Spec.Name` is the
          // only name that branch ever sees.
          service: ['cloudgate-traefik', NO_VALUE],
        });
        // A real channel, so a caller who is *not* refused streams rather than
        // erroring on an undefined return and closing anyway.
        ptyChannels.spawn.mockReturnValue(new FakeChannel());

        const socket = dial(path, ownerSession.cookie);
        await socket.opened;

        expect(await socket.closure()).toEqual({
          code: 4003,
          reason: 'Not found or not permitted',
        });
        expect(socket.frames).toHaveLength(0);
        expect(ptyChannels.spawn).not.toHaveBeenCalled();
      },
    );

    /**
     * A Trace store (ADR-0028): a plain container with no owner labels,
     * holding one Service's traces, and read only through the backend's
     * entitlement check. The logs socket would stream its output and the
     * terminal would open a shell beside the store's credentials.
     */
    it.each([
      [
        'logs',
        '/docker-container-logs?containerId=cloudgate-trace-store-application-web',
      ],
      [
        'terminal',
        '/docker-container-terminal?containerId=cloudgate-trace-store-application-web',
      ],
    ])(
      'refuses a Trace store on the %s socket, with no frames',
      async (_name, path) => {
        const { ownerSession } = await setUpOwner();
        inspectAnswers.set('cloudgate-trace-store-application-web', {
          container: [
            '/cloudgate-trace-store-application-web',
            NO_VALUE,
            NO_VALUE,
            NO_VALUE,
          ],
        });
        ptyChannels.spawn.mockReturnValue(new FakeChannel());

        const socket = dial(path, ownerSession.cookie);
        await socket.opened;

        expect(await socket.closure()).toEqual({
          code: 4003,
          reason: 'Not found or not permitted',
        });
        expect(socket.frames).toHaveLength(0);
        expect(ptyChannels.spawn).not.toHaveBeenCalled();
      },
    );
  });

  /**
   * The stats socket's host-sampling branch: `appName=cloudgate` samples the
   * *machine* rather than a container, so it names no Service and takes the
   * machine gate like any other unmanaged target. Of the three sockets
   * covered here this one had no check of any kind beyond authentication.
   *
   * This socket has no `serverId` parameter, so its machine gate
   * includes instance authority — the boundary ADR-0013's H-64 had already put
   * on `MonitoringService.findReadableTarget` for the same host readings over
   * HTTP. The owner below is the instance organization's, so it still samples.
   */
  describe('the stats socket asked for the platform host', () => {
    const hostPath = '/listen-docker-stats-monitoring?appName=cloudgate';

    it('samples for an owner', async () => {
      const { ownerSession } = await setUpOwner();

      const socket = dial(hostPath, ownerSession.cookie);
      await socket.opened;
      // Sampling reaching the machine is what says authorization passed; the
      // sample itself is `host-stats.service`'s own test.
      await waitFor(() =>
        remoteExec.execAsync.mock.calls.some(([command]) =>
          command.includes(SERVER_STATS_COMMAND),
        ),
      );

      socket.close();
    });

    it('is refused to a base member, and samples nothing', async () => {
      const { ownerSession, organizationId } = await setUpOwner();
      const member = await inviteMember(ownerSession.cookie, organizationId);

      const socket = dial(hostPath, member.cookie);
      await socket.opened;

      expect(await socket.closure()).toEqual({
        code: 4003,
        reason: 'Not found or not permitted',
      });
      expect(socket.frames).toHaveLength(0);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    /**
     * The host is not a container, so the container lookup must not be on its
     * path at all: an empty daemon still samples the machine.
     */
    it('needs no container to exist', async () => {
      const { ownerSession } = await setUpOwner();
      dockerClient.listContainers.mockResolvedValue([]);

      const socket = dial(hostPath, ownerSession.cookie);
      await socket.opened;
      await waitFor(() =>
        remoteExec.execAsync.mock.calls.some(([command]) =>
          command.includes(SERVER_STATS_COMMAND),
        ),
      );

      socket.close();
    });
  });

  /**
   * The container-existence oracle, as measured: on
   * `/listen-docker-stats-monitoring` a name owned by nobody answered `4000
   * Container not running` while a name owned by a Service in another
   * organization answered `4003`, so `4003` meant *"that name is a real Service
   * belonging to someone else"* to any caller with any valid key. 18/18
   * reproducible on a host.
   *
   * The root cause is one layer deeper than the close code: `appName` here is two
   * kinds of name. The live picker sends Docker's **container** name
   * (`target-options.ts`), which matches no Service row, so the unmanaged branch
   * is the common path on this socket rather than an edge case — and asking for
   * another organization's container name streamed its readings outright. A fix
   * confined to the close code would leave that.
   */
  describe('the stats socket as an enumeration oracle', () => {
    /** org1 owns `their-app`; the caller is an owner, in a second organization. */
    async function setUpForeignApplication() {
      const { ownerCtx, ownerSession } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      await applications.create(ownerCtx, {
        name: 'Their App',
        appName: 'their-app',
        environmentId: environment.environmentId,
      });
      await switchToFreshOrganization(ownerSession);
      return { ownerSession };
    }

    /**
     * Compared to each other rather than to a literal: the property under test
     * is indistinguishability, and `expect(a).toEqual(b)` is what states it.
     */
    it('answers a name owned by nobody and a name owned by another organization with the same frame', async () => {
      const { ownerSession } = await setUpForeignApplication();
      dockerClient.listContainers.mockResolvedValue([]);

      const nobody = dial(
        '/listen-docker-stats-monitoring?appName=zzz-nobody',
        ownerSession.cookie,
      );
      await nobody.opened;
      const nobodyClosure = await nobody.closure();

      const foreign = dial(
        '/listen-docker-stats-monitoring?appName=their-app',
        ownerSession.cookie,
      );
      await foreign.opened;
      const foreignClosure = await foreign.closure();

      expect(nobodyClosure).toEqual(foreignClosure);
      expect(nobody.frames).toHaveLength(0);
      expect(foreign.frames).toHaveLength(0);
    });

    /**
     * The leak a close-code-only fix would have left, and the assertion that
     * distinguishes a real fix from a cosmetic one: the picker's own parameter
     * for another organization's swarm task, which names no Service and used to
     * fall to `docker:read` and stream CPU, memory, network and block IO.
     */
    it("does not stream another organization's container to a caller who names it by container name", async () => {
      const { ownerSession } = await setUpForeignApplication();
      dockerClient.listContainers.mockResolvedValue([
        {
          Id: 'ccc333',
          State: 'running',
          Names: ['/their-app.1.kyc0lqth6ncv'],
          Labels: { 'com.docker.swarm.service.name': 'their-app' },
        },
      ]);

      const socket = dial(
        '/listen-docker-stats-monitoring?appName=their-app.1.kyc0lqth6ncv&appType=docker-compose',
        ownerSession.cookie,
      );
      await socket.opened;

      expect(await socket.closure()).toEqual({
        code: 4003,
        reason: 'Not found or not permitted',
      });
      expect(socket.frames).toHaveLength(0);
      expect(
        remoteExec.execAsync.mock.calls.filter(([command]) =>
          command.startsWith('docker stats'),
        ),
      ).toHaveLength(0);
    });

    /**
     * The shipped feature the narrowing this triage rejected would have deleted:
     * the picker sends a swarm task's full container name with
     * `appType: "docker-compose"` hardcoded, and it must still stream for the
     * people entitled to the Service behind it.
     */
    it('streams a swarm task named by the live picker to the owner of its Service', async () => {
      const { ownerCtx, ownerSession } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'web-app',
        environmentId: environment.environmentId,
      });
      dockerClient.listContainers.mockResolvedValue([
        {
          Id: 'aaa111',
          State: 'running',
          Names: ['/web-app.1.abc123'],
          Labels: { 'com.docker.swarm.service.name': 'web-app' },
        },
      ]);
      remoteExec.execAsync.mockImplementation((command) =>
        command.startsWith('docker stats')
          ? ok(
              JSON.stringify({
                BlockIO: '1.2MB / 3.4MB',
                CPUPerc: '7.25%',
                Container: 'aaa111',
                ID: 'aaa111',
                MemPerc: '5.00%',
                MemUsage: '64MiB / 1GiB',
                Name: 'web-app.1.abc123',
                NetIO: '5kB / 6kB',
              }),
            )
          : answerInspect(command),
      );

      const socket = dial(
        '/listen-docker-stats-monitoring?appName=web-app.1.abc123&appType=docker-compose',
        ownerSession.cookie,
      );
      await socket.opened;
      await waitFor(() => output(socket).length > 0);

      const { data } = JSON.parse(socket.frames[0]) as {
        data: { cpu: { value: string } | null };
      };
      expect(data.cpu?.value).toBe('7.25%');
      socket.close();
    });

    /**
     * The base member, whose role grants `docker: []`: refused on a container
     * name exactly as on a Service name, and refused before the daemon is asked
     * anything (ADR-0010's gate-before-side-effect rule).
     */
    it('refuses a base member the container name of a Service it is entitled to nothing of', async () => {
      const { ownerCtx, ownerSession, organizationId } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'web-app',
        environmentId: environment.environmentId,
      });
      const member = await inviteMember(ownerSession.cookie, organizationId);
      dockerClient.listContainers.mockResolvedValue([
        {
          Id: 'aaa111',
          State: 'running',
          Names: ['/web-app.1.abc123'],
          Labels: { 'com.docker.swarm.service.name': 'web-app' },
        },
      ]);

      const socket = dial(
        '/listen-docker-stats-monitoring?appName=web-app.1.abc123&appType=docker-compose',
        member.cookie,
      );
      await socket.opened;

      expect(await socket.closure()).toEqual({
        code: 4003,
        reason: 'Not found or not permitted',
      });
      expect(socket.frames).toHaveLength(0);
      expect(dockerClient.listContainers).not.toHaveBeenCalled();
    });
  });

  /**
   * The caller the fix must not have cost anything: a base member who *has*
   * been granted the Service. ADR-0008 turns on not additionally requiring
   * `docker:read` here — `memberRole` grants `docker: []`, and container logs
   * exist on no other transport, so requiring both would have taken every base
   * member's own logs away inside a security fix.
   */
  describe('a member entitled to the Service that owns the container', () => {
    /** The Application, plus a member granted it at row level. */
    async function setUpEntitledMember({ onServer = false } = {}) {
      const { ownerCtx, ownerSession, organizationId } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);

      let serverId: string | undefined;
      if (onServer) {
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

      const app = await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'my-app',
        environmentId: environment.environmentId,
        ...(serverId ? { serverId } : {}),
      });
      const member = await inviteMember(ownerSession.cookie, organizationId);
      await permissions.addNewService(
        permissionCtx(member.id, organizationId),
        app.applicationId,
      );
      containerOwnedBy('eeeeeeeeeeee', { swarmService: 'my-app' });
      return { member, serverId };
    }

    it.each([
      ['logs', '/docker-container-logs?containerId=eeeeeeeeeeee'],
      ['terminal', '/docker-container-terminal?containerId=eeeeeeeeeeee'],
    ])('streams on the %s socket on the platform host', async (_name, path) => {
      const { member } = await setUpEntitledMember();
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const socket = dial(path, member.cookie);
      await socket.opened;
      await waitFor(() => ptyChannels.spawn.mock.calls.length > 0);
      channel.emitData('serving on :3000\n');
      await waitFor(() => output(socket).length > 0);

      expect(output(socket)).toEqual(['serving on :3000\n']);
      await hangUp(socket, channel);
    });

    it.each([
      ['logs', '/docker-container-logs'],
      ['terminal', '/docker-container-terminal'],
    ])(
      'streams on the %s socket over a serverId, having read the labels there',
      async (_name, basePath) => {
        const { member, serverId } = await setUpEntitledMember({
          onServer: true,
        });
        const channel = new FakeChannel();
        sshChannels.open.mockResolvedValue(channel);

        const socket = dial(
          `${basePath}?containerId=eeeeeeeeeeee&serverId=${serverId}`,
          member.cookie,
        );
        await socket.opened;
        await waitFor(() => sshChannels.open.mock.calls.length > 0);
        channel.emitData('serving on :3000\n');
        await waitFor(() => output(socket).length > 0);

        expect(output(socket)).toEqual(['serving on :3000\n']);
        // The label read went to the server being addressed. Reading it on the
        // platform host would authorize one machine's socket against another
        // machine's containers.
        const remoteInspects = remoteExec.execAsyncRemote.mock.calls.filter(
          ([, command]) => command.includes('docker inspect'),
        );
        expect(remoteInspects).toHaveLength(1);
        expect(remoteInspects[0][0]).toBe(serverId);
        expect(remoteExec.execAsync).not.toHaveBeenCalled();
        await hangUp(socket, channel);
      },
    );

    it('receives stats frames for the Service it names', async () => {
      const { member } = await setUpEntitledMember();
      dockerClient.listContainers.mockResolvedValue([
        { Id: 'eeeeeeeeeeee', State: 'running' },
      ]);
      // What `docker stats --no-stream --format` prints for that container.
      remoteExec.execAsync.mockImplementation((command) =>
        command.startsWith('docker stats')
          ? ok(
              JSON.stringify({
                BlockIO: '1.2MB / 3.4MB',
                CPUPerc: '2.50%',
                Container: 'eeeeeeeeeeee',
                ID: 'eeeeeeeeeeee',
                MemPerc: '5.00%',
                MemUsage: '64MiB / 1GiB',
                Name: 'my-app',
                NetIO: '5kB / 6kB',
              }),
            )
          : answerInspect(command),
      );

      const socket = dial(
        '/listen-docker-stats-monitoring?appName=my-app',
        member.cookie,
      );
      await socket.opened;
      await waitFor(() => output(socket).length > 0);

      // The sample docker printed, arriving intact on the socket.
      const { data } = JSON.parse(socket.frames[0]) as {
        data: { cpu: { value: string } | null };
      };
      expect(data.cpu?.value).toBe('2.50%');
      socket.close();
    });
  });

  /**
   * The defect itself, on each of the three paths: a caller who is
   * authenticated, inside the organization, and whose row-level service access
   * does not include the Service behind the target. Every one of these used to
   * stream.
   */
  describe('a member the owning Service is withheld from', () => {
    it.each([
      ['logs', '/docker-container-logs?containerId=ffffffffffff'],
      ['terminal', '/docker-container-terminal?containerId=ffffffffffff'],
      ['stats', '/listen-docker-stats-monitoring?appName=my-app'],
    ])('is refused on the %s socket, with no frames', async (_name, path) => {
      const { ownerCtx, ownerSession, organizationId } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'my-app',
        environmentId: environment.environmentId,
      });
      const member = await inviteMember(ownerSession.cookie, organizationId);
      containerOwnedBy('ffffffffffff', { swarmService: 'my-app' });
      dockerClient.listContainers.mockResolvedValue([
        { Id: 'ffffffffffff', State: 'running' },
      ]);

      const socket = dial(path, member.cookie);
      await socket.opened;

      expect(await socket.closure()).toEqual({
        code: 4003,
        reason: 'Not found or not permitted',
      });
      expect(socket.frames).toHaveLength(0);
      // No pty, no ssh channel and no sampling: authorization runs before any
      // process is started on any machine.
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
      expect(sshChannels.open).not.toHaveBeenCalled();
      expect(dockerClient.listContainers).not.toHaveBeenCalled();
    });
  });

  /**
   * A preview deployment's container, which is the case the service gate would
   * have broken silently: a preview's `appName` is unique and lives in its own
   * table rather than among the eight the Service relation unions, so it
   * resolves to no Service at all unless asked for separately — and "resolves to
   * nothing" is the unmanaged branch, which under `memberRole`'s `docker: []`
   * denies a preview's logs to the very member who owns its parent Application
   * (ADR-0008).
   */
  describe("a preview deployment's container", () => {
    /** The parent Application, a preview of it, and a member of the org. */
    async function setUpPreview() {
      const { ownerCtx, ownerSession, organizationId } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      const app = await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'my-app',
        environmentId: environment.environmentId,
      });
      await ctx.db.insert(previewDeployment).values({
        appName: 'preview-my-app-abc',
        applicationId: app.applicationId,
        branch: 'feature/x',
        pullRequestId: '1',
        pullRequestNumber: '1',
        pullRequestTitle: 'Add a thing',
        pullRequestURL: 'https://example.com/pr/1',
        domain: 'preview-my-app-abc.example.com',
      });
      const member = await inviteMember(ownerSession.cookie, organizationId);
      containerOwnedBy('111111111111', {
        swarmService: 'preview-my-app-abc',
      });
      return { app, member, organizationId };
    }

    it('streams to a member entitled to the parent Application', async () => {
      const { app, member, organizationId } = await setUpPreview();
      await permissions.addNewService(
        permissionCtx(member.id, organizationId),
        app.applicationId,
      );
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const socket = dial(
        '/docker-container-logs?containerId=111111111111',
        member.cookie,
      );
      await socket.opened;
      await waitFor(() => ptyChannels.spawn.mock.calls.length > 0);
      channel.emitData('preview is up\n');
      await waitFor(() => output(socket).length > 0);

      expect(output(socket)).toEqual(['preview is up\n']);
      await hangUp(socket, channel);
    });

    it('is refused to a member the parent Application is withheld from', async () => {
      const { member } = await setUpPreview();

      const socket = dial(
        '/docker-container-logs?containerId=111111111111',
        member.cookie,
      );
      await socket.opened;

      expect(await socket.closure()).toEqual({
        code: 4003,
        reason: 'Not found or not permitted',
      });
      expect(socket.frames).toHaveLength(0);
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
    });
  });

  /**
   * **A shell takes `service:update` on the Service that owns the container
   * (ADR-0008 as amended).** A shell writes inside the workload, and
   * it is settled that `service: ['read']` means read only — so a licensed
   * custom role holding exactly that keeps the log of a Service it is entitled
   * to and loses its shell.
   *
   * And it loses it **in the socket's one refusal**: its own Service's
   * container, another organization's and one that does not exist close
   * byte-identically, so the action cannot be used to tell them apart — the
   * enumeration property the blocks above pin for every other refusal.
   */
  describe('a read-only custom role', () => {
    async function setUpReader() {
      const { ownerCtx, ownerSession, organizationId } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      const app = await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'my-app',
        environmentId: environment.environmentId,
      });
      const reader = await inviteMember(ownerSession.cookie, organizationId);
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'service-reader',
        permission: { service: ['read'] },
      });
      await ctx.db
        .update(memberRow)
        .set({ role: 'service-reader', accessedServices: [app.applicationId] })
        .where(
          and(
            eq(memberRow.userId, reader.id),
            eq(memberRow.organizationId, organizationId),
          ),
        );
      containerOwnedBy('eeeeeeeeeeee', { swarmService: 'my-app' });
      return { reader, ownerSession };
    }

    it("still streams its own Service's log, which takes read", async () => {
      const { reader } = await setUpReader();
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const socket = dial(
        '/docker-container-logs?containerId=eeeeeeeeeeee',
        reader.cookie,
      );
      await socket.opened;
      await waitFor(() => ptyChannels.spawn.mock.calls.length > 0);
      channel.emitData('serving on :3000\n');
      await waitFor(() => output(socket).length > 0);

      expect(output(socket)).toEqual(['serving on :3000\n']);
      await hangUp(socket, channel);
    });

    it('is refused a shell in its own Service, a foreign one and a missing one, byte-identically', async () => {
      const { reader, ownerSession } = await setUpReader();
      // A Service in another organization: the owner's, made from a second
      // organization they switch into and back out of.
      const ownerOrganization = await request(httpServer)
        .get('/organizations/active')
        .set('Cookie', ownerSession.cookie);
      const foreignOrganizationId =
        await switchToFreshOrganization(ownerSession);
      const foreignEnvironment = await setUpEnvironment(
        permissionCtx(ownerSession.id, foreignOrganizationId),
      );
      await applications.create(
        permissionCtx(ownerSession.id, foreignOrganizationId),
        {
          name: 'Their App',
          appName: 'their-app',
          environmentId: foreignEnvironment.environmentId,
        },
      );
      await ctx.db
        .update(session)
        .set({
          activeOrganizationId: (ownerOrganization.body as { id: string }).id,
        })
        .where(eq(session.userId, ownerSession.id));
      containerOwnedBy('dddddddddddd', { swarmService: 'their-app' });

      const closures: { code: number; reason: string }[] = [];
      for (const containerId of [
        'eeeeeeeeeeee',
        'dddddddddddd',
        'bbbbbbbbbbbb',
      ]) {
        const socket = dial(
          `/docker-container-terminal?containerId=${containerId}`,
          reader.cookie,
        );
        await socket.opened;
        closures.push(await socket.closure());
        expect(socket.frames).toHaveLength(0);
      }

      expect(closures).toEqual([
        { code: 4003, reason: 'Not found or not permitted' },
        { code: 4003, reason: 'Not found or not permitted' },
        { code: 4003, reason: 'Not found or not permitted' },
      ]);
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
    });
  });

  /**
   * An Application's Logs tab on a Server or the platform host (#1341): it
   * follows the Application's Swarm service, named its `appName`, with
   * `runType=swarm`, and asks for Docker's task prefix so each line names its
   * copy. The gate is the same as a database's Container output —
   * entitlement to the Service and `service: ['read']` — and the prefix is an
   * opt-in on that one caller, so the stripped command the database and
   * Compose views run is untouched.
   */
  describe("an Application's Logs tab, addressed by its Swarm service", () => {
    const LOGS_TAB =
      '/docker-container-logs?containerId=my-app&runType=swarm&tail=200&taskPrefix=true';

    /** The Application, a base member, and its Swarm service on the daemon. */
    async function setUpApplication({ onServer = false } = {}) {
      const { ownerCtx, ownerSession, organizationId } = await setUpOwner();
      const environment = await setUpEnvironment(ownerCtx);
      let serverId: string | undefined;
      if (onServer) {
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
      const app = await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'my-app',
        environmentId: environment.environmentId,
        ...(serverId ? { serverId } : {}),
      });
      const member = await inviteMember(ownerSession.cookie, organizationId);
      swarmService('my-app');
      return { app, member, organizationId, serverId };
    }

    it('streams every copy, each line naming it, to a member entitled to the Application on the platform host', async () => {
      const { app, member, organizationId } = await setUpApplication();
      await permissions.addNewService(
        permissionCtx(member.id, organizationId),
        app.applicationId,
      );
      const channel = new FakeChannel();
      ptyChannels.spawn.mockReturnValue(channel);

      const socket = dial(LOGS_TAB, member.cookie);
      await socket.opened;
      await waitFor(() => ptyChannels.spawn.mock.calls.length > 0);
      const lines =
        '2026-11-10T09:00:00.000000001Z my-app.1@node-1    | listening on :80\n' +
        '2026-11-10T09:00:00.500000000Z my-app.2@node-1    | listening on :80\n';
      channel.emitData(lines);
      await waitFor(() => output(socket).length > 0);

      expect(output(socket)).toEqual([lines]);
      // The prefix is kept: `--no-task-ids` in place of `--raw`.
      const [, args] = ptyChannels.spawn.mock.calls[0] as [string, string[]];
      expect(args[1]).toBe(
        'docker service logs --timestamps --no-task-ids --tail 200  --follow my-app',
      );
      await hangUp(socket, channel);
    });

    it('streams over the Server the Application runs on', async () => {
      const { app, member, organizationId, serverId } = await setUpApplication({
        onServer: true,
      });
      await permissions.addNewService(
        permissionCtx(member.id, organizationId),
        app.applicationId,
      );
      const channel = new FakeChannel();
      sshChannels.open.mockResolvedValue(channel);

      const socket = dial(`${LOGS_TAB}&serverId=${serverId}`, member.cookie);
      await socket.opened;
      await waitFor(() => sshChannels.open.mock.calls.length > 0);
      channel.emitData('2026-11-10T09:00:00Z my-app.1@worker-1    | ready\n');
      await waitFor(() => output(socket).length > 0);

      expect(output(socket)).toEqual([
        '2026-11-10T09:00:00Z my-app.1@worker-1    | ready\n',
      ]);
      const [target, options] = sshChannels.open.mock.calls[0] as [
        { serverId: string },
        { command: string },
      ];
      expect(target).toEqual({ serverId });
      expect(options.command).toContain('--no-task-ids');
      expect(options.command).not.toContain('--raw');
      await hangUp(socket, channel);
    });

    it('is refused to a member the Application is withheld from, with no frames and no follower', async () => {
      const { member } = await setUpApplication();

      const socket = dial(LOGS_TAB, member.cookie);
      await socket.opened;

      expect(await socket.closure()).toEqual({
        code: 4003,
        reason: 'Not found or not permitted',
      });
      expect(socket.frames).toHaveLength(0);
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
      expect(sshChannels.open).not.toHaveBeenCalled();
    });

    it("is refused to a role entitled to the Application but without service: ['read']", async () => {
      const { app, member, organizationId } = await setUpApplication();
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'audit-reader',
        permission: { auditLog: ['read'] },
      });
      await ctx.db
        .update(memberRow)
        .set({ role: 'audit-reader', accessedServices: [app.applicationId] })
        .where(
          and(
            eq(memberRow.userId, member.id),
            eq(memberRow.organizationId, organizationId),
          ),
        );

      const socket = dial(LOGS_TAB, member.cookie);
      await socket.opened;

      expect(await socket.closure()).toEqual({
        code: 4003,
        reason: 'Not found or not permitted',
      });
      expect(socket.frames).toHaveLength(0);
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
    });

    it('refuses the task prefix for a single container, which has no copies to name', async () => {
      const { ownerSession } = await setUpOwner();

      const socket = dial(
        '/docker-container-logs?containerId=eeeeeeeeeeee&taskPrefix=true',
        ownerSession.cookie,
      );
      await socket.opened;

      expect(await socket.closure()).toEqual({
        code: 4000,
        reason: 'taskPrefix is only for a Swarm service',
      });
      expect(ptyChannels.spawn).not.toHaveBeenCalled();
    });
  });
});
