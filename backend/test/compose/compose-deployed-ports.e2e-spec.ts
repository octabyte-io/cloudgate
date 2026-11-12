import request from 'supertest';
import { App } from 'supertest/types';

import { ComposeService } from '../../src/compose/compose.service';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { COMPOSE_FROM_REPOSITORY_REASON } from '../../src/service-health/published-ports';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** What the repository's file says; the `compose_file` column never does. */
const REPOSITORY_FILE = `services:
  db:
    image: postgres:17
    ports:
      - "5432:5432"
  web:
    image: nginx:1
`;
const WITHOUT_THE_PORT = `services:
  db:
    image: postgres:17
  web:
    image: nginx:1
`;

interface PublishedPorts {
  ports: { port: number; label: string }[];
  unavailableReason: string | null;
}

/**
 * A Compose deployed from a repository gets its published ports from the
 * file its last successful deploy read: the picker, `ownPort` and the
 * probe tick all read that record through `publishedPortsOf`.
 *
 * Only the machine is replaced: `RemoteExecService` answers the deploy's `cat`
 * of the cloned file with {@link repositoryFile} — the only place a
 * repository's file is ever visible — and fails the build step when
 * {@link buildFails} is set. The real `DeploymentEngineService.deployCompose`
 * runs, claim check and all.
 */
describe('A repository Compose’s published ports (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let compose: ComposeService;
  let engine: DeploymentEngineService;
  let cookie: string;

  let repositoryFile = REPOSITORY_FILE;
  let buildFails = false;
  const answer = (command: string) => {
    if (command.startsWith('cat ')) {
      return Promise.resolve({
        stdout: repositoryFile,
        stderr: '',
        exitCode: 0,
      });
    }
    if (buildFails && command.includes('Docker command failed')) {
      return Promise.reject(new Error('build failed'));
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  };
  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    compose = ctx.app.get(ComposeService);
    engine = ctx.app.get(DeploymentEngineService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    repositoryFile = REPOSITORY_FILE;
    buildFails = false;
    execMock.execAsync
      .mockReset()
      .mockImplementation((command: string) => answer(command));
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        answer(command),
      );
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  });

  /** A Compose from a git repository, whose column holds a decoy file. */
  async function repositoryCompose(): Promise<string> {
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'stack' });
    expect(project.status).toBe(201);
    const env = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(env.status).toBe(201);
    const created = await request(httpServer)
      .post('/compose')
      .set('Cookie', cookie)
      .send({
        name: 'orders',
        environmentId: (env.body as { environmentId: string }).environmentId,
        // Not what a repository Compose deploys, so never what it publishes.
        composeFile: [
          'services:',
          '  cache:',
          '    image: redis:7',
          '    ports:',
          '      - "6380:6379"',
        ].join('\n'),
      });
    expect(created.status).toBe(201);
    const composeId = (created.body as { composeId: string }).composeId;
    const git = await request(httpServer)
      .patch(`/compose/${composeId}`)
      .set('Cookie', cookie)
      .send({
        sourceType: 'git',
        customGitUrl: 'https://example.invalid/orders.git',
        customGitBranch: 'main',
      });
    expect(git.status).toBe(200);
    return composeId;
  }

  async function deploy(composeId: string): Promise<void> {
    await engine.deployCompose(await compose.findDeployable(composeId), {
      title: 'Manual deployment',
      description: '',
    });
  }

  async function publishedPorts(composeId: string): Promise<PublishedPorts> {
    const res = await request(httpServer)
      .get('/uptime-checks/published-ports')
      .query({ serviceType: 'compose', serviceId: composeId })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as PublishedPorts;
  }

  function addTcpCheck(composeId: string, port: number) {
    return request(httpServer)
      .post('/uptime-checks')
      .set('Cookie', cookie)
      .send({
        serviceType: 'compose',
        serviceId: composeId,
        kind: 'tcp',
        port,
        intervalSeconds: 30,
        timeoutSeconds: 2,
      });
  }

  it('says to deploy it first, and refuses a TCP check with that, before its first deploy', async () => {
    const composeId = await repositoryCompose();

    const answered = await publishedPorts(composeId);
    const refused = await addTcpCheck(composeId, 5432);

    expect(answered.ports).toEqual([]);
    expect(answered.unavailableReason).toBe(COMPOSE_FROM_REPOSITORY_REASON);
    expect(answered.unavailableReason).toContain('Deploy it first');
    // It never claims the repository's file publishes nothing.
    expect(answered.unavailableReason).not.toContain('publishes no');
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toBe(
      COMPOSE_FROM_REPOSITORY_REASON,
    );
  });

  it('lists the port a successful deploy’s file published, with its service → target label, and admits a TCP check on it', async () => {
    const composeId = await repositoryCompose();

    await deploy(composeId);

    expect(await publishedPorts(composeId)).toMatchObject({
      ports: [{ port: 5432, label: 'db → 5432' }],
      unavailableReason: null,
    });
    // The column's decoy port was never read.
    expect((await addTcpCheck(composeId, 6380)).status).toBe(400);
    expect((await addTcpCheck(composeId, 5432)).status).toBe(201);
  });

  it('drops a port a later successful deploy’s file no longer publishes, and a failed deploy changes nothing', async () => {
    const composeId = await repositoryCompose();
    await deploy(composeId);

    repositoryFile = WITHOUT_THE_PORT;
    buildFails = true;
    await expect(deploy(composeId)).rejects.toThrow('build failed');
    // The failed deploy ran nothing new, so the record still stands.
    expect((await publishedPorts(composeId)).ports).toEqual([
      { port: 5432, label: 'db → 5432' },
    ]);

    buildFails = false;
    await deploy(composeId);
    const after = await publishedPorts(composeId);
    expect(after.ports).toEqual([]);
    // Deployed, and its file publishes no fixed TCP port: the Compose words.
    expect(after.unavailableReason).toContain(
      'This Compose file publishes no fixed TCP port',
    );
  });

  it('never shows the other source’s ports across a switch between raw and a repository', async () => {
    const composeId = await repositoryCompose();
    await deploy(composeId);

    const raw = await request(httpServer)
      .patch(`/compose/${composeId}`)
      .set('Cookie', cookie)
      .send({ sourceType: 'raw' });
    expect(raw.status).toBe(200);
    // Raw reads the column, as it always has.
    expect((await publishedPorts(composeId)).ports).toEqual([
      { port: 6380, label: 'cache → 6379' },
    ]);

    // A raw deploy is what runs now, so the repository record goes with it.
    await deploy(composeId);
    const git = await request(httpServer)
      .patch(`/compose/${composeId}`)
      .set('Cookie', cookie)
      .send({ sourceType: 'git' });
    expect(git.status).toBe(200);
    expect(await publishedPorts(composeId)).toMatchObject({
      ports: [],
      unavailableReason: COMPOSE_FROM_REPOSITORY_REASON,
    });
  });
});
