import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';

import { server } from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { LogCleanupService } from '../../src/settings/log-cleanup.service';
import {
  SERVER_ACCESS_LOG_UPKEEP_JOB,
  ServerAccessLogUpkeepService,
} from '../../src/settings/server-access-log-upkeep.service';
import {
  ACCESS_LOG_MAX_BYTES,
  MAIN_TRAEFIK_DIR,
} from '../../src/settings/traefik-files.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * A Server's access log stays bounded on the customer's disk whatever the
 * instance operator does (ADR-0057), observed on the files themselves.
 *
 * The one double is the Server's SSH (`RemoteExecService`). Each Server's
 * "machine" is a temp tree `MAIN_TRAEFIK_DIR` points it at; every file program
 * the job sends runs for real in /bin/sh against that tree, and only Docker is
 * answered by the double. The job's tick is called directly, as the
 * Error-rate suite calls its collector's tick.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const LOG_ON =
  'accessLog:\n  filePath: /etc/cloudgate/traefik/dynamic/access.log\n  format: json\n';
const LOG_OFF = "entryPoints:\n  web:\n    address: ':80'\n";
const DAY_MS = 24 * 60 * 60 * 1000;

describe('Server access-log upkeep (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let upkeep: ServerAccessLogUpkeepService;
  let hostDir: string;
  /** Each Server's Traefik root, by Server id. */
  const serverDirs = new Map<string, string>();

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  /** What a Server answers: its tree for file programs, a Traefik for Docker. */
  function onServer(serverId: string, command: string): Promise<ExecResult> {
    if (command.includes('docker ps')) {
      return Promise.resolve(ok(`${serverId}-traefik\n`));
    }
    const dir = serverDirs.get(serverId);
    if (dir && command.includes(dir)) {
      return Promise.resolve(
        ok(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })),
      );
    }
    return Promise.resolve(ok(''));
  }

  beforeAll(async () => {
    hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-1279-host-'));
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: MAIN_TRAEFIK_DIR,
          useValue: (serverId?: string | null) =>
            serverId ? (serverDirs.get(serverId) ?? '/nonexistent') : hostDir,
        },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    upkeep = ctx.app.get(ServerAccessLogUpkeepService);
  });

  afterAll(async () => {
    await ctx.teardown();
    fs.rmSync(hostDir, { recursive: true, force: true });
  });

  let ownerCookie: string;
  let organizationId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    for (const dir of serverDirs.values()) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    serverDirs.clear();
    execMock.execAsync.mockReset().mockResolvedValue(ok(''));
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((serverId, command) => onServer(serverId, command));

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(httpServer)
      .get('/organizations/active')
      .set('Cookie', ownerCookie);
    organizationId = (orgs.body as { id: string }).id;
  });

  /** A Server whose Traefik root is a fresh temp tree with that traefik.yml. */
  async function addServer(name: string, traefikYml: string) {
    const [row] = await ctx.db
      .insert(server)
      .values({ name, ipAddress: '203.0.113.20', port: 22, organizationId })
      .returning();
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), `cloudgate-1279-${name}-`),
    );
    fs.mkdirSync(path.join(dir, 'dynamic'));
    fs.writeFileSync(path.join(dir, 'traefik.yml'), traefikYml);
    serverDirs.set(row.serverId, dir);
    return {
      serverId: row.serverId,
      log: path.join(dir, 'dynamic', 'access.log'),
    };
  }

  /** Writes `file` with `content`, last changed `days` ago. */
  function writeAged(file: string, content: string, days = 0): void {
    fs.writeFileSync(file, content);
    const at = new Date(Date.now() - days * DAY_MS);
    fs.utimesSync(file, at, at);
  }

  const signalled = (serverId: string) =>
    execMock.execAsyncRemote.mock.calls.some(
      ([id, command]) =>
        id === serverId &&
        command === `docker exec ${serverId}-traefik kill -USR1 1`,
    );

  it('rotates a log past 100 MiB, keeps 3 older files and has that Server’s Traefik reopen it', async () => {
    const edge = await addServer('edge', LOG_ON);
    writeAged(edge.log, 'x'.repeat(ACCESS_LOG_MAX_BYTES + 1));
    writeAged(`${edge.log}.1`, 'generation 1', 1);
    writeAged(`${edge.log}.2`, 'generation 2', 2);
    writeAged(`${edge.log}.3`, 'generation 3', 3);

    await upkeep.tick();

    expect(fs.existsSync(edge.log)).toBe(false);
    expect(fs.statSync(`${edge.log}.1`).size).toBe(ACCESS_LOG_MAX_BYTES + 1);
    expect(fs.readFileSync(`${edge.log}.2`, 'utf8')).toBe('generation 1');
    expect(fs.readFileSync(`${edge.log}.3`, 'utf8')).toBe('generation 2');
    expect(fs.existsSync(`${edge.log}.4`)).toBe(false);
    expect(signalled(edge.serverId)).toBe(true);
  });

  it('leaves a log under 100 MiB where it is', async () => {
    const edge = await addServer('edge', LOG_ON);
    writeAged(edge.log, '{}\n');

    await upkeep.tick();

    expect(fs.readFileSync(edge.log, 'utf8')).toBe('{}\n');
    expect(fs.existsSync(`${edge.log}.1`)).toBe(false);
    expect(signalled(edge.serverId)).toBe(false);
  });

  it('deletes older files last changed more than 30 days ago and never the live file', async () => {
    const edge = await addServer('edge', LOG_ON);
    writeAged(edge.log, '{}\n', 400);
    writeAged(`${edge.log}.1`, 'recent', 5);
    writeAged(`${edge.log}.2`, 'stale', 31);
    writeAged(`${edge.log}.3`, 'ancient', 90);

    await upkeep.tick();

    expect(fs.readFileSync(edge.log, 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(`${edge.log}.1`, 'utf8')).toBe('recent');
    expect(fs.existsSync(`${edge.log}.2`)).toBe(false);
    expect(fs.existsSync(`${edge.log}.3`)).toBe(false);
  });

  it('runs with the Maintenance switch off', async () => {
    const stop = await request(httpServer)
      .post('/settings/log-cleanup')
      .set('Cookie', ownerCookie)
      .send({ cronExpression: null });
    expect(stop.status).toBe(200);
    const scheduling = ctx.app.get(SchedulingService);
    expect(scheduling.has('access-log-cleanup')).toBe(false);
    expect(scheduling.has(SERVER_ACCESS_LOG_UPKEEP_JOB)).toBe(true);
    expect(
      scheduling.get(SERVER_ACCESS_LOG_UPKEEP_JOB)?.cronExpression,
    ).toMatch(/^\d+ \* \* \* \*$/);

    const edge = await addServer('edge', LOG_ON);
    writeAged(edge.log, 'x'.repeat(ACCESS_LOG_MAX_BYTES + 1));
    writeAged(`${edge.log}.2`, 'stale', 40);

    await upkeep.tick();

    expect(fs.statSync(`${edge.log}.1`).size).toBe(ACCESS_LOG_MAX_BYTES + 1);
    expect(fs.existsSync(`${edge.log}.3`)).toBe(false);
  });

  it('clears the older files of a Server that turned logging off, and does not rotate it', async () => {
    const quiet = await addServer('quiet', LOG_OFF);
    // Over the limit, to show the gate on rotation is the setting, not size.
    writeAged(quiet.log, 'x'.repeat(ACCESS_LOG_MAX_BYTES + 1), 40);
    writeAged(`${quiet.log}.1`, 'stale', 35);
    writeAged(`${quiet.log}.2`, 'recent', 10);

    await upkeep.tick();
    expect(fs.existsSync(`${quiet.log}.1`)).toBe(false);
    expect(fs.readFileSync(`${quiet.log}.2`, 'utf8')).toBe('recent');
    expect(fs.statSync(quiet.log).size).toBe(ACCESS_LOG_MAX_BYTES + 1);
    expect(signalled(quiet.serverId)).toBe(false);

    // Until none are left: the next tick past 30 days takes the last one.
    writeAged(`${quiet.log}.2`, 'recent', 31);
    await upkeep.tick();
    expect(fs.existsSync(`${quiet.log}.2`)).toBe(false);
    expect(fs.existsSync(quiet.log)).toBe(true);
  });

  it('leaves the Servers alone when the platform host’s cleanup runs', async () => {
    const edge = await addServer('edge', LOG_ON);
    writeAged(edge.log, 'x'.repeat(ACCESS_LOG_MAX_BYTES + 1));
    writeAged(`${edge.log}.1`, 'stale', 40);
    fs.mkdirSync(path.join(hostDir, 'dynamic'), { recursive: true });
    const hostLog = path.join(hostDir, 'dynamic', 'access.log');
    fs.writeFileSync(hostLog, 'x'.repeat(ACCESS_LOG_MAX_BYTES + 1));
    execMock.execAsync.mockImplementation((command) =>
      Promise.resolve(
        ok(command.includes('docker ps') ? 'host-traefik\n' : ''),
      ),
    );

    await ctx.app.get(LogCleanupService).runCleanup();

    expect(fs.existsSync(`${hostLog}.1`)).toBe(true);
    expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    expect(fs.statSync(edge.log).size).toBe(ACCESS_LOG_MAX_BYTES + 1);
    expect(fs.readFileSync(`${edge.log}.1`, 'utf8')).toBe('stale');
    fs.rmSync(path.join(hostDir, 'dynamic'), { recursive: true, force: true });
  });
});
