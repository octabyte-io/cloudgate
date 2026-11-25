import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ComposeService } from '../../src/compose/compose.service';
import { deployment } from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const REPOSITORY_FILE = `services:
  web:
    image: nginx:1
`;

/**
 * ADR-0091: a Compose Service that names no file finds it in each deploy's
 * clone, by Docker's order. Only the machine is replaced: the double answers
 * the lookup with the names {@link inClone} holds and the `cat` of the file
 * with {@link REPOSITORY_FILE}; the real `deployCompose` runs.
 */
describe('A Compose Service with no file named (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let composeService: ComposeService;
  let engine: DeploymentEngineService;
  let cookie: string;

  /** The compose names the clone holds, as the lookup lists them. */
  let inClone: string[] = [];
  const commands: string[] = [];
  const isLookup = (command: string) =>
    command.includes('for f in compose.yaml compose.yml');
  const answer = (command: string) => {
    commands.push(command);
    if (isLookup(command)) {
      return Promise.resolve({
        stdout: inClone.map((name) => `${name}\n`).join(''),
        stderr: '',
        exitCode: 0,
      });
    }
    if (command.startsWith('cat ')) {
      return Promise.resolve({
        stdout: REPOSITORY_FILE,
        stderr: '',
        exitCode: 0,
      });
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
    composeService = ctx.app.get(ComposeService);
    engine = ctx.app.get(DeploymentEngineService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    inClone = [];
    commands.length = 0;
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

  /** A Compose from a git repository, with `composePath` as given. */
  async function repositoryCompose(
    composePath: string | null,
  ): Promise<{ composeId: string; appName: string }> {
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
      });
    expect(created.status).toBe(201);
    const { composeId, appName } = created.body as {
      composeId: string;
      appName: string;
    };
    const git = await request(httpServer)
      .patch(`/compose/${composeId}`)
      .set('Cookie', cookie)
      .send({
        sourceType: 'git',
        customGitUrl: 'https://example.invalid/orders.git',
        customGitBranch: 'main',
        composePath,
      });
    expect(git.status).toBe(200);
    return { composeId, appName };
  }

  async function deploy(composeId: string): Promise<void> {
    await engine.deployCompose(await composeService.findDeployable(composeId), {
      title: 'Manual deployment',
      description: '',
    });
  }

  async function deploymentStatus(composeId: string) {
    const [row] = await ctx.db
      .select({ status: deployment.status })
      .from(deployment)
      .where(eq(deployment.composeId, composeId));
    return row?.status;
  }

  it('keeps a cleared file as null', async () => {
    const { composeId } = await repositoryCompose(null);

    const read = await request(httpServer)
      .get(`/compose/${composeId}`)
      .set('Cookie', cookie);

    expect(read.status).toBe(200);
    expect((read.body as { composePath: string | null }).composePath).toBe(
      null,
    );
  });

  it('deploys a repository holding only compose.yaml, and logs the file it used', async () => {
    const { composeId, appName } = await repositoryCompose(null);
    inClone = ['compose.yaml'];

    await deploy(composeId);

    expect(await deploymentStatus(composeId)).toBe('done');
    expect(
      commands.some(
        (command) =>
          command.startsWith('cat ') &&
          command.endsWith(`/${appName}/code/compose.yaml`),
      ),
    ).toBe(true);
    const build = commands.find((command) =>
      command.includes('Docker Compose Deployed'),
    );
    expect(build).toContain(`-f ./compose.yaml up -d`);
    expect(
      commands.some((command) =>
        command.includes('No compose file named: using compose.yaml'),
      ),
    ).toBe(true);
  });

  it('deploys the first in Docker’s order when several are present, naming the others', async () => {
    const { composeId, appName } = await repositoryCompose(null);
    inClone = ['docker-compose.yml', 'compose.yml'];

    await deploy(composeId);

    expect(await deploymentStatus(composeId)).toBe('done');
    expect(
      commands.some((command) =>
        command.endsWith(`/${appName}/code/compose.yml`),
      ),
    ).toBe(true);
    expect(
      commands.some((command) =>
        command.includes(
          'No compose file named: using compose.yml (also present, not used: docker-compose.yml)',
        ),
      ),
    ).toBe(true);
  });

  it('refuses the deploy naming all four when the clone holds none', async () => {
    const { composeId } = await repositoryCompose(null);
    inClone = [];

    await expect(deploy(composeId)).rejects.toThrow(
      'No compose file named, and none found: looked for compose.yaml, compose.yml, docker-compose.yaml and docker-compose.yml',
    );

    expect(await deploymentStatus(composeId)).toBe('error');
    expect(commands.some((command) => command.startsWith('cat '))).toBe(false);
    expect(
      commands.some((command) => command.includes('Docker Compose Deployed')),
    ).toBe(false);
  });

  it('deploys exactly a named file, with no lookup', async () => {
    const { composeId, appName } =
      await repositoryCompose('./deploy/stack.yml');
    inClone = ['compose.yaml'];

    await deploy(composeId);

    expect(await deploymentStatus(composeId)).toBe('done');
    expect(commands.some(isLookup)).toBe(false);
    expect(
      commands.some((command) =>
        command.endsWith(`/${appName}/code/deploy/stack.yml`),
      ),
    ).toBe(true);
  });
});
