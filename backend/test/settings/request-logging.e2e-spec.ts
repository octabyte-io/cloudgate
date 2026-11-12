import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse } from 'yaml';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import * as schema from '../../src/db/schema';
import { auditLog } from '../../src/enterprise/audit-logs/audit-log.schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { MAIN_TRAEFIK_DIR } from '../../src/settings/traefik-files.service';
import { withArgvExec } from '../utils/exec-double';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * **Request logging** on a Server: `POST /settings/traefik/requests`
 * turns that Server's Access log on or off in one audited action — the
 * `traefik.yml` write and the Traefik restart in the same request — behind
 * the gate `POST /settings/traefik/reload` takes, with no Instance-organization
 * override. Turning it on keeps only the User-Agent header (ADR-0055). The
 * platform host's branch keeps its write-then-restart in two steps.
 *
 * The doubles are the two boundaries the route reaches, as in
 * `request-metrics.e2e-spec.ts`: the exec layer (a Server's traefik.yml is
 * what its `cat` answers and its `base64 -d >` write lands in; the restart is a
 * command sent there) and `MAIN_TRAEFIK_DIR`, which points the platform host at
 * a temp dir. What is asserted is what an operator observes: the response, the
 * file, the restart sent to the machine, and the audit row.
 */

const REMOTE_TRAEFIK_YML = `${REMOTE_CLOUDGATE_DIRECTORY}/traefik/traefik.yml`;
const OLD_TRAEFIK_YML =
  "entryPoints:\n  web:\n    address: ':80'\n  websecure:\n    address: ':443'\n";
const RESTART = 'docker restart cloudgate-traefik';
const ROUTE = 'POST /settings/traefik/requests';

/** `SettingsService.requireOwnerOrAdmin`'s refusal, written out. */
const OWNER_OR_ADMIN_REFUSAL =
  'Only owners and admins can manage web server settings';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

/** The file an `echo "<b64>" | base64 -d > <path>` write carries. */
function writtenFile(command: string): { path: string; content: string } {
  const match = /^echo "([^"]*)" \| base64 -d > (\S+)$/.exec(command);
  if (!match) throw new Error(`not a file write: ${command}`);
  return {
    path: match[2].replace(/^'|'$/g, ''),
    content: Buffer.from(match[1], 'base64').toString('utf8'),
  };
}

describe('Request logging on a Server (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let traefikDir: string;
  /** A Server's files, by path: what its `cat` answers, where writes land. */
  let serverFiles: Record<string, string>;

  const answer = (command: string): Promise<ExecResult> => {
    if (command.includes('RESOURCE_NAME=')) {
      return Promise.resolve(ok('standalone\n'));
    }
    const cat = /^cat (\S+)$/.exec(command);
    if (cat) return Promise.resolve(ok(serverFiles[cat[1]] ?? ''));
    if (command.includes('base64 -d >')) {
      const { path: file, content } = writtenFile(command);
      serverFiles[file] = content;
    }
    return Promise.resolve(ok(''));
  };

  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  beforeAll(async () => {
    traefikDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-rl-'));
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: remoteExec },
        {
          provide: MAIN_TRAEFIK_DIR,
          useValue: (serverId?: string | null) =>
            serverId ? `${REMOTE_CLOUDGATE_DIRECTORY}/traefik` : traefikDir,
        },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    fs.rmSync(traefikDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    serverFiles = { [REMOTE_TRAEFIK_YML]: OLD_TRAEFIK_YML };
    remoteExec.execAsync.mockImplementation(answer);
    remoteExec.execAsyncRemote.mockImplementation((_id, command) =>
      answer(command),
    );
    fs.rmSync(traefikDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(traefikDir, 'dynamic'), { recursive: true });
    fs.writeFileSync(path.join(traefikDir, 'traefik.yml'), OLD_TRAEFIK_YML);
  });

  const platformYml = () =>
    fs.readFileSync(path.join(traefikDir, 'traefik.yml'), 'utf8');

  async function signUpOwner() {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'];
    const orgs = await request(httpServer)
      .get('/organizations/active')
      .set('Cookie', cookie);
    return { cookie, organizationId: (orgs.body as { id: string }).id };
  }

  async function insertServer(organizationId: string, name = 'edge') {
    const [row] = await ctx.db
      .insert(schema.server)
      .values({ name, ipAddress: '203.0.113.20', port: 22, organizationId })
      .returning();
    return row;
  }

  const toggle = (cookie: string, enable: boolean, serverId?: string) =>
    request(httpServer)
      .post('/settings/traefik/requests')
      .set('Cookie', cookie)
      .send(serverId ? { enable, serverId } : { enable });

  /**
   * A Server's restart is awaited before the answer; the platform host's
   * `POST /settings/traefik/reload` is not, and this lets it run.
   */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  const sentTo = (serverId: string) =>
    remoteExec.execAsyncRemote.mock.calls
      .filter(([id]) => id === serverId)
      .map(([, command]) => command);

  const commands = () => [
    ...remoteExec.execAsync.mock.calls.map(([command]) => command),
    ...remoteExec.execAsyncRemote.mock.calls.map(([, command]) => command),
  ];

  const loggingRows = async () =>
    (await ctx.db.select().from(auditLog)).filter((row) =>
      row.metadata?.includes('/settings/traefik/requests'),
    );

  const serverYml = () =>
    parse(serverFiles[REMOTE_TRAEFIK_YML]) as {
      accessLog?: {
        filePath: string;
        fields?: { headers?: Record<string, unknown> };
      };
      entryPoints?: unknown;
    };

  describe('an owner or admin', () => {
    it('turns logging on: the accessLog block is written and the Server’s Traefik is restarted in the same request', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);

      const res = await toggle(cookie, true, edge.serverId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ written: true, restartRequired: false });
      expect(serverYml().accessLog?.filePath).toBe(
        '/etc/cloudgate/traefik/dynamic/access.log',
      );
      // What was there is still there.
      expect(serverYml().entryPoints).toBeDefined();
      await settle();
      expect(sentTo(edge.serverId)).toContain(RESTART);
      // The platform host was neither written nor restarted.
      expect(platformYml()).toBe(OLD_TRAEFIK_YML);
      expect(remoteExec.execAsync.mock.calls.map(([c]) => c)).not.toContain(
        RESTART,
      );

      const read = await request(httpServer)
        .get('/settings/traefik/requests')
        .query({ serverId: edge.serverId })
        .set('Cookie', cookie);
      expect(read.body).toEqual({ present: true, enabled: true });
    });

    it('turns logging off: the block goes and Traefik is restarted again', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);
      expect((await toggle(cookie, true, edge.serverId)).status).toBe(200);
      await settle();
      jest.clearAllMocks();

      const res = await toggle(cookie, false, edge.serverId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ written: true, restartRequired: false });
      expect(serverYml().accessLog).toBeUndefined();
      await settle();
      expect(sentTo(edge.serverId)).toContain(RESTART);
    });

    it('answers 502 when the Server’s Traefik does not restart, saying the file says on and Traefik is not recording', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);
      remoteExec.execAsyncRemote.mockImplementation((_id, command) =>
        command === RESTART
          ? Promise.reject(new Error('Cannot connect to the Docker daemon'))
          : answer(command),
      );

      const res = await toggle(cookie, true, edge.serverId);

      expect(res.status).toBe(502);
      expect((res.body as { message: string }).message).toBe(
        "Request logging is on in traefik.yml on edge, but Traefik did not restart, so it is still not recording requests. Try again, or restart Traefik from the Server's Traefik settings.",
      );
      // The write stands, and so does its audit row: both happened.
      expect(serverYml().accessLog).toBeDefined();
      expect(await loggingRows()).toHaveLength(1);
    });

    it('lets an admin do it too', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);
      const admin = await signUpMember(httpServer, cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });

      const res = await toggle(admin.cookie, true, edge.serverId);

      expect(res.status).toBe(200);
      expect(serverYml().accessLog).toBeDefined();
    });

    it('keeps only the User-Agent header in the written config', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);

      await toggle(cookie, true, edge.serverId);

      expect(serverYml().accessLog?.fields).toEqual({
        headers: { defaultMode: 'drop', names: { 'User-Agent': 'keep' } },
      });
    });

    it('leaves one `update server` audit row per flip, naming the Server and the change', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);

      await toggle(cookie, true, edge.serverId);
      await toggle(cookie, false, edge.serverId);

      const rows = await loggingRows();
      expect(rows).toHaveLength(2);
      const common = {
        organizationId,
        userEmail: owner.email,
        action: 'update',
        resourceType: 'server',
        resourceId: edge.serverId,
        resourceName: 'edge',
        outcome: 'succeeded',
      };
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ...common,
            metadata: JSON.stringify({
              route: ROUTE,
              change: 'Turn on request logging',
            }),
          }),
          expect.objectContaining({
            ...common,
            metadata: JSON.stringify({
              route: ROUTE,
              change: 'Turn off request logging',
            }),
          }),
        ]),
      );
    });

    it('answers 404 on a Server with no traefik.yml, and neither restarts nor audits', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);
      delete serverFiles[REMOTE_TRAEFIK_YML];

      const res = await toggle(cookie, true, edge.serverId);

      expect(res.status).toBe(404);
      await settle();
      expect(commands()).not.toContain(RESTART);
      expect(await loggingRows()).toEqual([]);
    });
  });

  describe('who is refused', () => {
    it('refuses a member who is not an owner or admin, and changes nothing', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);
      const member = await signUpMember(httpServer, cookie);

      const refused = await toggle(member.cookie, true, edge.serverId);
      const restart = await request(httpServer)
        .post('/settings/traefik/reload')
        .set('Cookie', member.cookie)
        .send({ serverId: edge.serverId });

      expect(refused.status).toBe(403);
      expect((refused.body as { message: string }).message).toBe(
        OWNER_OR_ADMIN_REFUSAL,
      );
      // The same gate as the restart it performs.
      expect({
        status: refused.status,
        message: (refused.body as { message: string }).message,
      }).toEqual({
        status: restart.status,
        message: (restart.body as { message: string }).message,
      });
      await settle();
      expect(serverFiles[REMOTE_TRAEFIK_YML]).toBe(OLD_TRAEFIK_YML);
      expect(commands()).not.toContain(RESTART);
      expect(await loggingRows()).toEqual([]);
    });

    it('gives the Instance organization no override on a customer’s Server', async () => {
      const { cookie } = await signUpOwner();
      const customer = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        cookie,
      );
      const theirs = await insertServer(customer.organizationId, 'customer');

      // The Instance organization's owner, acting in the Instance organization.
      const refused = await toggle(cookie, true, theirs.serverId);

      expect(refused.status).toBe(404);
      expect((refused.body as { message: string }).message).toBe(
        'Server not found',
      );
      await settle();
      expect(serverFiles[REMOTE_TRAEFIK_YML]).toBe(OLD_TRAEFIK_YML);
      expect(commands()).not.toContain(RESTART);
      expect(await loggingRows()).toEqual([]);

      // The customer's own owner may.
      const allowed = await toggle(customer.cookie, true, theirs.serverId);
      expect(allowed.status).toBe(200);
    });
  });

  describe('the platform host', () => {
    it('keeps its write-then-restart in two steps: written, restart owed, nothing restarted', async () => {
      const { cookie } = await signUpOwner();

      const res = await toggle(cookie, true);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ written: true, restartRequired: true });
      const { accessLog } = parse(platformYml()) as {
        accessLog: Record<string, unknown>;
      };
      expect(accessLog).toMatchObject({ format: 'json', bufferingSize: 100 });
      // Its headers are outside the Requests work.
      expect(accessLog.fields).toBeUndefined();
      await settle();
      expect(commands()).not.toContain(RESTART);
    });

    it('still refuses a member of any role without instance authority', async () => {
      const { cookie } = await signUpOwner();
      const member = await signUpMember(httpServer, cookie);
      const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);

      for (const caller of [member.cookie, mallory.cookie]) {
        expect((await toggle(caller, true)).status).toBe(403);
      }
      expect(platformYml()).toBe(OLD_TRAEFIK_YML);
    });
  });
});
