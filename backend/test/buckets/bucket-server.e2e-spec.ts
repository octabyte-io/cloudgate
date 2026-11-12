import { ForbiddenException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { bucket, server as serverTable } from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { PermissionService } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * A Bucket on a Server (ADR-0037), through the HTTP API: written
 * `kind: bucket` in the Project config, planned with its real name, applied
 * as its own Garage Swarm service on the Environment's Server with its files
 * on its own volume, and its bucket and key made through the `garage` CLI in
 * its task. The Server (its shell) and its Docker daemon are the doubles;
 * words and names are written out here, never imported (§1.7).
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** What the key program prints once Garage made the key. */
const KEY_ID = 'GK3a1f0c9e2b7d4c6a8e1f0b2d';
const SECRET_KEY =
  '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';

interface PlanBody {
  planId: string;
  environmentId: string;
  status: string;
  steps: Array<Record<string, unknown>>;
  notes: Array<{ kind: string; configName: string; message: string }>;
  results: Array<{
    configName: string;
    action: string;
    status: string;
    message: string | null;
    serviceType: string | null;
    serviceId: string | null;
    deploy: unknown;
  }> | null;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Buckets on a Server (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let serverId: string;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execRemote: jest.fn(),
  };
  const docker = {
    getService: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn(),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn().mockResolvedValue([{ Status: { State: 'running' } }]),
    getSecret: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such secret')),
    })),
    createSecret: jest.fn().mockResolvedValue({ id: 'secret-1' }),
  };
  const getRemoteDocker = jest.fn().mockResolvedValue(docker);

  /** Every shell program and command the Server was asked to run. */
  const ranOnServer = () =>
    execMock.execAsyncRemote.mock.calls.map(
      ([onServer, command]: [string, string]) => ({ onServer, command }),
    );

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: { getRemoteDocker } },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    execMock.execAsyncRemote.mockImplementation(
      (_serverId: string, command: string) => {
        if (isPresenceProbe(command)) {
          return Promise.resolve({ stdout: 'absent', stderr: '' });
        }
        if (command.includes('garage key create')) {
          return Promise.resolve({
            stdout: `CLOUDGATE_KEY_ID=${KEY_ID}\nCLOUDGATE_SECRET_KEY=${SECRET_KEY}\n`,
            stderr: '',
          });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    );
    execMock.execAsync.mockResolvedValue({ stdout: '', stderr: '' });
    // Argv on a Server is the string half, worded as the service words it.
    execMock.execRemote.mockImplementation(
      (onServer: string, argv: string[]) =>
        execMock.execAsyncRemote(onServer, argv.join(' ')) as unknown,
    );

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

    const [worker] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'storage-box',
        ipAddress: '203.0.113.20',
        port: 22,
        serverType: 'deploy',
        organizationId,
      })
      .returning();
    serverId = worker.serverId;

    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

    const environment = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId,
        deployTarget: { kind: 'server', serverId },
      });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;
  });

  const save = (text: string) =>
    request(httpServer)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  async function planFor(text: string): Promise<PlanBody> {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    const found = (saved.body as { plans: PlanBody[] }).plans.find(
      (one) => one.environmentId === environmentId,
    );
    expect(found).toBeDefined();
    return found as PlanBody;
  }

  const apply = (planId: string, confirmDestroy: string[] = []) =>
    request(httpServer)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, confirmDestroy });

  const UPLOADS = `version: 1
services:
  uploads:
    kind: bucket
    description: Product photos
`;

  /** Plans and applies UPLOADS, and waits for its deploy to settle. */
  async function applyUploads() {
    const open = await planFor(UPLOADS);
    const applied = await apply(open.planId);
    expect(applied.status).toBe(200);
    const [result] = (applied.body as PlanBody).results ?? [];
    await waitFor(async () => {
      const [row] = await ctx.db
        .select({ status: bucket.applicationStatus })
        .from(bucket)
        .where(eq(bucket.bucketId, result.serviceId ?? ''));
      return row?.status === 'done' || row?.status === 'error';
    });
    const [row] = await ctx.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, result.serviceId ?? ''));
    return { open, applied: applied.body as PlanBody, row };
  }

  describe('planning', () => {
    it("shows a bucket's create on the Server with the real name Cloudgate minted", async () => {
      const open = await planFor(UPLOADS);

      expect(open.status).toBe('open');
      expect(open.steps).toEqual([
        {
          action: 'create',
          configName: 'uploads',
          kind: 'bucket',
          placement: { kind: 'server', serverId },
          fields: [{ field: 'description', from: null, to: 'Product photos' }],
          bucket: {
            name: expect.stringMatching(/^uploads-[a-z0-9]{8}$/) as string,
          },
        },
      ]);
    });

    it('refuses a bucket with any field but kind and description, naming it', async () => {
      const saved = await save(
        'version: 1\nservices:\n  uploads:\n    kind: bucket\n    size: small\n',
      );

      expect(saved.status).toBe(409);
      expect(saved.body).toMatchObject({
        code: 'PLAN_REFUSED',
        message: expect.stringContaining(
          'uploads.size: it is not a field Cloudgate knows',
        ) as string,
      });
    });
  });

  describe('applying', () => {
    it('runs Garage on the Server with its own volume, then makes the bucket and a read-write key', async () => {
      const { open, applied, row } = await applyUploads();
      const minted = (open.steps[0].bucket as { name: string }).name;

      expect(applied.status).toBe('applied');
      expect(applied.results).toEqual([
        expect.objectContaining({
          configName: 'uploads',
          action: 'create',
          status: 'applied',
          serviceType: 'bucket',
          deploy: { status: 'started' },
        }),
      ]);
      expect(row).toMatchObject({
        configName: 'uploads',
        description: 'Product photos',
        bucketName: minted,
        serverId,
        volumeName: `${row.appName}-data`,
        configPlanId: open.planId,
        applicationStatus: 'done',
        accessKeyId: KEY_ID,
        secretAccessKey: SECRET_KEY,
      });

      // The Docker daemon of the bucket's own Server.
      expect(getRemoteDocker).toHaveBeenCalledWith(serverId);
      expect(docker.createSecret).toHaveBeenCalledWith({
        Name: `${row.appName}-garage-config`,
        Data: expect.any(String) as string,
      });
      const [secret] = docker.createSecret.mock.calls[0] as [{ Data: string }];
      const toml = Buffer.from(secret.Data, 'base64').toString();
      expect(toml).toContain('s3_region = "us-east-1"');
      expect(toml).toContain('replication_factor = 1');

      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [spec] = docker.createService.mock.calls[0] as [
        {
          Name: string;
          TaskTemplate: {
            ContainerSpec: {
              Image: string;
              Mounts: unknown[];
              Secrets: unknown[];
            };
          };
        },
      ];
      expect(spec.Name).toBe(row.appName);
      expect(spec.TaskTemplate.ContainerSpec.Image).toBe(
        'dxflrs/garage:v2.1.0',
      );
      expect(spec.TaskTemplate.ContainerSpec.Mounts).toEqual([
        {
          Type: 'volume',
          Source: `${row.appName}-data`,
          Target: '/var/lib/garage',
        },
      ]);
      expect(spec.TaskTemplate.ContainerSpec.Secrets).toEqual([
        expect.objectContaining({
          SecretID: 'secret-1',
          File: expect.objectContaining({ Name: '/etc/garage.toml' }) as object,
        }),
      ]);

      // The bucket and its key, through the garage CLI in the running task,
      // on the bucket's Server; the key never owner. Then its CORS, set to
      // no origin (`bucket-origins.e2e-spec.ts`).
      const programs = ranOnServer().filter(({ command }) =>
        command.includes('garage() {'),
      );
      expect(programs.map(({ onServer }) => onServer)).toEqual([
        serverId,
        serverId,
        serverId,
      ]);
      expect(programs[0].command).toContain(`garage bucket create ${minted}`);
      expect(programs[1].command).toContain(
        `garage bucket allow --read --write ${minted} --key "$KEY_ID"`,
      );
      for (const { command } of programs.slice(0, 2)) {
        expect(command).not.toContain('--owner');
        expect(command).not.toContain(SECRET_KEY);
      }
      expect(programs[2].command).toContain(`/${minted}\\?cors`);
      expect(programs[2].command).not.toContain(SECRET_KEY);
    });

    it('stores the key and the admin credential encrypted, and reads the key back only as set', async () => {
      const { row } = await applyUploads();

      const raw = await ctx.db.execute<{
        access_key_id: string;
        secret_access_key: string;
        admin_credential: string;
      }>(
        sql`select access_key_id, secret_access_key, admin_credential from bucket where bucket_id = ${row.bucketId}`,
      );
      for (const value of Object.values(raw.rows[0])) {
        expect(value).toMatch(/^enc:v1:/);
      }

      const read = await request(httpServer)
        .get(`/buckets/${row.bucketId}`)
        .set('Cookie', cookie);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        bucketId: row.bucketId,
        configName: 'uploads',
        bucketName: row.bucketName,
        region: 'us-east-1',
        place: { kind: 'server', serverId, serverName: 'storage-box' },
        hasKey: true,
        applicationStatus: 'done',
      });
      const said = JSON.stringify(read.body);
      expect(said).not.toContain(SECRET_KEY);
      expect(said).not.toContain(KEY_ID);
      expect(said).not.toContain(row.adminCredential.adminToken);
      expect(read.body).not.toHaveProperty('secretAccessKey');
      expect(read.body).not.toHaveProperty('adminCredential');
    });

    it("lists the bucket in its Environment's Services", async () => {
      const { row } = await applyUploads();

      const read = await request(httpServer)
        .get(`/environments/${environmentId}`)
        .set('Cookie', cookie);
      expect(read.status).toBe(200);
      expect(
        (read.body as { services: Array<Record<string, unknown>> }).services,
      ).toEqual([
        expect.objectContaining({
          serviceType: 'bucket',
          serviceId: row.bucketId,
          configName: 'uploads',
          description: 'Product photos',
          status: 'done',
          serverId,
        }),
      ]);
    });

    it('writes its native.docker labels to the bucket, runs Garage with them, plans nothing next, and redeploys Garage without them once removed', async () => {
      const LABELLED = `${UPLOADS}    native:
      docker:
        Labels:
          com.example.backup: nightly
`;
      const garageSpecs = () =>
        docker.createService.mock.calls.map(
          ([spec]) =>
            spec as {
              TaskTemplate: { ContainerSpec: { Labels?: unknown } };
              UpdateConfig: unknown;
            },
        );
      const labelsOf = async (bucketId: string) =>
        (
          await ctx.db
            .select({ labelsSwarm: bucket.labelsSwarm })
            .from(bucket)
            .where(eq(bucket.bucketId, bucketId))
        )[0].labelsSwarm;

      const open = await planFor(LABELLED);
      expect(open.steps[0].fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'native.docker.Labels."com.example.backup"',
            to: 'nightly',
            native: true,
          }),
        ]),
      );
      const applied = await apply(open.planId);
      expect(applied.status).toBe(200);
      const [result] = (applied.body as PlanBody).results ?? [];
      const bucketId = result.serviceId ?? '';
      expect(await labelsOf(bucketId)).toEqual({
        'com.example.backup': 'nightly',
      });
      const deployed = async () => {
        const [row] = await ctx.db
          .select({ status: bucket.applicationStatus })
          .from(bucket)
          .where(eq(bucket.bucketId, bucketId));
        return row?.status === 'done';
      };
      await waitFor(deployed);
      expect(docker.createService).toHaveBeenCalledTimes(1);
      expect(garageSpecs()[0].TaskTemplate.ContainerSpec.Labels).toEqual({
        'com.example.backup': 'nightly',
      });
      // Its Garage's other Swarm settings stay Cloudgate's.
      expect(garageSpecs()[0].UpdateConfig).toEqual({
        Parallelism: 1,
        Order: 'stop-first',
        FailureAction: 'rollback',
      });
      expect((await planFor(LABELLED)).steps).toEqual([]);

      const removed = await planFor(UPLOADS);
      expect(removed.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          fields: [
            expect.objectContaining({
              field: 'native.docker.Labels."com.example.backup"',
              from: 'nightly',
              to: null,
              toDefault: true,
            }),
          ],
        }),
      ]);
      const again = await apply(removed.planId);
      expect(again.status).toBe(200);
      expect((again.body as PlanBody).results).toEqual([
        expect.objectContaining({ deploy: { status: 'started' } }),
      ]);
      expect(await labelsOf(bucketId)).toBeNull();
      await waitFor(
        async () =>
          docker.createService.mock.calls.length === 2 && (await deployed()),
      );
      expect(
        garageSpecs()[1].TaskTemplate.ContainerSpec.Labels,
      ).toBeUndefined();
      expect((await planFor(UPLOADS)).steps).toEqual([]);
    });

    it('refuses a bucket’s stop grace by its full path with the reason', async () => {
      const saved = await save(
        `${UPLOADS}    native:\n      docker:\n        StopGracePeriod: 1000000000\n`,
      );
      expect(saved.status).toBe(409);
      expect(JSON.stringify(saved.body)).toContain(
        "uploads.native.docker.StopGracePeriod: refused - Garage gets the database's 30 s to flush its files",
      );
    });

    it('plans a rename as a destroy and a create noting the files are not copied, and the destroy removes Garage, its secret and its volume', async () => {
      const { row } = await applyUploads();
      execMock.execAsyncRemote.mockClear();

      const open = await planFor(
        'version: 1\nservices:\n  photos:\n    kind: bucket\n',
      );
      expect(open.steps.map((step) => [step.action, step.configName])).toEqual([
        ['create', 'photos'],
        ['destroy', 'uploads'],
      ]);
      expect(open.notes).toEqual([
        {
          kind: 'files-not-copied',
          configName: 'uploads',
          message:
            'uploads: the bucket is destroyed and its files are not copied; a bucket renamed or given another kind is a new, empty one',
        },
      ]);

      const applied = await apply(open.planId, ['uploads']);
      expect(applied.status).toBe(200);
      expect(
        (applied.body as PlanBody).results?.map((result) => [
          result.configName,
          result.action,
          result.status,
        ]),
      ).toEqual([
        ['photos', 'create', 'applied'],
        ['uploads', 'destroy', 'applied'],
      ]);
      const commands = ranOnServer().map(({ command }) => command);
      expect(commands).toEqual(
        expect.arrayContaining([
          `docker service rm ${row.appName}`,
          `docker secret rm ${row.appName}-garage-config`,
          `docker volume rm ${row.appName}-data --force`,
        ]),
      );
      const left = await ctx.db.select().from(bucket);
      expect(left.map((one) => one.configName)).toEqual(['photos']);
      expect(left[0].bucketName).not.toBe(row.bucketName);
    });
  });

  describe('an Agent', () => {
    function callTool(
      key: string,
      name: string,
      args: Record<string, unknown>,
    ) {
      return request(httpServer)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${key}`)
        .set('MCP-Protocol-Version', '2025-06-18')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name, arguments: args },
        });
    }

    function payloadOf(res: request.Response): Record<string, unknown> {
      expect(res.status).toBe(200);
      const result = (res.body as { result: ToolResult }).result;
      expect(result.isError).toBeFalsy();
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    }

    it('lists and reads a bucket as any Service, its key only as set, and holds no statement that applies a plan', async () => {
      const { row } = await applyUploads();
      const created = await request(httpServer)
        .post('/agents')
        .set('Cookie', cookie)
        .send({
          name: 'storage-bot',
          role: 'agentOperator',
          grant: {
            accessedProjects: [projectId],
            accessedEnvironments: [environmentId],
            accessedServices: [row.bucketId],
          },
        });
      expect(created.status).toBe(201);
      const agent = created.body as { agent: { id: string }; key: string };

      const environment = payloadOf(
        await callTool(agent.key, 'get_environment', { environmentId }),
      );
      expect(JSON.stringify(environment)).toContain(row.bucketId);

      const read = payloadOf(
        await callTool(agent.key, 'get_service', {
          serviceType: 'bucket',
          serviceId: row.bucketId,
        }),
      );
      expect(read).toMatchObject({
        serviceType: 'bucket',
        serviceId: row.bucketId,
        configName: 'uploads',
        status: 'done',
        bucketName: row.bucketName,
        hasKey: true,
      });
      expect(JSON.stringify(read)).not.toContain(SECRET_KEY);

      // An Apply needs service: create on the Project, which no Agent role
      // holds.
      await expect(
        ctx.app.get(PermissionService).checkServiceAccess(
          {
            user: { id: agent.agent.id },
            session: { activeOrganizationId: organizationId },
          },
          projectId,
          'create',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
