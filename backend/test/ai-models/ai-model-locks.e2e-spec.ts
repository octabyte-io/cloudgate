import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { application, domain, port } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * What the gateway depends on cannot be changed or bypassed over the API
 * (spec US33, US35, US36): an AI model's platform-written
 * settings, its platform-owned env names, any Domain or published port on
 * it, and `cloudgate-ai` on any other Service. Observed as an API client
 * observes it: the status, the message, and that the row did not change.
 *
 * The checks live in the services every writer goes through, so the same
 * refusals reach any MCP tool that updates an Application; none does today
 * (`FROZEN_TOOLS`).
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const OLLAMA = { runtime: 'ollama', model: 'smollm2:135m' };

type ExecOptions = { env?: Record<string, string | undefined> };

describe('AI model locks (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string): Promise<ExecResult> =>
    Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, ExecOptions?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn() },
        },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  let cookie: string;
  let environmentId: string;
  let aiModelId: string;
  let plainId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));
    queueMock.add.mockReset().mockResolvedValue(undefined);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'support' });
    const projectId = (project.body as { projectId: string }).projectId;
    const environment = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    environmentId = (environment.body as { environmentId: string })
      .environmentId;

    aiModelId = await createApplication('llm', { aiModel: OLLAMA });
    plainId = await createApplication('web');
  });

  async function createApplication(
    appName: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ environmentId, name: appName, appName, ...extra });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  const send = (
    method: 'post' | 'patch',
    path: string,
    body: Record<string, unknown>,
  ) => request(httpServer)[method](path).set('Cookie', cookie).send(body);

  const message = (res: request.Response): string =>
    JSON.stringify(res.body as unknown);

  async function row(applicationId: string) {
    const [found] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    return found;
  }

  describe('the settings the platform writes', () => {
    const changes: [string, unknown][] = [
      ['sourceType', 'git'],
      ['dockerImage', 'ollama/ollama-fork:1.0'],
      ['command', '/bin/sh'],
      ['args', ['-c', 'sleep infinity']],
      ['port', 8080],
      ['healthCheckSwarm', { Test: ['CMD', 'true'] }],
      ['networkSwarm', [{ Target: 'my-net' }]],
      ['endpointSpecSwarm', { Mode: 'vip' }],
    ];

    it.each(changes)(
      'refuses a change to %s on an AI model, naming it, and writes nothing',
      async (field, value) => {
        const before = await row(aiModelId);

        const res = await send('patch', `/applications/${aiModelId}`, {
          [field]: value,
        });

        expect(res.status).toBe(409);
        expect(message(res)).toContain(
          `${field} is set by the platform on an AI model`,
        );
        expect(await row(aiModelId)).toEqual(before);
      },
    );

    it.each(changes)(
      'keeps %s editable on a plain Application',
      async (field, value) => {
        const res = await send('patch', `/applications/${plainId}`, {
          [field]: value,
        });

        expect(res.status).toBe(200);
        expect(
          (await row(plainId))[field as keyof typeof application.$inferSelect],
        ).toEqual(value);
      },
    );

    it('admits a locked field sent back with the value it holds', async () => {
      const held = await row(aiModelId);

      const res = await send('patch', `/applications/${aiModelId}`, {
        sourceType: held.sourceType,
        dockerImage: held.dockerImage,
        port: held.port,
        args: held.args,
        healthCheckSwarm: held.healthCheckSwarm,
        name: 'llm-renamed',
      });

      expect(res.status).toBe(200);
      expect((await row(aiModelId)).name).toBe('llm-renamed');
    });

    it("still moves an AI model's image tag through its facet", async () => {
      const res = await send('patch', `/applications/${aiModelId}`, {
        aiModel: { imageTag: '0.12.7' },
      });

      expect(res.status).toBe(200);
      expect((await row(aiModelId)).dockerImage).toBe('ollama/ollama:0.12.7');
    });

    it('refuses a drop upload, which would switch the source', async () => {
      const res = await request(httpServer)
        .post(`/applications/${aiModelId}/drop`)
        .set('Cookie', cookie)
        .attach('zip', Buffer.from('not read'), 'code.zip');

      expect(res.status).toBe(409);
      expect(message(res)).toContain(
        'sourceType is set by the platform on an AI model',
      );
      expect((await row(aiModelId)).sourceType).toBe('docker');
      expect(execMock.execAsync).not.toHaveBeenCalledWith(
        expect.stringContaining('base64 -d'),
        expect.anything(),
      );
    });
  });

  describe('platform-owned env names', () => {
    const owned = [
      'OLLAMA_HOST',
      'OLLAMA_MODELS',
      'HF_HOME',
      'LLAMA_CACHE',
      'HF_TOKEN',
      'NVIDIA_VISIBLE_DEVICES',
      'CUDA_VISIBLE_DEVICES',
    ];
    const routes: [string, (id: string) => string][] = [
      ['PATCH /applications/:id', (id) => `/applications/${id}`],
      [
        'PATCH /applications/:id/environment',
        (id) => `/applications/${id}/environment`,
      ],
    ];

    describe.each(routes)('over %s', (_route, path) => {
      it.each(owned)('refuses %s on an AI model', async (name) => {
        const res = await send('patch', path(aiModelId), {
          env: `KEEP=1\n${name}=mine`,
        });

        expect(res.status).toBe(409);
        expect(message(res)).toContain(
          `${name} is set by the platform on an AI model`,
        );
        expect((await row(aiModelId)).env).toBeNull();
      });

      it('accepts any other env on an AI model', async () => {
        const res = await send('patch', path(aiModelId), {
          env: 'OLLAMA_KEEP_ALIVE=24h\nLOG_LEVEL=debug',
        });

        expect(res.status).toBe(200);
        expect((await row(aiModelId)).env).toBe(
          'OLLAMA_KEEP_ALIVE=24h\nLOG_LEVEL=debug',
        );
      });

      it('accepts the same names on a plain Application', async () => {
        const res = await send('patch', path(plainId), {
          env: 'OLLAMA_HOST=0.0.0.0:1\nHF_TOKEN=hf_x',
        });

        expect(res.status).toBe(200);
      });
    });

    it('reads a name the way the deploy does, `export` form included', async () => {
      const res = await send(
        'patch',
        `/applications/${aiModelId}/environment`,
        {
          env: 'export HF_TOKEN=hf_x',
        },
      );

      expect(res.status).toBe(409);
      expect(message(res)).toContain('HF_TOKEN is set by the platform');
    });
  });

  describe('reaching an AI model around the gateway', () => {
    it('refuses a Domain on an AI model and stores none', async () => {
      const res = await send('post', '/domains', {
        host: 'llm.example.com',
        applicationId: aiModelId,
        domainType: 'application',
        port: 11434,
      });

      expect(res.status).toBe(409);
      expect(message(res)).toContain('An AI model takes no Domain');
      expect(await ctx.db.select().from(domain)).toEqual([]);
    });

    it('refuses a published port on an AI model and stores none', async () => {
      const res = await send('post', '/ports', {
        applicationId: aiModelId,
        publishedPort: 11434,
        targetPort: 11434,
      });

      expect(res.status).toBe(409);
      expect(message(res)).toContain('An AI model publishes no port');
      expect(await ctx.db.select().from(port)).toEqual([]);
    });

    it('keeps published ports on a plain Application', async () => {
      const res = await send('post', '/ports', {
        applicationId: plainId,
        publishedPort: 8080,
        targetPort: 80,
      });

      expect(res.status).toBe(201);
    });
  });

  describe('`cloudgate-ai` on any other Service', () => {
    const onAi = [{ Target: 'cloudgate-ai' }];

    it('refuses it in a plain Application’s networkSwarm', async () => {
      const res = await send('patch', `/applications/${plainId}`, {
        networkSwarm: [{ Target: 'my-net' }, ...onAi],
      });

      expect(res.status).toBe(400);
      expect(message(res)).toContain(
        '\\"cloudgate-ai\\" is the AI models\' own network',
      );
      expect((await row(plainId)).networkSwarm).toBeNull();
    });

    it.each([
      ['postgres', { databaseName: 'orders', databaseUser: 'shop' }],
      ['redis', {}],
    ])('refuses it in a %s networkSwarm', async (engine, fields) => {
      const made = await send('post', `/${engine}`, {
        name: 'db',
        environmentId,
        ...fields,
      });
      expect(made.status).toBe(201);
      const id = (made.body as Record<string, string>)[`${engine}Id`];

      const res = await send('patch', `/${engine}/${id}`, {
        networkSwarm: onAi,
      });

      expect(res.status).toBe(400);
      expect(message(res)).toContain("the AI models' own network");
    });

    it.each([
      [
        'an external root network',
        'services:\n  web:\n    image: nginx\n    networks: [cloudgate-ai]\nnetworks:\n  cloudgate-ai:\n    external: true\n',
      ],
      [
        'a root network named it',
        'services:\n  web:\n    image: nginx\n    networks: [ai]\nnetworks:\n  ai:\n    name: cloudgate-ai\n    external: true\n',
      ],
      [
        "a service's network_mode",
        'services:\n  web:\n    image: nginx\n    network_mode: cloudgate-ai\n',
      ],
    ])('refuses a Compose whose file names it in %s', async (_where, file) => {
      const res = await send('post', '/compose', {
        name: 'shop',
        appName: 'shop',
        environmentId,
        composeType: 'docker-compose',
        composeFile: file,
      });

      expect(res.status).toBe(400);
      expect(message(res)).toContain("the AI models' own network");
    });

    it('admits a Compose on its own networks', async () => {
      const res = await send('post', '/compose', {
        name: 'shop',
        appName: 'shop',
        environmentId,
        composeType: 'docker-compose',
        composeFile:
          'services:\n  web:\n    image: nginx\n    networks: [back]\nnetworks:\n  back: {}\n',
      });

      expect(res.status).toBe(201);
    });
  });
});
