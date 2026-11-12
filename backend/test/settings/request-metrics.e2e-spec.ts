import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { carriesRequestMetrics } from '../../src/common/config/request-metrics';
import * as schema from '../../src/db/schema';
import { auditLog } from '../../src/enterprise/audit-logs/audit-log.schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RequestMetricsService } from '../../src/settings/request-metrics.service';
import { MAIN_TRAEFIK_DIR } from '../../src/settings/traefik-files.service';
import { withArgvExec } from '../utils/exec-double';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * **Enable request metrics** (ADR-0027): `POST /settings/traefik/request-metrics`
 * writes the loopback `metrics` entryPoint into one machine's traefik.yml and
 * requests a Traefik restart, behind the gate `POST /settings/traefik/reload`
 * takes, and the machine's read reports the state afterwards.
 *
 * The doubles are the two boundaries the route reaches: the exec layer (a
 * Server's traefik.yml is what its `cat` answers and its `base64 -d >` write
 * lands in; the restart is a command sent there) and `MAIN_TRAEFIK_DIR`, which
 * points the platform host's `fs` half at a temp dir. What is asserted is what
 * an operator observes: the response, the file, the read, the restart command
 * sent to the machine, and the audit row.
 */

const REMOTE_TRAEFIK_YML = `${REMOTE_CLOUDGATE_DIRECTORY}/traefik/traefik.yml`;
const OLD_TRAEFIK_YML =
  "entryPoints:\n  web:\n    address: ':80'\n  websecure:\n    address: ':443'\n";

/** `PermissionService.checkInstanceAuthority`'s refusal, written out. */
const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';
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

describe('Enable request metrics (e2e)', () => {
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
    traefikDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-rm-'));
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

  async function insertServer(organizationId: string) {
    const [row] = await ctx.db
      .insert(schema.server)
      .values({
        name: 'edge',
        ipAddress: '203.0.113.20',
        port: 22,
        organizationId,
      })
      .returning();
    return row;
  }

  const enable = (cookie: string, serverId?: string) =>
    request(httpServer)
      .post('/settings/traefik/request-metrics')
      .set('Cookie', cookie)
      .send(serverId ? { serverId } : {});

  const restart = (cookie: string, serverId?: string) =>
    request(httpServer)
      .post('/settings/traefik/reload')
      .set('Cookie', cookie)
      .send(serverId ? { serverId } : {});

  /** Every command sent to a machine, local and remote, in order. */
  const commands = () => [
    ...remoteExec.execAsync.mock.calls.map(([command]) => command),
    ...remoteExec.execAsyncRemote.mock.calls.map(([, command]) => command),
  ];

  /** The fire-and-forget restart has run by the next few ticks. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  const auditRows = () => ctx.db.select().from(auditLog);

  describe('on the platform host', () => {
    it('writes the loopback block, restarts Traefik, and the host read reports it enabled', async () => {
      const { cookie } = await signUpOwner();
      const before = await request(httpServer)
        .get('/settings/web-server')
        .set('Cookie', cookie);
      expect(
        (before.body as { requestMetricsEnabled: boolean })
          .requestMetricsEnabled,
      ).toBe(false);

      const res = await enable(cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: true });
      expect(carriesRequestMetrics(platformYml())).toBe(true);
      // What was there is still there.
      expect(platformYml()).toContain("address: ':443'");
      await settle();
      expect(commands()).toContain('docker restart cloudgate-traefik');

      const after = await request(httpServer)
        .get('/settings/web-server')
        .set('Cookie', cookie);
      expect(
        (after.body as { requestMetricsEnabled: boolean })
          .requestMetricsEnabled,
      ).toBe(true);
    });

    it('leaves one audit row naming the platform host, the change, the route and the actor', async () => {
      const { cookie, organizationId } = await signUpOwner();

      expect((await enable(cookie)).status).toBe(200);

      const rows = (await auditRows()).filter((row) =>
        row.metadata?.includes('/settings/traefik/request-metrics'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId,
        userEmail: owner.email,
        action: 'update',
        resourceType: 'server',
        resourceId: 'local',
        resourceName: 'platform host',
        outcome: 'succeeded',
        metadata: JSON.stringify({
          route: 'POST /settings/traefik/request-metrics',
          change: 'Enable request metrics',
        }),
      });
    });

    it('refuses exactly whom the Traefik restart refuses, and changes nothing', async () => {
      const { cookie } = await signUpOwner();
      const member = await signUpMember(httpServer, cookie);
      const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);

      for (const caller of [member.cookie, mallory.cookie]) {
        const refused = await enable(caller);
        const gate = await restart(caller);
        expect(refused.status).toBe(403);
        expect((refused.body as { message: string }).message).toBe(
          INSTANCE_AUTHORITY_REFUSAL,
        );
        // The same gate: whoever may not restart Traefik may not enable this.
        expect({
          status: refused.status,
          message: (refused.body as { message: string }).message,
        }).toEqual({
          status: gate.status,
          message: (gate.body as { message: string }).message,
        });
      }

      await settle();
      expect(platformYml()).toBe(OLD_TRAEFIK_YML);
      expect(commands()).not.toContain('docker restart cloudgate-traefik');
      const rows = (await auditRows()).filter((row) =>
        row.metadata?.includes('/settings/traefik/request-metrics'),
      );
      expect(rows).toEqual([]);
    });

    it('answers 404 on a host with no traefik.yml, and restarts nothing', async () => {
      const { cookie } = await signUpOwner();
      fs.rmSync(path.join(traefikDir, 'traefik.yml'));

      const res = await enable(cookie);

      expect(res.status).toBe(404);
      await settle();
      expect(commands()).not.toContain('docker restart cloudgate-traefik');
    });
  });

  describe('on a Server', () => {
    it('writes the Server’s traefik.yml, restarts its Traefik, and the Server read reports it enabled', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);
      const before = await request(httpServer)
        .get(`/servers/${edge.serverId}`)
        .set('Cookie', cookie);
      expect(
        (before.body as { requestMetricsEnabled: boolean })
          .requestMetricsEnabled,
      ).toBe(false);

      const res = await enable(cookie, edge.serverId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: true });
      expect(carriesRequestMetrics(serverFiles[REMOTE_TRAEFIK_YML])).toBe(true);
      // The platform host's file is not the Server's.
      expect(platformYml()).toBe(OLD_TRAEFIK_YML);
      await settle();
      const sentToServer = remoteExec.execAsyncRemote.mock.calls
        .filter(([id]) => id === edge.serverId)
        .map(([, command]) => command);
      expect(sentToServer).toContain('docker restart cloudgate-traefik');
      expect(remoteExec.execAsync.mock.calls.map(([c]) => c)).not.toContain(
        'docker restart cloudgate-traefik',
      );

      const after = await request(httpServer)
        .get(`/servers/${edge.serverId}`)
        .set('Cookie', cookie);
      expect(
        (after.body as { requestMetricsEnabled: boolean })
          .requestMetricsEnabled,
      ).toBe(true);
      // The collection job's question gets the same answer.
      await expect(
        ctx.app.get(RequestMetricsService).isEnabled(edge.serverId),
      ).resolves.toBe(true);

      // US77: the trail says which Server, and what was done to it.
      const rows = (await auditRows()).filter((row) =>
        row.metadata?.includes('/settings/traefik/request-metrics'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId,
        userEmail: owner.email,
        action: 'update',
        resourceType: 'server',
        resourceId: edge.serverId,
        resourceName: 'edge',
        outcome: 'succeeded',
        metadata: JSON.stringify({
          route: 'POST /settings/traefik/request-metrics',
          change: 'Enable request metrics',
        }),
      });
    });

    it('refuses a member the Traefik restart refuses, and changes nothing', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);
      const member = await signUpMember(httpServer, cookie);

      const refused = await enable(member.cookie, edge.serverId);
      const gate = await restart(member.cookie, edge.serverId);

      expect(refused.status).toBe(403);
      expect((refused.body as { message: string }).message).toBe(
        OWNER_OR_ADMIN_REFUSAL,
      );
      expect((gate.body as { message: string }).message).toBe(
        OWNER_OR_ADMIN_REFUSAL,
      );
      await settle();
      expect(serverFiles[REMOTE_TRAEFIK_YML]).toBe(OLD_TRAEFIK_YML);
      expect(commands()).not.toContain('docker restart cloudgate-traefik');
      const [row] = await ctx.db
        .select({ enabled: schema.server.requestMetricsEnabled })
        .from(schema.server)
        .where(eq(schema.server.serverId, edge.serverId));
      expect(row.enabled).toBe(false);
    });

    it('refuses another organization’s Server as the restart does', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const edge = await insertServer(organizationId);
      const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);

      const refused = await enable(mallory.cookie, edge.serverId);
      const gate = await restart(mallory.cookie, edge.serverId);

      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect({
        status: refused.status,
        message: (refused.body as { message: string }).message,
      }).toEqual({
        status: gate.status,
        message: (gate.body as { message: string }).message,
      });
      expect(serverFiles[REMOTE_TRAEFIK_YML]).toBe(OLD_TRAEFIK_YML);
    });
  });
});
