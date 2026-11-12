import { eq } from 'drizzle-orm';
import { parse } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { application, server as serverTable } from '../../src/db/schema';
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
 * An AI model on llama.cpp (spec slice 6): the platform writes
 * llama.cpp's server image for the GPUs reserved, `llama-server -hf` with
 * every layer offloaded only onto a reserved card, its port and health
 * check, and `LLAMA_CACHE` on the weights volume, with no `/dev/shm`
 * `tmpfs`; it takes the operator's Hugging Face token as vLLM does; and a
 * successful swap prunes everything in the cache but the served repo while a
 * failed one prunes nothing.
 *
 * `RemoteExecService` is the machine: it answers the GPU reads with one card,
 * the readiness probe, and the cache's listing, and records every command.
 * `RemoteDockerFactory` records the emitted Swarm spec.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** llama.cpp's cache, spelled out rather than imported. */
const LLAMA_CACHE = '/root/.cache/llama.cpp';
const GPU_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server-cuda-b11434';
const CPU_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server-b11434';
const MODEL = 'ggml-org/gemma-3-1b-it-GGUF:Q4_K_M';
const HF_TOKEN = 'hf_gatedWeightsToken0123456789';

describe('AI model on llama.cpp (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

  /** What the readiness probe answers: success unless a test scripts one. */
  let healthAnswer: (command: string) => Promise<ExecResult>;
  /** What `ls -1A` of the cache prints in the AI model's running task. */
  let cacheListing: string;

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
    if (command.includes(`ls -1A ${LLAMA_CACHE}`)) {
      return Promise.resolve(ok(cacheListing));
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
    cacheListing = '';
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

  async function createLlamaCpp(
    gpus = 0,
    facet: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await create({
      gpus,
      aiModel: { runtime: 'llama.cpp', model: MODEL, ...facet },
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

  const CPU_ARGS = ['-hf', MODEL, '--host', '0.0.0.0', '--port', '8080'];
  const GPU_ARGS = [...CPU_ARGS, '--n-gpu-layers', '999'];

  describe('create and deploy', () => {
    it('emits llama.cpp’s CPU server image, llama-server -hf, its port and health check, and LLAMA_CACHE on the weights volume with no tmpfs', async () => {
      const applicationId = await createLlamaCpp(0);

      await deploy(applicationId);

      const [row] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(row).toMatchObject({
        sourceType: 'docker',
        dockerImage: CPU_IMAGE,
        command: '/app/llama-server',
        port: 8080,
      });
      const spec = emittedSpec().TaskTemplate.ContainerSpec;
      expect(spec.Image).toBe(CPU_IMAGE);
      expect(spec.Command).toEqual(['/app/llama-server']);
      expect(spec.Args).toEqual(CPU_ARGS);
      expect(spec.HealthCheck?.Test).toEqual([
        'CMD',
        'curl',
        '-f',
        'http://localhost:8080/health',
      ]);
      expect(spec.Env).toContain(`LLAMA_CACHE=${LLAMA_CACHE}`);
      // No card for a copy that reserves none.
      expect(spec.Env).toContain('NVIDIA_VISIBLE_DEVICES=void');
      expect(spec.Mounts).toContainEqual({
        Type: 'volume',
        Source: 'llm-weights',
        Target: LLAMA_CACHE,
      });
      // vLLM's `/dev/shm` is not llama.cpp's.
      expect(spec.Mounts.some((mount) => mount.Type === 'tmpfs')).toBe(false);
      expect(logged()).toContain(
        `✅ [Model] '${MODEL}' is loaded; the AI model is ready`,
      );
    });

    it('emits the CUDA server image and offloads every layer for an AI model that reserves a GPU, and drops both once it reserves none', async () => {
      const applicationId = await createLlamaCpp(1);

      await deploy(applicationId);
      const spec = emittedSpec().TaskTemplate;
      expect(spec.ContainerSpec.Image).toBe(GPU_IMAGE);
      expect(spec.ContainerSpec.Args).toEqual(GPU_ARGS);
      expect(spec.Resources.Reservations.GenericResources).toEqual([
        { DiscreteResourceSpec: { Kind: 'GPU', Value: 1 } },
      ]);

      const res = await patch(applicationId, { gpus: 0 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        dockerImage: CPU_IMAGE,
        args: CPU_ARGS,
      });
    });

    it('keeps the GPU choice when the build tag moves, and the build when the GPUs do', async () => {
      const applicationId = await createLlamaCpp(0);

      expect(
        (await patch(applicationId, { aiModel: { imageTag: 'b11500' } })).body,
      ).toMatchObject({
        dockerImage: 'ghcr.io/ggml-org/llama.cpp:server-b11500',
      });
      expect((await patch(applicationId, { gpus: 1 })).body).toMatchObject({
        dockerImage: 'ghcr.io/ggml-org/llama.cpp:server-cuda-b11500',
        args: GPU_ARGS,
      });
    });

    it('serves a new model on the next deploy, keeping the GPU offload', async () => {
      const applicationId = await createLlamaCpp(1);

      const res = await patch(applicationId, {
        aiModel: { model: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF' },
      });
      expect(res.status).toBe(200);
      await deploy(applicationId);

      expect(emittedSpec().TaskTemplate.ContainerSpec.Args).toEqual([
        '-hf',
        'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
        '--host',
        '0.0.0.0',
        '--port',
        '8080',
        '--n-gpu-layers',
        '999',
      ]);
    });

    it('fails the Deployment when the model cannot be loaded', async () => {
      const applicationId = await createLlamaCpp(0);
      healthAnswer = (command) =>
        Promise.reject(
          new ExecError('Command failed', {
            command,
            stderr:
              'curl: (22) The requested URL returned error: 503 Service Unavailable',
            exitCode: 22,
          }),
        );

      await expect(deploy(applicationId)).rejects.toThrow(
        `Loading '${MODEL}' failed`,
      );

      expect(logged()).toContain(
        `❌ [Model] Loading '${MODEL}' failed, so the AI model is not ready: curl: (22)`,
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
        aiModel: { runtime: 'llama.cpp', model: MODEL, hfToken: HF_TOKEN },
      });
      expect(res.status).toBe(201);
      const { applicationId } = res.body as { applicationId: string };
      expect(JSON.stringify(res.body)).not.toContain(HF_TOKEN);
      expect(res.body).toMatchObject({ aiModel: { hasHfToken: true } });

      await deploy(applicationId);
      expect(emittedSpec().TaskTemplate.ContainerSpec.Env).toContain(
        `HF_TOKEN=${HF_TOKEN}`,
      );
    });

    it('refuses LLAMA_CACHE in the env, where the platform owns it', async () => {
      const applicationId = await createLlamaCpp(0);

      const res = await patch(applicationId, { env: 'LLAMA_CACHE=/tmp' });

      expect(res.status).toBe(409);
    });
  });

  describe('prune', () => {
    it('removes everything in the cache but the served repo after a successful swap', async () => {
      const applicationId = await createLlamaCpp(0);
      cacheListing = [
        'models--ggml-org--gemma-3-1b-it-GGUF',
        'models--Qwen--Qwen2.5-0.5B-Instruct-GGUF',
        'ggml-org_gemma-3-1b-it-GGUF_gemma-3-1b-it-Q4_K_M.gguf',
        '',
      ].join('\n');

      await deploy(applicationId);

      expect(removedPaths().sort()).toEqual(
        [
          `${LLAMA_CACHE}/models--Qwen--Qwen2.5-0.5B-Instruct-GGUF`,
          `${LLAMA_CACHE}/ggml-org_gemma-3-1b-it-GGUF_gemma-3-1b-it-Q4_K_M.gguf`,
        ].sort(),
      );
      expect(logged()).toContain(
        "🧹 [Model] Pruned 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', 'ggml-org_gemma-3-1b-it-GGUF_gemma-3-1b-it-Q4_K_M.gguf' from the weights volume",
      );
    });

    it('prunes nothing when the swap fails', async () => {
      const applicationId = await createLlamaCpp(0);
      cacheListing = 'models--Qwen--Qwen2.5-0.5B-Instruct-GGUF\n';
      healthAnswer = (command) =>
        Promise.reject(
          new ExecError('Command failed', {
            command,
            stderr: 'curl: (7) Failed to connect to localhost port 8080',
            exitCode: 7,
          }),
        );

      await expect(deploy(applicationId)).rejects.toThrow(
        'the AI model is not ready',
      );

      expect(removedPaths()).toEqual([]);
      expect(executed().some((c) => c.includes(`ls -1A ${LLAMA_CACHE}`))).toBe(
        false,
      );
    });
  });
});
