import { eq } from 'drizzle-orm';
import { parse } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application,
  deployment,
  destination,
  mount,
  server as serverTable,
  volumeBackup,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { ExecError } from '../../src/remote/exec-error';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * An AI model's weights volume (spec slice 2): the platform mounts
 * `<appName>-weights` at the runtime's weights path and no operator write can
 * name it, a successful swap prunes it back to the one model served and a
 * failed one prunes nothing, every Delete removes it on the AI model's Server
 * whatever `deleteVolumes` says, and a VolumeBackup of it is refused.
 *
 * `RemoteExecService` is the machine: it records every command and answers
 * the model pull, `ollama list`, and `docker volume rm` as each test scripts.
 * `RemoteDockerFactory` records the emitted Swarm spec.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** Ollama's own weights path for root, spelled out rather than imported. */
const WEIGHTS_PATH = '/root/.ollama/models';
const OLLAMA = { runtime: 'ollama', model: 'smollm2:135m' };

describe('AI model weights volume (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const failed = (command: string, stderr: string) =>
    Promise.reject(
      new ExecError('Command failed', { command, stderr, exitCode: 1 }),
    );

  /** What the model pull answers: success unless a test scripts a failure. */
  let pullAnswer: (command: string) => Promise<ExecResult>;
  /** What `ollama list` prints in the AI model's running task. */
  let listing: string;
  /** Volumes whose `docker volume rm` fails, with Docker's complaint. */
  let volumeRmFailures: Record<string, string>;

  const machine = (command: string): Promise<ExecResult> => {
    if (isPresenceProbe(command)) return Promise.resolve(ok('absent'));
    if (command.includes('ollama pull')) return pullAnswer(command);
    if (command.includes('/bin/ollama list')) {
      return Promise.resolve(ok(listing));
    }
    const removal = /docker volume rm --force (\S+)\s*$/m.exec(command);
    if (removal && volumeRmFailures[removal[1]]) {
      return failed(command, volumeRmFailures[removal[1]]);
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
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let serverId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    pullAnswer = () => Promise.resolve(ok());
    listing = 'NAME            ID              SIZE      MODIFIED\n';
    volumeRmFailures = {};
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
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'support' });
    projectId = (project.body as { projectId: string }).projectId;
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

  async function createAiModel(appName = 'llm', model = OLLAMA.model) {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', cookie)
      .send({
        environmentId,
        name: appName,
        appName,
        serverId,
        aiModel: { ...OLLAMA, model },
      });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  async function createPlain(appName = 'web') {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ environmentId, name: appName, appName, serverId });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
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
        Env: string[];
        Mounts: { Type: string; Source: string; Target: string }[];
      };
      Placement?: { Constraints?: string[] };
    };
  }

  function emittedSpec(): EmittedSpec {
    const call = docker.createService.mock.lastCall as unknown[];
    return call[call.length - 1] as EmittedSpec;
  }

  /** Every command each machine was asked, the platform host as `null`. */
  const executed = (): { on: string | null; command: string }[] => [
    ...execMock.execAsync.mock.calls.map(([command]) => ({
      on: null,
      command,
    })),
    ...execMock.execAsyncRemote.mock.calls.map(([on, command]) => ({
      on,
      command,
    })),
  ];

  /** The models each `ollama rm` named, its shell quoting undone. */
  const removedModels = (): string[] =>
    executed()
      .map(({ command }) => /\/bin\/ollama rm (.*)$/m.exec(command)?.[1])
      .filter((words): words is string => words !== undefined)
      .flatMap((words) => parse(words) as string[]);

  const listings = () =>
    executed().filter(({ command }) => command.includes('/bin/ollama list'));

  /** Every line the deploy wrote into the Deployment log, decoded. */
  const logged = (): string =>
    executed()
      .flatMap(({ command }) =>
        [...command.matchAll(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/g)].map(
          (match) => Buffer.from(match[1], 'base64').toString('utf8'),
        ),
      )
      .join('');

  /** The volumes each machine was asked to `docker volume rm`. */
  const volumeRemovals = () =>
    executed().flatMap(({ on, command }) => {
      const removal = /docker volume rm --force (\S+)\s*$/m.exec(command);
      return removal ? [{ on, volume: removal[1] }] : [];
    });

  const leftBehindVolumes = (body: unknown) =>
    (
      (
        body as {
          unreclaimedArtifacts?: {
            kind: string;
            appName: string;
            path: string;
            serverId: string | null;
            reason?: string;
          }[];
        }
      ).unreclaimedArtifacts ?? []
    ).filter((artifact) => artifact.kind === 'volume');

  describe('mount', () => {
    it('mounts <appName>-weights at OLLAMA_MODELS, which the env names, without pinning the AI model to a manager', async () => {
      const applicationId = await createAiModel();

      await deploy(applicationId);

      const spec = emittedSpec().TaskTemplate;
      expect(spec.ContainerSpec.Mounts).toContainEqual({
        Type: 'volume',
        Source: 'llm-weights',
        Target: WEIGHTS_PATH,
      });
      expect(spec.ContainerSpec.Env).toContain(`OLLAMA_MODELS=${WEIGHTS_PATH}`);
      expect(spec.Placement?.Constraints ?? []).not.toContain(
        'node.role==manager',
      );
    });

    it('gives each AI model its own weights volume, even on one Server', async () => {
      const one = await createAiModel('llm-one');
      const two = await createAiModel('llm-two');

      await deploy(one);
      const first = emittedSpec().TaskTemplate.ContainerSpec.Mounts;
      await deploy(two);
      const second = emittedSpec().TaskTemplate.ContainerSpec.Mounts;

      expect(first.map((m) => m.Source)).toEqual(['llm-one-weights']);
      expect(second.map((m) => m.Source)).toEqual(['llm-two-weights']);
    });

    it('keeps the platform-owned OLLAMA_MODELS over an env stored with its own', async () => {
      const applicationId = await createAiModel();
      // The API refuses the name; a row can still hold it from before.
      await ctx.db
        .update(application)
        .set({ env: 'OLLAMA_MODELS=/tmp/elsewhere' })
        .where(eq(application.applicationId, applicationId));

      await deploy(applicationId);

      expect(
        emittedSpec().TaskTemplate.ContainerSpec.Env.filter((e) =>
          e.startsWith('OLLAMA_MODELS='),
        ),
      ).toEqual([`OLLAMA_MODELS=${WEIGHTS_PATH}`]);
    });

    it('writes no mount row an operator could edit or remove', async () => {
      const applicationId = await createAiModel();

      const res = await request(httpServer)
        .get('/mounts')
        .query({ serviceId: applicationId, serviceType: 'application' })
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('refuses an operator mount naming an AI model’s weights volume, from any Service', async () => {
      const applicationId = await createAiModel();
      const plainId = await createPlain();

      for (const serviceId of [applicationId, plainId]) {
        const res = await request(httpServer)
          .post('/mounts')
          .set('Cookie', cookie)
          .send({
            serviceId,
            serviceType: 'application',
            type: 'volume',
            volumeName: 'llm-weights',
            mountPath: '/data',
          });
        expect(res.status).toBe(409);
        expect((res.body as { message: string }).message).toBe(
          "llm-weights is an AI model's weights volume, which the platform mounts; no other mount can name it",
        );
      }
      const rows = await ctx.db.select().from(mount);
      expect(rows).toEqual([]);
    });

    it('refuses an operator mount over the AI model’s weights path, and takes one elsewhere', async () => {
      const applicationId = await createAiModel();
      const at = (mountPath: string) =>
        request(httpServer).post('/mounts').set('Cookie', cookie).send({
          serviceId: applicationId,
          serviceType: 'application',
          type: 'volume',
          volumeName: 'my-cache',
          mountPath,
        });

      const refused = await at(`${WEIGHTS_PATH}/`);
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        `${WEIGHTS_PATH} is where the platform mounts this AI model's weights volume; mount at another path`,
      );
      expect((await at('/cache')).status).toBe(201);
    });

    it('refuses retargeting an existing mount at the weights volume or its path', async () => {
      const applicationId = await createAiModel();
      const created = await request(httpServer)
        .post('/mounts')
        .set('Cookie', cookie)
        .send({
          serviceId: applicationId,
          serviceType: 'application',
          type: 'volume',
          volumeName: 'my-cache',
          mountPath: '/cache',
        });
      expect(created.status).toBe(201);
      const { mountId } = created.body as { mountId: string };

      for (const body of [
        { volumeName: 'llm-weights' },
        { mountPath: WEIGHTS_PATH },
      ]) {
        const res = await request(httpServer)
          .patch(`/mounts/${mountId}`)
          .set('Cookie', cookie)
          .send(body);
        expect(res.status).toBe(409);
      }
      const [row] = await ctx.db.select().from(mount);
      expect(row).toMatchObject({
        volumeName: 'my-cache',
        mountPath: '/cache',
      });
    });

    it('takes a volume named like weights that no AI model owns', async () => {
      const plainId = await createPlain();

      const res = await request(httpServer)
        .post('/mounts')
        .set('Cookie', cookie)
        .send({
          serviceId: plainId,
          serviceType: 'application',
          type: 'volume',
          volumeName: 'web-weights',
          mountPath: '/data',
        });

      expect(res.status).toBe(201);
    });
  });

  describe('prune', () => {
    it('deletes every other model after a successful swap, and keeps the one served', async () => {
      const applicationId = await createAiModel('llm', 'all-minilm');
      listing = [
        'NAME                ID              SIZE      MODIFIED',
        'smollm2:135m        9077fe9d2ae1    270 MB    2 hours ago',
        'all-minilm:latest   1b226e2802db    45 MB     1 second ago',
        'qwen2:0.5b          6f48b936a09f    352 MB    3 days ago',
        '',
      ].join('\n');

      await deploy(applicationId);

      expect(listings()).toHaveLength(1);
      expect(listings()[0].on).toBe(serverId);
      expect(removedModels()).toEqual(['smollm2:135m', 'qwen2:0.5b']);
      expect(
        executed().find(({ command }) => command.includes('/bin/ollama rm'))
          ?.on,
      ).toBe(serverId);
      expect(logged()).toContain(
        "Pruned 'smollm2:135m', 'qwen2:0.5b' from the weights volume",
      );
    });

    it('deletes nothing when the volume holds only the model served', async () => {
      const applicationId = await createAiModel();
      listing += 'smollm2:135m    9077fe9d2ae1    270 MB    1 second ago\n';

      await deploy(applicationId);

      expect(listings()).toHaveLength(1);
      expect(removedModels()).toEqual([]);
    });

    it('prunes nothing after a failed deploy', async () => {
      const applicationId = await createAiModel();
      listing += 'qwen2:0.5b    6f48b936a09f    352 MB    3 days ago\n';
      pullAnswer = (command) =>
        failed(command, 'Error: pull model manifest: file does not exist\n');

      await expect(deploy(applicationId)).rejects.toThrow(
        'pull model manifest',
      );

      expect(listings()).toEqual([]);
      expect(removedModels()).toEqual([]);
    });

    it('logs a failed prune and leaves the Deployment done', async () => {
      const applicationId = await createAiModel();
      execMock.execAsyncRemote.mockImplementation((_on, command) =>
        command.includes('/bin/ollama list')
          ? failed(command, 'Error: could not connect to ollama app\n')
          : machine(command),
      );

      await deploy(applicationId);

      const [row] = await ctx.db
        .select({ status: deployment.status })
        .from(deployment)
        .where(eq(deployment.applicationId, applicationId));
      expect(row.status).toBe('done');

      expect(logged()).toContain(
        "Pruning the weights volume failed, so models other than 'smollm2:135m' may remain",
      );
    });
  });

  describe('Delete', () => {
    it('removes the weights volume on the AI model’s Server without deleteVolumes', async () => {
      const applicationId = await createAiModel();

      const res = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(volumeRemovals()).toEqual([
        { on: serverId, volume: 'llm-weights' },
      ]);
      expect(leftBehindVolumes(res.body)).toEqual([]);
    });

    it('removes the weights volume beside the operator’s own with deleteVolumes', async () => {
      const applicationId = await createAiModel();
      await ctx.db.insert(mount).values({
        type: 'volume',
        volumeName: 'llm-cache',
        mountPath: '/cache',
        applicationId,
      });

      const res = await request(httpServer)
        .delete(`/applications/${applicationId}?deleteVolumes=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(volumeRemovals()).toEqual([
        { on: serverId, volume: 'llm-cache' },
        { on: serverId, volume: 'llm-weights' },
      ]);
    });

    it('asks nothing about weights for a plain Application', async () => {
      const plainId = await createPlain();

      const res = await request(httpServer)
        .delete(`/applications/${plainId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(volumeRemovals()).toEqual([]);
    });

    it('names a weights volume it could not remove as left behind, and deletes the AI model', async () => {
      const applicationId = await createAiModel();
      volumeRmFailures['llm-weights'] =
        'Error response from daemon: remove llm-weights: volume is in use\n';

      const res = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(leftBehindVolumes(res.body)).toEqual([
        {
          kind: 'volume',
          appName: 'llm',
          serverId,
          path: 'llm-weights',
          reason:
            'Kept: docker volume rm failed — Error response from daemon: remove llm-weights: volume is in use',
        },
      ]);
      const gone = await request(httpServer)
        .get(`/applications/${applicationId}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });

    it('removes every AI model’s weights volume when its Environment is deleted', async () => {
      await createAiModel('llm-one');
      await createAiModel('llm-two');
      await createPlain();

      const res = await request(httpServer)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(volumeRemovals()).toEqual([
        { on: serverId, volume: 'llm-one-weights' },
        { on: serverId, volume: 'llm-two-weights' },
      ]);
    });

    it('removes the weights volume when its Project is deleted, and names one it could not', async () => {
      await createAiModel();
      volumeRmFailures['llm-weights'] = 'Cannot connect to the Docker daemon\n';

      const res = await request(httpServer)
        .delete(`/projects/${projectId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(volumeRemovals()).toEqual([
        { on: serverId, volume: 'llm-weights' },
      ]);
      expect(leftBehindVolumes(res.body)).toEqual([
        {
          kind: 'volume',
          appName: 'llm',
          serverId,
          path: 'llm-weights',
          reason:
            'Kept: docker volume rm failed — Cannot connect to the Docker daemon',
        },
      ]);
    });
  });

  describe('VolumeBackup', () => {
    async function seedDestination() {
      const [row] = await ctx.db
        .insert(destination)
        .values({
          name: 'backups',
          accessKey: 'key',
          secretAccessKey: 'secret',
          bucket: 'bucket',
          region: 'eu-west-1',
          endpoint: 'https://s3.example.com',
          organizationId,
        })
        .returning();
      return row.destinationId;
    }

    const backupBody = (
      serviceId: string,
      destinationId: string,
      volumeName: string,
    ) => ({
      name: 'nightly',
      volumeName,
      prefix: 'nightly',
      schedule: '0 3 * * *',
      serviceType: 'application',
      serviceId,
      destinationId,
    });

    it('refuses a VolumeBackup of the weights volume, and writes nothing', async () => {
      const applicationId = await createAiModel();
      const destinationId = await seedDestination();

      const res = await request(httpServer)
        .post('/volume-backups')
        .set('Cookie', cookie)
        .send(backupBody(applicationId, destinationId, 'llm-weights'));

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        "llm-weights is an AI model's weights volume, which is not backed up: its models are downloaded again on the next deploy",
      );
      expect(await ctx.db.select().from(volumeBackup)).toEqual([]);
    });

    it('refuses re-pointing a VolumeBackup at the weights volume', async () => {
      const applicationId = await createAiModel();
      const destinationId = await seedDestination();
      const created = await request(httpServer)
        .post('/volume-backups')
        .set('Cookie', cookie)
        .send(backupBody(applicationId, destinationId, 'llm-cache'));
      expect(created.status).toBe(201);
      const { volumeBackupId } = created.body as { volumeBackupId: string };

      const res = await request(httpServer)
        .patch(`/volume-backups/${volumeBackupId}`)
        .set('Cookie', cookie)
        .send({ volumeName: 'llm-weights' });

      expect(res.status).toBe(409);
      const [row] = await ctx.db.select().from(volumeBackup);
      expect(row.volumeName).toBe('llm-cache');
    });
  });
});
