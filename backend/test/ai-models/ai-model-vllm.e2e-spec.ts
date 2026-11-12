import { eq, sql } from 'drizzle-orm';
import { parse } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  aiModelFacet,
  application,
  auditLog,
  server as serverTable,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { ExecError } from '../../src/remote/exec-error';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { nvidiaRuntimeAnswer } from '../settings/gpu-runtime.fixture';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * An AI model on vLLM (spec slice 5): the platform writes vLLM's
 * image for the GPUs reserved, its command, port and health check, `HF_HOME`
 * on the weights volume and a `tmpfs` at `/dev/shm`; the operator's Hugging
 * Face token is write-only, injected as `HF_TOKEN` and read back only as
 * `hasHfToken`; and a successful swap prunes the other repos from the
 * Hugging Face cache while a failed one prunes nothing.
 *
 * `RemoteExecService` is the machine: it answers the GPU reads with one card,
 * the readiness probe, and the hub cache's listing, and records every
 * command. `RemoteDockerFactory` records the emitted Swarm spec.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** vLLM's Hugging Face cache, spelled out rather than imported. */
const HF_HOME = '/root/.cache/huggingface';
const HUB = `${HF_HOME}/hub`;
const GPU_IMAGE = 'vllm/vllm-openai:v0.11.0';
const CPU_IMAGE = 'public.ecr.aws/q9t5s3a7/vllm-cpu-release-repo:v0.11.0';
const MODEL = 'Qwen/Qwen2.5-0.5B-Instruct';
const HF_TOKEN = 'hf_gatedWeightsToken0123456789';

describe('AI model on vLLM (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

  /** What the readiness probe answers: success unless a test scripts one. */
  let healthAnswer: (command: string) => Promise<ExecResult>;
  /** What `ls -1` of the hub cache prints in the AI model's running task. */
  let hubListing: string;

  const machine = (command: string): Promise<ExecResult> => {
    if (isPresenceProbe(command)) return Promise.resolve(ok('absent'));
    // One card, advertised by its ID, and no task holding it.
    if (command.startsWith('docker node inspect self')) {
      return Promise.resolve(
        ok('[{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-aaaa"}}]\n'),
      );
    }
    if (command.startsWith('docker node ps self')) {
      return Promise.resolve(ok(''));
    }
    // The NVIDIA runtime set up to hand a task its card.
    const runtime = nvidiaRuntimeAnswer(command);
    if (runtime) return runtime;
    if (command.includes('/health')) return healthAnswer(command);
    if (command.includes(`ls -1 ${HUB}`)) {
      return Promise.resolve(ok(hubListing));
    }
    return Promise.resolve(ok(''));
  };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
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
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  let cookie: string;
  let environmentId: string;
  let serverId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    healthAnswer = () => Promise.resolve(ok());
    hubListing = '';
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
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'support' });
    const projectId = (project.body as { projectId: string }).projectId;
    const environment = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;
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

  function create(body: { gpus?: number; aiModel: Record<string, unknown> }) {
    return request(httpServer)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ environmentId, name: 'llm', appName: 'llm', serverId, ...body });
  }

  async function createVllm(
    gpus = 0,
    facet: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await create({
      gpus,
      aiModel: { runtime: 'vllm', model: MODEL, ...facet },
    });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  const patch = (applicationId: string, body: object) =>
    request(httpServer)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', cookie)
      .send(body);

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
        Command?: string[];
        Args?: string[];
        Env: string[];
        HealthCheck?: { Test: string[]; StartPeriod?: number };
        Mounts: { Type: string; Source: string; Target: string }[];
      };
      Resources: { Reservations: { GenericResources?: unknown[] } };
    };
  }

  function emittedSpec(): EmittedSpec {
    const call = docker.createService.mock.lastCall as unknown[];
    return call[call.length - 1] as EmittedSpec;
  }

  const executed = (): string[] => [
    ...execMock.execAsync.mock.calls.map(([command]) => command),
    ...execMock.execAsyncRemote.mock.calls.map(([, command]) => command),
  ];

  /** The paths each `rm -rf` in a task was asked to remove. */
  const removedPaths = (): string[] =>
    executed()
      .map(
        (command) =>
          /docker exec "\$CONTAINER_ID" rm -rf -- (.*)$/m.exec(command)?.[1],
      )
      .filter((words): words is string => words !== undefined)
      .flatMap((words) => parse(words) as string[]);

  /** Every line the deploy wrote into the Deployment log, decoded. */
  const logged = (): string =>
    executed()
      .flatMap((command) =>
        [...command.matchAll(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/g)].map(
          (match) => Buffer.from(match[1], 'base64').toString('utf8'),
        ),
      )
      .join('');

  describe('create and deploy', () => {
    it('emits vLLM’s CPU image, its command, port and health check, HF_HOME on the weights volume and a tmpfs at /dev/shm', async () => {
      const applicationId = await createVllm(0);

      await deploy(applicationId);

      const [row] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(row).toMatchObject({
        sourceType: 'docker',
        dockerImage: CPU_IMAGE,
        command: 'vllm',
        port: 8000,
      });
      const spec = emittedSpec().TaskTemplate.ContainerSpec;
      expect(spec.Image).toBe(CPU_IMAGE);
      expect(spec.Command).toEqual(['vllm']);
      expect(spec.Args).toEqual([
        'serve',
        MODEL,
        '--host',
        '0.0.0.0',
        '--port',
        '8000',
      ]);
      expect(spec.HealthCheck?.Test.join(' ')).toContain(
        'http://127.0.0.1:8000/health',
      );
      expect(spec.Env).toContain(`HF_HOME=${HF_HOME}`);
      // No card for a copy that reserves none.
      expect(spec.Env).toContain('NVIDIA_VISIBLE_DEVICES=void');
      expect(spec.Mounts).toEqual(
        expect.arrayContaining([
          { Type: 'volume', Source: 'llm-weights', Target: HF_HOME },
          { Type: 'tmpfs', Source: '', Target: '/dev/shm' },
        ]),
      );
      expect(logged()).toContain(
        `✅ [Model] '${MODEL}' is loaded; the AI model is ready`,
      );
    });

    it('emits vLLM’s GPU image for an AI model that reserves a GPU, and the CPU one once it reserves none', async () => {
      const applicationId = await createVllm(1);

      await deploy(applicationId);
      const spec = emittedSpec().TaskTemplate;
      expect(spec.ContainerSpec.Image).toBe(GPU_IMAGE);
      expect(spec.Resources.Reservations.GenericResources).toEqual([
        { DiscreteResourceSpec: { Kind: 'GPU', Value: 1 } },
      ]);
      expect(spec.ContainerSpec.Env).not.toContain(
        'NVIDIA_VISIBLE_DEVICES=void',
      );

      const res = await patch(applicationId, { gpus: 0 });
      expect(res.status).toBe(200);
      expect((res.body as { dockerImage: string }).dockerImage).toBe(CPU_IMAGE);
    });

    it('keeps the GPU choice when the image tag moves, and the tag when the GPUs do', async () => {
      const applicationId = await createVllm(0);

      expect(
        (await patch(applicationId, { aiModel: { imageTag: 'v0.12.0' } })).body,
      ).toMatchObject({
        dockerImage: 'public.ecr.aws/q9t5s3a7/vllm-cpu-release-repo:v0.12.0',
      });
      expect((await patch(applicationId, { gpus: 1 })).body).toMatchObject({
        dockerImage: 'vllm/vllm-openai:v0.12.0',
      });
    });

    it('serves a new model on the next deploy', async () => {
      const applicationId = await createVllm(0);

      const res = await patch(applicationId, {
        aiModel: { model: 'Qwen/Qwen2.5-1.5B-Instruct' },
      });
      expect(res.status).toBe(200);
      await deploy(applicationId);

      expect(emittedSpec().TaskTemplate.ContainerSpec.Args?.[1]).toBe(
        'Qwen/Qwen2.5-1.5B-Instruct',
      );
    });

    it('fails the Deployment when the model cannot be loaded', async () => {
      const applicationId = await createVllm(0);
      healthAnswer = (command) =>
        Promise.reject(
          new ExecError('Command failed', {
            command,
            stderr:
              'urllib.error.URLError: <urlopen error [Errno 111] Connection refused>',
            exitCode: 1,
          }),
        );

      await expect(deploy(applicationId)).rejects.toThrow(
        `Loading '${MODEL}' failed`,
      );

      expect(logged()).toContain(
        `❌ [Model] Loading '${MODEL}' failed, so the AI model is not ready: urllib.error.URLError`,
      );
      const [row] = await ctx.db
        .select({ applicationStatus: application.applicationStatus })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(row.applicationStatus).toBe('error');
    });
  });

  describe('Hugging Face token', () => {
    it('takes the token on create, injects it as HF_TOKEN, and reads back only hasHfToken', async () => {
      const res = await create({
        aiModel: { runtime: 'vllm', model: MODEL, hfToken: HF_TOKEN },
      });
      expect(res.status).toBe(201);
      const { applicationId } = res.body as { applicationId: string };
      expect(JSON.stringify(res.body)).not.toContain(HF_TOKEN);
      expect(res.body).toMatchObject({ aiModel: { hasHfToken: true } });

      const read = await request(httpServer)
        .get(`/applications/${applicationId}`)
        .set('Cookie', cookie);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ aiModel: { hasHfToken: true } });
      expect(JSON.stringify(read.body)).not.toContain(HF_TOKEN);
      expect(JSON.stringify(read.body)).not.toContain('"hfToken"');

      await deploy(applicationId);
      expect(emittedSpec().TaskTemplate.ContainerSpec.Env).toContain(
        `HF_TOKEN=${HF_TOKEN}`,
      );
    });

    it('stores the token encrypted', async () => {
      const applicationId = await createVllm(0, { hfToken: HF_TOKEN });

      const raw = await ctx.db.execute<{ hf_token: string }>(
        sql`select hf_token from ai_model where application_id = ${applicationId}`,
      );
      expect(raw.rows[0].hf_token).toMatch(/^enc:/);
      expect(raw.rows[0].hf_token).not.toContain(HF_TOKEN);
    });

    it('replaces and removes the token, writing an audit row naming the field and never its value', async () => {
      const applicationId = await createVllm(0);
      const hasHfToken = async () =>
        (
          (
            await request(httpServer)
              .get(`/applications/${applicationId}`)
              .set('Cookie', cookie)
          ).body as { aiModel: { hasHfToken: boolean } }
        ).aiModel.hasHfToken;
      expect(await hasHfToken()).toBe(false);

      const replaced = await patch(applicationId, {
        aiModel: { hfToken: HF_TOKEN },
      });
      expect(replaced.status).toBe(200);
      expect(JSON.stringify(replaced.body)).not.toContain(HF_TOKEN);
      expect(await hasHfToken()).toBe(true);

      const rows = await ctx.db.select().from(auditLog);
      const update = rows.find(
        (row) =>
          row.resourceType === 'application' &&
          row.action === 'update' &&
          row.resourceId === applicationId,
      );
      expect(JSON.parse(update?.metadata ?? '{}')).toEqual({
        route: 'PATCH /applications/:id',
        changed: ['hfToken'],
      });
      expect(JSON.stringify(rows)).not.toContain(HF_TOKEN);

      expect(
        (await patch(applicationId, { aiModel: { hfToken: null } })).status,
      ).toBe(200);
      expect(await hasHfToken()).toBe(false);

      // `''` clears too, as for every secret read back as its presence
      // (ADR-0019).
      await patch(applicationId, { aiModel: { hfToken: HF_TOKEN } });
      expect(await hasHfToken()).toBe(true);
      expect(
        (await patch(applicationId, { aiModel: { hfToken: '' } })).status,
      ).toBe(200);
      expect(await hasHfToken()).toBe(false);
      await deploy(applicationId);
      expect(
        emittedSpec().TaskTemplate.ContainerSpec.Env.filter((e) =>
          e.startsWith('HF_TOKEN='),
        ),
      ).toEqual([]);
    });

    it('refuses HF_TOKEN in the env, where the platform owns it', async () => {
      const applicationId = await createVllm(0);

      const res = await patch(applicationId, { env: `HF_TOKEN=${HF_TOKEN}` });

      expect(res.status).toBe(409);
    });

    it('refuses a Hugging Face token on an AI model on Ollama, on create and on update', async () => {
      const refusedCreate = await create({
        aiModel: {
          runtime: 'ollama',
          model: 'smollm2:135m',
          hfToken: HF_TOKEN,
        },
      });
      expect(refusedCreate.status).toBe(400);

      const created = await create({
        aiModel: { runtime: 'ollama', model: 'smollm2:135m' },
      });
      expect(created.status).toBe(201);
      const { applicationId } = created.body as { applicationId: string };
      const refusedUpdate = await patch(applicationId, {
        aiModel: { hfToken: HF_TOKEN },
      });
      expect(refusedUpdate.status).toBe(409);
      expect((refusedUpdate.body as { message: string }).message).toBe(
        'A Hugging Face token is for an AI model on vLLM or llama.cpp; this one does not use one',
      );
      const [facet] = await ctx.db
        .select({ hfToken: aiModelFacet.hfToken })
        .from(aiModelFacet);
      expect(facet.hfToken).toBeNull();
    });
  });

  describe('prune', () => {
    it('removes every other repo from the Hugging Face cache after a successful swap', async () => {
      const applicationId = await createVllm(0);
      hubListing = [
        `models--Qwen--Qwen2.5-0.5B-Instruct`,
        `models--meta-llama--Llama-3.2-1B`,
        `datasets--squad`,
        `version.txt`,
        '',
      ].join('\n');

      await deploy(applicationId);

      expect(removedPaths().sort()).toEqual(
        [
          `${HUB}/.locks/models--meta-llama--Llama-3.2-1B`,
          `${HUB}/models--meta-llama--Llama-3.2-1B`,
        ].sort(),
      );
      expect(logged()).toContain(
        "🧹 [Model] Pruned 'meta-llama/Llama-3.2-1B' from the weights volume",
      );
    });

    it('prunes nothing when the swap fails', async () => {
      const applicationId = await createVllm(0);
      hubListing = 'models--meta-llama--Llama-3.2-1B\n';
      healthAnswer = (command) =>
        Promise.reject(
          new ExecError('Command failed', {
            command,
            stderr: 'Connection refused',
            exitCode: 1,
          }),
        );

      await expect(deploy(applicationId)).rejects.toThrow(
        'the AI model is not ready',
      );

      expect(removedPaths()).toEqual([]);
      expect(executed().some((c) => c.includes(`ls -1 ${HUB}`))).toBe(false);
    });
  });
});
