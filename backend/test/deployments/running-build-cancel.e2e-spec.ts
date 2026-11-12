import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application as applicationTable,
  deployment as deploymentTable,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import type { ExecOptions } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * End to end on real processes: a build hung on a `git clone` is
 * cancelled through `POST /deployments/:id/cancel`.
 *
 * Real here: the in-memory queue and its one-build-at-a-time partition, the
 * deployment engine, `DeploymentsService`, and — for every command that
 * touches this suite's platform root — `RemoteExecService` itself, so the build
 * program is a real `/bin/sh` running a real `git clone`. The clone is hung the
 * way U04 hung it, minus the 133 s kernel timeout: the "remote" is a local TCP
 * listener that accepts and never answers, which git waits on for ever.
 * Commands that touch nothing under the root (none are expected) are answered
 * with an empty success rather than run on this machine.
 */
describe('Running build cancel (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;

  const root = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-cancel-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  /** Accepts every connection and says nothing. */
  const connections: net.Socket[] = [];
  const stall = net.createServer((socket) => {
    connections.push(socket);
  });
  let hangUrl: (name: string) => string;

  const real = new RemoteExecService();
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const touchesRoot = (command: string | string[]) =>
    [command].flat().some((word) => word.includes(root));
  const execDouble = {
    execAsync: jest.fn((command: string, options?: ExecOptions) =>
      touchesRoot(command)
        ? real.execAsync(command, options)
        : Promise.resolve(ok),
    ),
    execFileAsync: jest.fn((command: string, args: string[]) =>
      touchesRoot([command, ...args])
        ? real.execFileAsync(command, args)
        : Promise.resolve(ok),
    ),
    execAsyncRemote: jest.fn(() => Promise.resolve(ok)),
    execRemote: jest.fn(() => Promise.resolve(ok)),
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => stall.listen(0, '127.0.0.1', resolve));
    const { port } = stall.address() as net.AddressInfo;
    hangUrl = (name) => `http://127.0.0.1:${port}/x/${name}.git`;

    process.env.CLOUDGATE_DIRECTORY = root;
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execDouble }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
  });

  afterAll(async () => {
    // Nothing this suite started may outlive it, whatever failed.
    for (const pid of gitProcesses('')) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // already gone
      }
    }
    connections.forEach((socket) => socket.destroy());
    await new Promise((resolve) => stall.close(resolve));
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Pids of live `git` processes cloning from the stall listener's `needle` path. */
  function gitProcesses(needle: string): string[] {
    const { port } = stall.address() as net.AddressInfo;
    try {
      // `git` and `git-remote-http`, by argv[0] — not the `/bin/sh -c` whose
      // program text also names the URL.
      const pattern = `(^|/)git(-remote-https?)? .*:${port}/x/${needle}`;
      return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      return []; // pgrep exits 1 when nothing matches
    }
  }

  async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return check();
  }

  const statusOf = async (deploymentId: string) => {
    const [row] = await ctx.db
      .select()
      .from(deploymentTable)
      .where(eq(deploymentTable.deploymentId, deploymentId));
    return row;
  };

  /** Two git-sourced Applications on the platform host, and their owner. */
  async function setUp() {
    const signUp = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers['set-cookie'];
    const userId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const make = async (appName: string) => {
      const created = await applications.create(ownerCtx, {
        name: appName,
        appName,
        environmentId: environment.environmentId,
      });
      await ctx.db
        .update(applicationTable)
        .set({
          sourceType: 'git',
          customGitUrl: hangUrl(appName),
          customGitBranch: 'main',
        })
        .where(eq(applicationTable.applicationId, created.applicationId));
      return created.applicationId;
    };
    return {
      cookie,
      hung: await make('hung-app'),
      next: await make('next-app'),
    };
  }

  const deploy = async (cookie: string, applicationId: string) => {
    const res = await request(server)
      .post(`/applications/${applicationId}/deployments`)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(201);
    return (res.body as { deploymentId: string }).deploymentId;
  };

  it('kills a build hung on its clone, leaves it cancelled, and starts the next build on the Server', async () => {
    const { cookie, hung, next } = await setUp();

    const hungDeployment = await deploy(cookie, hung);
    // Running, and genuinely hung: git has connected and is waiting.
    expect(await until(() => gitProcesses('hung-app').length > 0)).toBe(true);
    expect((await statusOf(hungDeployment)).status).toBe('running');

    // One build at a time on a Server without a license: this one waits.
    const nextDeployment = await deploy(cookie, next);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await statusOf(nextDeployment)).status).toBe('pending');

    const res = await request(server)
      .post(`/deployments/${hungDeployment}/cancel`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deploymentId: hungDeployment,
      status: 'cancelled',
    });

    // The clone is gone — the whole process group, not just its shell.
    expect(await until(() => gitProcesses('hung-app').length === 0, 5000)).toBe(
      true,
    );
    // The slot freed: the queued build started, and is now the hung one.
    expect(
      await until(
        async () => (await statusOf(nextDeployment)).status === 'running',
      ),
    ).toBe(true);
    expect(await until(() => gitProcesses('next-app').length > 0)).toBe(true);

    // The dying pipeline wrote no status over the cancel: by the time the
    // next build started, the engine had finished with this one.
    const cancelled = await statusOf(hungDeployment);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).toBeTruthy();
    const log = fs.readFileSync(cancelled.logPath, 'utf8');
    expect(log).toContain('Cancelled: this build was stopped while it ran');
    expect(log).not.toContain('Error occurred');

    // And the second one cancels the same way, which also cleans up.
    const second = await request(server)
      .post(`/deployments/${nextDeployment}/cancel`)
      .set('Cookie', cookie);
    expect(second.status).toBe(200);
    expect(await until(() => gitProcesses('next-app').length === 0, 5000)).toBe(
      true,
    );
    expect((await statusOf(nextDeployment)).status).toBe('cancelled');
  });
});
