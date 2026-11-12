import request from 'supertest';
import { App } from 'supertest/types';
import * as schema from '../../src/db/schema';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RUNTIME_INFO_CACHE_MS } from '../../src/settings/runtime-info.service';
import type { RuntimeInfo } from '../../src/settings/runtime-info.service';
import type { RuntimeProbeRaw } from '../../src/settings/runtime-probe';
import { CLOUDGATE_VERSION } from '../../src/settings/version';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The two constants the route reports as *declared* are read at import time out
 * of the environment, and `createTestApp` imports `AppModule` lazily — so
 * clearing them here, before the app is built, is what makes the declared side
 * of every assertion below the documented default rather than whatever the
 * machine running the suite happens to export.
 */
delete process.env.TRAEFIK_VERSION;
delete process.env.RELEASE_TAG;

/** `TRAEFIK_VERSION`'s default in `servers/server-setup.ts`, written out. */
const DECLARED_TRAEFIK = '3.6.7';
/** `DOCKER_VERSION` in `servers/server-setup.ts`, written out. */
const DECLARED_DOCKER = '28.5.0';

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

/**
 * A healthy host's probe document. Overriding one key is how every degradation
 * below is expressed, because that is exactly what the script does on a host
 * missing one thing: the field goes empty, the document stays valid.
 */
const probeDocument = (over: Partial<RuntimeProbeRaw> = {}): string =>
  JSON.stringify({
    docker: '28.5.0',
    swarm: 'active',
    traefik: 'traefik:v3.6.7',
    os: 'Ubuntu 24.04.1 LTS',
    kernel: 'Linux 6.8.0-31-generic',
    uptimeSeconds: '864000',
    network: 'true',
    diskFreeKib: '10485760',
    diskTotalKib: '52428800',
    ...over,
  } satisfies RuntimeProbeRaw);

describe('Runtime info (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const remoteExec = {
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
    execFileAsync: jest.fn<Promise<ExecResult>, [string, string[]]>(),
  };

  /**
   * The service caches one answer per host for `RUNTIME_INFO_CACHE_MS`, and the
   * cache lives as long as the app — so without this every test after the first
   * would read the first one's answer for the platform host. Moving the clock a
   * whole window forward between tests expires it, and leaves the window itself
   * available *inside* a test, which is what the cache assertion needs.
   */
  let clock = Date.now();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: remoteExec }],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    clock += RUNTIME_INFO_CACHE_MS * 2;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    remoteExec.execAsync.mockResolvedValue(ok(probeDocument()));
    remoteExec.execAsyncRemote.mockResolvedValue(ok(probeDocument()));
  });

  /** The caller's own organization id, for the Server rows below. */
  async function organizationId(cookie: string): Promise<string> {
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', cookie);
    return (orgs.body as { id: string }[])[0].id;
  }

  async function ownServer(cookie: string): Promise<string> {
    const [row] = await ctx.db
      .insert(schema.server)
      .values({
        name: 'srv',
        ipAddress: '10.0.0.1',
        port: 22,
        organizationId: await organizationId(cookie),
      })
      .returning();
    return row.serverId;
  }

  const read = (cookie: string, serverId?: string) =>
    request(httpServer)
      .get('/settings/runtime-info')
      .query(serverId ? { serverId } : {})
      .set('Cookie', cookie);

  describe('the platform host', () => {
    it('reports declared and observed values for every field', async () => {
      const session = await signUp(httpServer, owner);

      const res = await read(session.cookie);
      expect(res.status).toBe(200);
      const body = res.body as RuntimeInfo;

      expect(body.serverId).toBeNull();
      expect(body.cloudgate).toEqual({
        scope: 'process',
        version: CLOUDGATE_VERSION,
        releaseTag: 'latest',
        node: process.version,
        uptimeSeconds: expect.any(Number) as number,
      });

      // Declared beside observed, and agreeing — the healthy install.
      expect(body.traefik).toEqual({
        declared: DECLARED_TRAEFIK,
        observed: DECLARED_TRAEFIK,
        raw: 'traefik:v3.6.7',
        scope: 'host',
        drift: false,
      });
      expect(body.docker).toEqual({
        declared: DECLARED_DOCKER,
        observed: DECLARED_DOCKER,
        scope: 'host',
        drift: false,
      });
      expect(body.swarm).toEqual({
        declared: null,
        observed: 'active',
        scope: 'host',
        drift: false,
      });
      expect(body.operatingSystem.observed).toBe('Ubuntu 24.04.1 LTS');
      expect(body.kernel.observed).toBe('Linux 6.8.0-31-generic');
      expect(body.uptimeSeconds.observed).toBe(864_000);
      expect(body.cloudgateNetwork.observed).toBe(true);
      expect(body.directory.freeBytes).toBe(10_485_760 * 1024);
      expect(body.directory.totalBytes).toBe(52_428_800 * 1024);
      expect(body.directory.reason).toBeUndefined();

      // Postgres is observed against the real container this suite boots, so
      // the version is whatever it runs — the assertion is that it was read.
      expect(body.postgres.raw).toContain('PostgreSQL');
      expect(body.postgres.observed).toMatch(/^\d+/);
      expect(body.postgres.declared).toBeNull();
      expect(body.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // The scope census on the happy path, not only in degradation: on the
      // platform host a process-scoped reading and a host-scoped one are about
      // the same machine, which is exactly the case where a consumer must not
      // conclude the two are interchangeable.
      expect(body.postgres.scope).toBe('process');
      expect(body.cloudgate.scope).toBe('process');
      for (const probe of [
        body.traefik,
        body.docker,
        body.swarm,
        body.operatingSystem,
        body.kernel,
        body.uptimeSeconds,
        body.cloudgateNetwork,
      ]) {
        expect(probe.scope).toBe('host');
      }
      // `directory` is not a `Probe` and scopes itself by publishing `path`.
      expect('scope' in body.directory).toBe(false);
    });

    it('probes the host once, locally, with the whole inventory in one script', async () => {
      const session = await signUp(httpServer, owner);

      const res = await read(session.cookie);
      expect(res.status).toBe(200);

      // Constraint 6: one round trip per host, not one per field.
      expect(remoteExec.execAsync).toHaveBeenCalledTimes(1);
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
      const script = remoteExec.execAsync.mock.calls[0][0];
      expect(script).toContain(
        "docker inspect cloudgate-traefik --format '{{.Config.Image}}'",
      );
      expect(script).toContain("docker version --format '{{.Server.Version}}'");
      expect(script).toContain(
        "docker info --format '{{.Swarm.LocalNodeState}}'",
      );
      expect(script).toContain('docker network inspect cloudgate-network');
      expect(script).toContain('uname -sr');
      expect(script).toContain('PRETTY_NAME');
      expect(script).toContain('/proc/uptime');
      expect(script).toContain('df -Pk');
    });

    it('reads the document out of the last line, behind a login banner', async () => {
      const session = await signUp(httpServer, owner);
      remoteExec.execAsync.mockResolvedValue(
        ok(`Welcome to Ubuntu\nLast login: today\n${probeDocument()}\n`),
      );

      const res = await read(session.cookie);
      expect(res.status).toBe(200);
      expect((res.body as RuntimeInfo).docker.observed).toBe(DECLARED_DOCKER);
    });
  });

  describe('drift between declared and observed', () => {
    it('reports both versions when the running Traefik is not the pinned one', async () => {
      const session = await signUp(httpServer, owner);
      // The install where this was found: TRAEFIK_VERSION was bumped and nobody
      // recreated the container, so the tag on disk and the tag running disagree.
      remoteExec.execAsync.mockResolvedValue(
        ok(probeDocument({ traefik: 'traefik:v3.5.0', docker: '27.1.2' })),
      );

      const res = await read(session.cookie);
      expect(res.status).toBe(200);
      const body = res.body as RuntimeInfo;

      expect(body.traefik).toEqual({
        declared: DECLARED_TRAEFIK,
        observed: '3.5.0',
        raw: 'traefik:v3.5.0',
        scope: 'host',
        drift: true,
      });
      expect(body.traefik.declared).not.toBe(body.traefik.observed);

      expect(body.docker).toEqual({
        declared: DECLARED_DOCKER,
        observed: '27.1.2',
        scope: 'host',
        drift: true,
      });
    });

    it('reads the version through a registry-qualified image reference', async () => {
      const session = await signUp(httpServer, owner);
      remoteExec.execAsync.mockResolvedValue(
        ok(
          probeDocument({
            traefik: 'registry.example.com:5000/traefik:v3.5.0',
          }),
        ),
      );

      const body = (await read(session.cookie)).body as RuntimeInfo;
      expect(body.traefik.observed).toBe('3.5.0');
      expect(body.traefik.drift).toBe(true);
    });

    it('claims no drift when the running image carries no version tag', async () => {
      const session = await signUp(httpServer, owner);
      remoteExec.execAsync.mockResolvedValue(
        ok(probeDocument({ traefik: 'traefik' })),
      );

      const body = (await read(session.cookie)).body as RuntimeInfo;
      expect(body.traefik).toEqual({
        declared: DECLARED_TRAEFIK,
        observed: null,
        raw: 'traefik',
        reason: 'the running Traefik image carries no version tag',
        scope: 'host',
        drift: false,
      });
    });
  });

  describe('a Server', () => {
    it('probes the Server over SSH and measures its own platform directory', async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServer(session.cookie);
      remoteExec.execAsyncRemote.mockResolvedValue(
        ok(probeDocument({ traefik: 'traefik:v3.5.0', swarm: 'inactive' })),
      );

      const res = await read(session.cookie, serverId);
      expect(res.status).toBe(200);
      const body = res.body as RuntimeInfo;

      expect(body.serverId).toBe(serverId);
      expect(body.traefik.observed).toBe('3.5.0');
      expect(body.traefik.declared).toBe(DECLARED_TRAEFIK);
      expect(body.traefik.drift).toBe(true);
      expect(body.swarm.observed).toBe('inactive');

      // Nothing ran locally, and the path measured is the Server's own root
      // rather than this instance's.
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledTimes(1);
      const [addressed, script] = remoteExec.execAsyncRemote.mock.calls[0];
      expect(addressed).toBe(serverId);
      expect(script).toContain(`df -Pk '${REMOTE_CLOUDGATE_DIRECTORY}'`);
      expect(body.directory.path).toBe(REMOTE_CLOUDGATE_DIRECTORY);
    });

    /**
     * The reported case, reproducible from the suite: a Server that
     * answered nothing at all still got a confident `postgres.observed`, in a
     * response otherwise uniformly *could not reach this host*. The reading
     * stays — it is true, and an owner wants it during an incident — but it now
     * says which machine it is about.
     */
    it('separates what it read off an unreachable Server from what it read off itself', async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServer(session.cookie);
      remoteExec.execAsyncRemote.mockRejectedValue(
        new Error(
          'SSH connection error: Timed out while waiting for handshake',
        ),
      );

      const res = await read(session.cookie, serverId);
      expect(res.status).toBe(200);
      const body = res.body as RuntimeInfo;

      // Partition the payload by what it claims to be about. Every host-scoped
      // reading is null with the handshake timeout as its reason; the two
      // process-scoped ones are populated, and are not claims about that host.
      const hostScoped = Object.entries(body).filter(
        ([, value]) =>
          typeof value === 'object' &&
          value !== null &&
          (value as { scope?: string }).scope === 'host',
      );
      expect(hostScoped).toHaveLength(7);
      for (const [, probe] of hostScoped) {
        expect((probe as { observed: unknown }).observed).toBeNull();
        expect((probe as { reason?: string }).reason).toBe(
          'SSH connection error: Timed out while waiting for handshake',
        );
      }

      expect(body.postgres.scope).toBe('process');
      expect(body.postgres.observed).toMatch(/^\d+/);
      expect(body.cloudgate.scope).toBe('process');

      // `directory` is host-scoped by its own means — it publishes the path it
      // measured — which is the argument for leaving it without a `scope`.
      expect('scope' in body.directory).toBe(false);
      expect(body.directory.path).toBe(REMOTE_CLOUDGATE_DIRECTORY);
    });

    it('refuses a serverId in another organization before probing anything', async () => {
      const session = await signUp(httpServer, owner);

      const res = await read(session.cookie, 'srv-of-someone-else');
      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Server not found',
      );
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });
  });

  describe('degradation', () => {
    it('reports Docker and Traefik as null with a reason and still answers 200', async () => {
      const session = await signUp(httpServer, owner);
      // Docker stopped: the daemon answers nothing, so the four fields that
      // come from it go empty. Everything else on the host still answers.
      remoteExec.execAsync.mockResolvedValue(
        ok(
          probeDocument({
            docker: '',
            swarm: '',
            traefik: '',
            network: '',
          }),
        ),
      );

      const res = await read(session.cookie);
      expect(res.status).toBe(200);
      const body = res.body as RuntimeInfo;

      expect(body.docker).toEqual({
        declared: DECLARED_DOCKER,
        observed: null,
        reason: 'the Docker daemon did not report a version',
        scope: 'host',
        drift: false,
      });
      expect(body.traefik).toEqual({
        declared: DECLARED_TRAEFIK,
        observed: null,
        raw: null,
        reason: 'cloudgate-traefik is not present on this host',
        scope: 'host',
        drift: false,
      });
      expect(body.swarm.observed).toBeNull();
      expect(body.swarm.reason).toBe(
        'the Docker daemon did not report a Swarm state',
      );
      expect(body.cloudgateNetwork.observed).toBeNull();
      expect(body.cloudgateNetwork.reason).toBe(
        'the Docker daemon did not answer',
      );

      // The rest of the inventory is intact — that is the whole point of
      // degrading per field rather than failing the response.
      expect(body.operatingSystem.observed).toBe('Ubuntu 24.04.1 LTS');
      expect(body.kernel.observed).toBe('Linux 6.8.0-31-generic');
      expect(body.uptimeSeconds.observed).toBe(864_000);
      expect(body.directory.freeBytes).toBe(10_485_760 * 1024);
      expect(body.postgres.observed).toMatch(/^\d+/);
      expect(body.cloudgate.version).toBe(CLOUDGATE_VERSION);
    });

    it('degrades every probed field when a Server cannot be reached, rather than 500ing', async () => {
      const session = await signUp(httpServer, owner);
      const serverId = await ownServer(session.cookie);
      remoteExec.execAsyncRemote.mockRejectedValue(
        new Error('Connection refused: 10.0.0.1:22'),
      );

      const res = await read(session.cookie, serverId);
      expect(res.status).toBe(200);
      const body = res.body as RuntimeInfo;

      const unreachable = 'Connection refused: 10.0.0.1:22';
      expect(body.docker.observed).toBeNull();
      expect(body.docker.reason).toBe(unreachable);
      expect(body.traefik.observed).toBeNull();
      expect(body.traefik.reason).toBe(unreachable);
      expect(body.swarm.reason).toBe(unreachable);
      expect(body.operatingSystem.reason).toBe(unreachable);
      expect(body.kernel.reason).toBe(unreachable);
      expect(body.uptimeSeconds.reason).toBe(unreachable);
      expect(body.cloudgateNetwork.reason).toBe(unreachable);
      expect(body.directory.freeBytes).toBeNull();
      expect(body.directory.reason).toBe(unreachable);

      // The declared side and the platform's own facts never depended on the
      // Server, so they are still there — and now they say so. A reader
      // scanning `observed` down a payload that is otherwise uniformly "could
      // not reach this host" gets a positive signal, so the signal has to name
      // the machine it is about.
      expect(body.traefik.declared).toBe(DECLARED_TRAEFIK);
      expect(body.docker.declared).toBe(DECLARED_DOCKER);
      expect(body.cloudgate.node).toBe(process.version);
      expect(body.cloudgate.scope).toBe('process');
      expect(body.postgres.observed).toMatch(/^\d+/);
      expect(body.postgres.scope).toBe('process');

      // And every field that *was* about the unreachable Server says so, so
      // "host-scoped and null" is distinguishable from "process-scoped and
      // populated" without a hardcoded list of which key is which.
      for (const probe of [
        body.docker,
        body.traefik,
        body.swarm,
        body.operatingSystem,
        body.kernel,
        body.uptimeSeconds,
        body.cloudgateNetwork,
      ]) {
        expect(probe.scope).toBe('host');
        expect(probe.observed).toBeNull();
      }
    });

    it('degrades one field when the host answers a document it cannot parse', async () => {
      const session = await signUp(httpServer, owner);
      remoteExec.execAsync.mockResolvedValue(ok('sh: 1: docker: not found'));

      const res = await read(session.cookie);
      expect(res.status).toBe(200);
      const body = res.body as RuntimeInfo;
      expect(body.docker.observed).toBeNull();
      expect(body.docker.reason).toContain('JSON');
      expect(body.postgres.observed).toMatch(/^\d+/);
    });
  });

  describe('gating', () => {
    it('denies an unauthenticated caller with 401', async () => {
      const res = await request(httpServer).get('/settings/runtime-info');
      expect(res.status).toBe(401);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('refuses a member who is neither owner nor admin', async () => {
      const session = await signUp(httpServer, owner);
      const member = await signUpMember(httpServer, session.cookie);

      const res = await read(member.cookie);
      expect(res.status).toBe(403);
      // The platform host's own version inventory, so the refusal is the
      // instance one since H-63 — reads move with writes on this surface
      // (ADR-0013), and this route's own docblock already calls the answer a
      // targeting aid.
      expect((res.body as { message: string }).message).toBe(
        'Only an owner or admin of the instance organization can configure the platform host',
      );
      // A version inventory is a targeting aid: nothing was probed on the way
      // to the refusal.
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('probes a host once for two calls inside the cache window', async () => {
      const session = await signUp(httpServer, owner);

      const first = await read(session.cookie);
      const second = await read(session.cookie);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(remoteExec.execAsync).toHaveBeenCalledTimes(1);
      expect((second.body as RuntimeInfo).observedAt).toBe(
        (first.body as RuntimeInfo).observedAt,
      );

      // The window is per host: a Server is a different key and probes again.
      const serverId = await ownServer(session.cookie);
      const remote = await read(session.cookie, serverId);
      expect(remote.status).toBe(200);
      expect(remoteExec.execAsync).toHaveBeenCalledTimes(1);
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledTimes(1);
    });

    it('probes again once the window has passed', async () => {
      const session = await signUp(httpServer, owner);

      await read(session.cookie);
      expect(remoteExec.execAsync).toHaveBeenCalledTimes(1);

      clock += RUNTIME_INFO_CACHE_MS + 1;
      await read(session.cookie);
      expect(remoteExec.execAsync).toHaveBeenCalledTimes(2);
    });
  });
});
