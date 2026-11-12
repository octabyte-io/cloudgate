import { eq, sql } from 'drizzle-orm';
import { parse } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  aiModelFacet,
  application,
  auditLog,
  deployment,
  server as serverTable,
  webServerSettings,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { ExecError } from '../../src/remote/exec-error';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Creating an AI model on Ollama over REST (spec slice 2): the
 * facet `POST /applications` takes and nothing else does, what a deploy emits
 * and asks the machine, the `cloudgate-ai` join on a Server, the upstream
 * secret no response carries, and the audit rows — observed where an
 * operator observes them: responses, rows, the Swarm spec the deploy emits
 * and the commands issued to the machine.
 *
 * `RemoteExecService` records every command and answers the model pull from
 * {@link pullAnswer}; `RemoteDockerFactory` records the emitted Swarm spec.
 * The routes and the deployment engine run for real.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The platform's tested Ollama pin, spelled out rather than imported (§1.7). */
const PINNED_IMAGE = 'ollama/ollama:0.12.6';
const OLLAMA = { runtime: 'ollama', model: 'smollm2:135m' };

type ExecOptions = { env?: Record<string, string | undefined> };

describe('AI model on Ollama (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  /** What the model pull answers: success unless a test scripts a failure. */
  let pullAnswer: (command: string) => Promise<ExecResult>;
  const machine = (command: string): Promise<ExecResult> => {
    if (command.includes('ollama pull')) return pullAnswer(command);
    return Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, ExecOptions?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  let ownerCookie: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    pullAnswer = () => Promise.resolve(ok());
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks
      .mockReset()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-10-16T00:00:00Z' } },
      ]);
    queueMock.add.mockReset().mockResolvedValue(undefined);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', ownerCookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', ownerCookie)
      .send({ name: 'support' });
    projectId = (project.body as { projectId: string }).projectId;
    const environment = await request(httpServer)
      .post('/environments')
      .set('Cookie', ownerCookie)
      .send({ name: 'production', projectId });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;
  });

  function create(body: Record<string, unknown>) {
    return request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({ environmentId, ...body });
  }

  async function createAiModel(
    appName = 'llm',
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await create({
      name: appName,
      appName,
      aiModel: OLLAMA,
      ...extra,
    });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  function patch(applicationId: string, body: Record<string, unknown>) {
    return request(httpServer)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', ownerCookie)
      .send(body);
  }

  /** Deploys through the real engine, as the queue processor would. */
  async function deploy(applicationId: string): Promise<void> {
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(applicationId);
    await ctx.app.get(DeploymentEngineService).deploy(deployable);
  }

  interface EmittedSpec {
    TaskTemplate: {
      ContainerSpec: {
        Image: string;
        Env: string[];
        Command?: string[];
        Args?: string[];
        HealthCheck?: { Test?: string[] };
      };
      Networks: { Target: string }[];
    };
  }

  function emittedSpec(): EmittedSpec {
    const call = docker.createService.mock.lastCall as unknown[];
    return call[call.length - 1] as EmittedSpec;
  }

  /** Every command the platform host was asked. */
  const executed = (): string[] =>
    execMock.execAsync.mock.calls.map(([command]) => command);

  /** Every line the deploy wrote into the Deployment log, decoded. */
  const logged = (): string =>
    executed()
      .flatMap((command) =>
        [...command.matchAll(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/g)].map(
          (match) => Buffer.from(match[1], 'base64').toString('utf8'),
        ),
      )
      .join('');

  const pulls = () => executed().filter((c) => c.includes('ollama pull'));

  /** The model a pull command names, its shell quoting undone. */
  const pulledModel = (command: string): unknown =>
    parse(/ollama pull (\S+)/.exec(command)?.[1] ?? '')[0];

  async function storedSecret(applicationId: string) {
    const [row] = await ctx.db
      .select({ upstreamSecret: aiModelFacet.upstreamSecret })
      .from(aiModelFacet)
      .where(eq(aiModelFacet.applicationId, applicationId));
    return row?.upstreamSecret;
  }

  describe('create', () => {
    it('creates an AI model whose image, command, port and health check the platform writes', async () => {
      const res = await create({
        name: 'llm',
        appName: 'llm',
        aiModel: OLLAMA,
      });

      expect(res.status).toBe(201);
      expect((res.body as { aiModel: unknown }).aiModel).toEqual({
        runtime: 'ollama',
        model: 'smollm2:135m',
        imageTag: '0.12.6',
        pin: '0.12.6',
        offPin: false,
        hasHfToken: false,
      });
      const [row] = await ctx.db
        .select()
        .from(application)
        .where(
          eq(
            application.applicationId,
            (res.body as { applicationId: string }).applicationId,
          ),
        );
      expect(row).toMatchObject({
        sourceType: 'docker',
        dockerImage: PINNED_IMAGE,
        command: '/bin/ollama',
        args: ['serve'],
        port: 11434,
        healthCheckSwarm: { Test: ['CMD', '/bin/ollama', 'list'] },
      });
    });

    it('stores the upstream secret encrypted, and no response carries it or says it exists', async () => {
      const created = await create({
        name: 'llm',
        appName: 'llm',
        aiModel: OLLAMA,
      });
      const { applicationId } = created.body as { applicationId: string };

      const secret = await storedSecret(applicationId);
      expect(secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      const raw = await ctx.db.execute<{ upstream_secret: string }>(
        sql`SELECT upstream_secret FROM ai_model WHERE application_id = ${applicationId}`,
      );
      expect(raw.rows[0].upstream_secret).not.toContain(secret);
      expect(raw.rows[0].upstream_secret).toMatch(/^enc:/);

      // The endpoint is built on the platform host URL.
      await ctx.db
        .insert(webServerSettings)
        .values({ host: 'cloud.example.com', https: true });
      const read = await request(httpServer)
        .get(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);
      expect(read.status).toBe(200);
      expect((read.body as { aiModel: unknown }).aiModel).toEqual({
        runtime: 'ollama',
        model: 'smollm2:135m',
        imageTag: '0.12.6',
        pin: '0.12.6',
        offPin: false,
        hasHfToken: false,
        endpoint: `https://cloud.example.com/ai/${applicationId}/v1`,
      });
      const edited = await patch(applicationId, {
        aiModel: { model: 'all-minilm' },
      });
      for (const body of [created.body, read.body, edited.body]) {
        const text = JSON.stringify(body);
        expect(text).not.toContain(secret);
        expect(text.toLowerCase()).not.toContain('upstream');
      }
    });

    it('takes an image tag off the pin and says so', async () => {
      const res = await create({
        name: 'llm',
        appName: 'llm',
        aiModel: { ...OLLAMA, imageTag: '0.13.0' },
      });

      expect(res.status).toBe(201);
      expect((res.body as { aiModel: unknown }).aiModel).toMatchObject({
        imageTag: '0.13.0',
        pin: '0.12.6',
        offPin: true,
      });
      expect((res.body as { dockerImage: string }).dockerImage).toBe(
        'ollama/ollama:0.13.0',
      );
    });

    it('refuses an inference runtime the platform does not know', async () => {
      const res = await create({
        name: 'llm',
        appName: 'llm',
        aiModel: { runtime: 'llamafile', model: 'smollm2:135m' },
      });

      expect(res.status).toBe(400);
      expect(await ctx.db.select().from(application)).toEqual([]);
    });
  });

  describe('fixed at create', () => {
    it('refuses a facet given to a plain Application', async () => {
      const created = await create({ name: 'web', appName: 'web' });
      const { applicationId } = created.body as { applicationId: string };

      const res = await patch(applicationId, { aiModel: OLLAMA });

      expect(res.status).toBe(409);
      expect(await ctx.db.select().from(aiModelFacet)).toEqual([]);
    });

    it('refuses removing the facet', async () => {
      const applicationId = await createAiModel();

      const res = await patch(applicationId, { aiModel: null });

      expect(res.status).toBe(409);
      expect(await storedSecret(applicationId)).toBeDefined();
    });

    it('refuses a runtime change, and keeps the runtime it was created with', async () => {
      const applicationId = await createAiModel();

      const res = await patch(applicationId, {
        aiModel: { runtime: 'vllm', model: 'Qwen/Qwen3-0.6B' },
      });

      // A runtime the platform knows, refused by name.
      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        "An AI model's inference runtime is fixed at create; create a new AI model to change it",
      );
      const read = await request(httpServer)
        .get(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);
      expect((read.body as { aiModel: unknown }).aiModel).toMatchObject({
        runtime: 'ollama',
        model: 'smollm2:135m',
      });
    });
  });

  describe('deploy', () => {
    it('emits the pinned Ollama image on cloudgate-ai alone and pulls the model before it is done', async () => {
      const applicationId = await createAiModel();

      await deploy(applicationId);

      const spec = emittedSpec();
      expect(spec.TaskTemplate.ContainerSpec).toMatchObject({
        Image: PINNED_IMAGE,
        Command: ['/bin/ollama'],
        Args: ['serve'],
        HealthCheck: { Test: ['CMD', '/bin/ollama', 'list'] },
      });
      expect(spec.TaskTemplate.ContainerSpec.Env).toContain(
        'OLLAMA_HOST=0.0.0.0:11434',
      );
      expect(spec.TaskTemplate.Networks).toEqual([{ Target: 'cloudgate-ai' }]);
      expect(pulls()).toHaveLength(1);
      expect(pulls()[0]).toContain('docker exec "$CONTAINER_ID" /bin/ollama');
      expect(pulledModel(pulls()[0])).toBe('smollm2:135m');
      expect(parse(pulls()[0])).toContain(
        'label=com.docker.swarm.service.name=llm',
      );
      const [row] = await ctx.db
        .select({ status: deployment.status })
        .from(deployment)
        .where(eq(deployment.applicationId, applicationId));
      expect(row.status).toBe('done');
      expect(logged()).toContain("'smollm2:135m' is pulled");
    });

    it('keeps the platform-owned OLLAMA_HOST over the operator’s own env', async () => {
      const applicationId = await createAiModel();
      // The API refuses the name; a row can still hold it from before.
      await ctx.db
        .update(application)
        .set({ env: 'OLLAMA_HOST=127.0.0.1:1\nMY_SETTING=1' })
        .where(eq(application.applicationId, applicationId));

      await deploy(applicationId);

      const env = emittedSpec().TaskTemplate.ContainerSpec.Env;
      expect(env.filter((e) => e.startsWith('OLLAMA_HOST='))).toEqual([
        'OLLAMA_HOST=0.0.0.0:11434',
      ]);
      expect(env).toContain('MY_SETTING=1');
    });

    it('fails the Deployment with the pull’s reason in its log when the model cannot be pulled', async () => {
      const applicationId = await createAiModel();
      pullAnswer = (command) =>
        Promise.reject(
          new ExecError('Command failed', {
            command,
            stderr: 'Error: pull model manifest: file does not exist\n',
            exitCode: 1,
          }),
        );

      await expect(deploy(applicationId)).rejects.toThrow(
        'pull model manifest: file does not exist',
      );

      const [row] = await ctx.db
        .select({ status: deployment.status })
        .from(deployment)
        .where(eq(deployment.applicationId, applicationId));
      expect(row.status).toBe('error');
      expect(logged()).toContain(
        "Pulling 'smollm2:135m' failed, so the AI model is not ready: Error: pull model manifest: file does not exist",
      );
    });

    it('leaves a plain Application on cloudgate-network with no pull', async () => {
      const created = await create({ name: 'web', appName: 'web' });
      const { applicationId } = created.body as { applicationId: string };
      await patch(applicationId, {
        sourceType: 'docker',
        dockerImage: 'nginx:1.27',
      });

      await deploy(applicationId);

      expect(emittedSpec().TaskTemplate.Networks).toEqual([
        { Target: 'cloudgate-network' },
      ]);
      expect(pulls()).toEqual([]);
    });
  });

  describe('editing', () => {
    it('saves a model change, which the next deploy pulls', async () => {
      const applicationId = await createAiModel();

      const res = await patch(applicationId, {
        aiModel: { model: 'all-minilm' },
      });
      expect(res.status).toBe(200);
      await deploy(applicationId);

      expect(pulls()).toHaveLength(1);
      expect(pulledModel(pulls()[0])).toBe('all-minilm');
      expect(emittedSpec().TaskTemplate.ContainerSpec.Image).toBe(PINNED_IMAGE);
    });

    it('marks an image tag change off the pin and releases that image, and back on it with null', async () => {
      const applicationId = await createAiModel();

      expect(
        (await patch(applicationId, { aiModel: { imageTag: '0.13.0' } }))
          .status,
      ).toBe(200);
      let read = await request(httpServer)
        .get(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);
      expect((read.body as { aiModel: unknown }).aiModel).toMatchObject({
        imageTag: '0.13.0',
        offPin: true,
      });
      await deploy(applicationId);
      expect(emittedSpec().TaskTemplate.ContainerSpec.Image).toBe(
        'ollama/ollama:0.13.0',
      );

      expect(
        (await patch(applicationId, { aiModel: { imageTag: null } })).status,
      ).toBe(200);
      read = await request(httpServer)
        .get(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);
      expect((read.body as { aiModel: unknown }).aiModel).toMatchObject({
        imageTag: '0.12.6',
        pin: '0.12.6',
        offPin: false,
      });
      expect((read.body as { dockerImage: string }).dockerImage).toBe(
        PINNED_IMAGE,
      );
    });
  });

  describe('cloudgate-ai on a Server', () => {
    let serverId: string;

    beforeEach(async () => {
      const [row] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'gpu-1',
          ipAddress: '203.0.113.9',
          port: 22,
          organizationId,
        })
        .returning();
      serverId = row.serverId;
    });

    const joins = () =>
      execMock.execAsyncRemote.mock.calls.filter(
        ([on, command]) =>
          on === serverId &&
          command.includes('network connect cloudgate-ai cloudgate-traefik'),
      );

    it('joins Traefik to cloudgate-ai on the first AI model’s create, and not on the second', async () => {
      await createAiModel('llm-one', { serverId });

      expect(joins()).toHaveLength(1);
      expect(joins()[0][1]).toContain(
        'docker network create --driver overlay --attachable cloudgate-ai',
      );

      await createAiModel('llm-two', { serverId });

      expect(joins()).toHaveLength(1);
    });

    it('asks nothing of the network for a plain Application', async () => {
      const res = await create({ name: 'web', appName: 'web', serverId });

      expect(res.status).toBe(201);
      expect(joins()).toEqual([]);
    });

    it('pulls the model on the AI model’s own Server', async () => {
      const applicationId = await createAiModel('llm', { serverId });

      await deploy(applicationId);

      expect(
        execMock.execAsyncRemote.mock.calls.filter(
          ([on, command]) => on === serverId && command.includes('ollama pull'),
        ),
      ).toHaveLength(1);
    });
  });

  describe('audit', () => {
    async function rows() {
      return ctx.db
        .select({
          resourceType: auditLog.resourceType,
          action: auditLog.action,
          resourceId: auditLog.resourceId,
          metadata: auditLog.metadata,
        })
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'application'));
    }

    it('writes ordinary application rows, naming which facet field changed and never its value', async () => {
      const applicationId = await createAiModel();
      await patch(applicationId, {
        aiModel: { model: 'all-minilm', imageTag: '0.13.0' },
      });
      const deployed = await request(httpServer)
        .post(`/applications/${applicationId}/deployments`)
        .set('Cookie', ownerCookie)
        .send({});
      expect(deployed.status).toBe(201);

      const trail = await rows();
      expect(trail.map(({ action }) => action)).toEqual([
        'create',
        'update',
        expect.any(String),
      ]);
      expect(trail.every((r) => r.resourceId === applicationId)).toBe(true);
      const update = trail[1];
      expect(JSON.parse(update.metadata ?? '{}')).toEqual({
        route: 'PATCH /applications/:id',
        changed: ['model', 'imageTag'],
      });
      const text = JSON.stringify(trail);
      expect(text).not.toContain('all-minilm');
      expect(text).not.toContain('0.13.0');
    });

    it('names only the facet fields the update changed, not every one it sent', async () => {
      const applicationId = await createAiModel();
      // The console's Model settings form sends both on every save, with the
      // pin standing for "no tag of its own".
      await patch(applicationId, {
        aiModel: { model: OLLAMA.model, imageTag: '0.12.6' },
      });
      await patch(applicationId, {
        aiModel: { model: 'all-minilm', imageTag: null },
      });

      const [, unchanged, modelOnly] = await rows();
      expect(JSON.parse(unchanged.metadata ?? '{}')).toEqual({
        route: 'PATCH /applications/:id',
      });
      expect(JSON.parse(modelOnly.metadata ?? '{}')).toEqual({
        route: 'PATCH /applications/:id',
        changed: ['model'],
      });
    });
  });
});
