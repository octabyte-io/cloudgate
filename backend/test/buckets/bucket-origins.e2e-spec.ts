import { ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { BucketsService } from '../../src/buckets/buckets.service';
import {
  auditLog,
  bucket,
  licenseKey,
  member,
  organizationRole,
  server as serverTable,
} from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { PermissionService } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * A bucket's browser-upload origins on a Server, through the HTTP
 * API: per bucket and per Environment, empty by default, Cloudgate's and
 * never the config's, set on the Garage bucket's CORS through Cloudgate's
 * admin access to its container — a key made for the one request and owner
 * on the bucket — never through the bucket's own read-write key. The Server
 * (its shell) and its Docker daemon are the doubles; words and names are
 * written out here, never imported (§1.7).
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** What the key program prints once Garage made the bucket's key. */
const KEY_ID = 'GK3a1f0c9e2b7d4c6a8e1f0b2d';
const SECRET_KEY =
  '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';

const UPLOADS = `version: 1
services:
  uploads:
    kind: bucket
    description: Product photos
`;

interface PlanBody {
  planId: string;
  environmentId: string;
  results: Array<{ serviceId: string | null }> | null;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Bucket browser-upload origins (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let serverId: string;
  let production: string;
  let staging: string;

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

  /** The CORS programs the Server was asked to run, in order. */
  const corsPrograms = () =>
    execMock.execAsyncRemote.mock.calls
      .map(([onServer, command]: [string, string]) => ({ onServer, command }))
      .filter(({ command }) => command.includes('?cors'));

  /** The request line of a CORS program: the curl it sends. */
  const sent = (command: string) => command.split('\n').at(-1) ?? '';

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn().mockResolvedValue(docker) },
        },
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
        if (command.includes('garage bucket allow --read --write')) {
          return Promise.resolve({
            stdout: `CLOUDGATE_KEY_ID=${KEY_ID}\nCLOUDGATE_SECRET_KEY=${SECRET_KEY}\n`,
            stderr: '',
          });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    );
    execMock.execAsync.mockResolvedValue({ stdout: '', stderr: '' });
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

    const environmentOn = async (name: string) => {
      const made = await request(httpServer)
        .post('/environments')
        .set('Cookie', cookie)
        .send({
          name,
          projectId,
          deployTarget: { kind: 'server', serverId },
        });
      expect(made.status).toBe(201);
      return (made.body as { environmentId: string }).environmentId;
    };
    production = await environmentOn('production');
    staging = await environmentOn('staging');
  });

  /** Applies UPLOADS in every Environment; each one's bucket id, deployed. */
  async function applyUploads(): Promise<Record<string, string>> {
    const saved = await request(httpServer)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: UPLOADS });
    expect(saved.status).toBe(201);
    const ids: Record<string, string> = {};
    for (const plan of (saved.body as { plans: PlanBody[] }).plans) {
      if (plan.environmentId !== production && plan.environmentId !== staging) {
        continue;
      }
      const applied = await request(httpServer)
        .post(`/environments/${plan.environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: plan.planId, confirmDestroy: [] });
      expect(applied.status).toBe(200);
      const bucketId = (applied.body as PlanBody).results?.[0]?.serviceId;
      expect(bucketId).toEqual(expect.any(String));
      ids[plan.environmentId] = bucketId as string;
    }
    for (const bucketId of Object.values(ids)) {
      await waitFor(async () => {
        const [row] = await ctx.db
          .select({ status: bucket.applicationStatus })
          .from(bucket)
          .where(eq(bucket.bucketId, bucketId));
        return row?.status === 'done' || row?.status === 'error';
      });
    }
    return ids;
  }

  const putOrigins = (bucketId: string, origins: unknown, as = cookie) =>
    request(httpServer)
      .put(`/buckets/${bucketId}/origins`)
      .set('Cookie', as)
      .send({ origins });

  const storedOrigins = async (bucketId: string) => {
    const [row] = await ctx.db
      .select({ origins: bucket.origins })
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    return row.origins;
  };

  it('gives a new bucket no origin, and its Garage CORS allows none', async () => {
    const ids = await applyUploads();
    const bucketId = ids[production];

    const read = await request(httpServer)
      .get(`/buckets/${bucketId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ origins: [], applicationStatus: 'done' });

    // The deploy cleared the bucket's CORS: no origin is allowed.
    const [row] = await ctx.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    const deployed = corsPrograms().filter(({ command }) =>
      command.includes(`/${row.bucketName}\\?cors`),
    );
    expect(deployed).toHaveLength(1);
    expect(deployed[0].onServer).toBe(serverId);
    expect(sent(deployed[0].command)).toContain(
      `-X DELETE http\\://127.0.0.1\\:3900/${row.bucketName}\\?cors`,
    );
    expect(deployed[0].command).not.toContain('CORSConfiguration');
  });

  it("sets one Environment's origins on its own bucket's Garage through the admin access, never the bucket's key", async () => {
    const ids = await applyUploads();
    const [prod] = await ctx.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, ids[production]));
    execMock.execAsyncRemote.mockClear();

    const added = await putOrigins(prod.bucketId, [
      'https://shop.example.com',
      'http://localhost:3000',
    ]);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      bucketId: prod.bucketId,
      origins: ['https://shop.example.com', 'http://localhost:3000'],
    });
    expect(await storedOrigins(prod.bucketId)).toEqual([
      'https://shop.example.com',
      'http://localhost:3000',
    ]);
    // Staging's bucket keeps its own list.
    expect(await storedOrigins(ids[staging])).toEqual([]);

    const [put] = corsPrograms();
    expect(corsPrograms()).toHaveLength(1);
    expect(put.onServer).toBe(serverId);
    expect(put.command).toContain(
      `CONTAINER_ID=$(docker ps -q --filter status=running --filter label\\=com.docker.swarm.service.name\\=${prod.appName} | head -n 1)`,
    );
    expect(put.command).toContain(`garage key create ${prod.appName}-cors`);
    expect(put.command).toContain(
      `garage bucket allow --owner ${prod.bucketName} --key "$KEY_ID"`,
    );
    expect(put.command).toContain(
      `trap 'garage key delete --yes "$KEY_ID" >/dev/null 2>&1 || true' EXIT`,
    );
    expect(sent(put.command)).toContain(
      `-X PUT --data-binary \\<CORSConfiguration\\>\\<CORSRule\\>\\<AllowedOrigin\\>https\\://shop.example.com\\</AllowedOrigin\\>`,
    );
    expect(sent(put.command)).toContain(
      '\\<AllowedOrigin\\>http\\://localhost\\:3000\\</AllowedOrigin\\>',
    );
    expect(sent(put.command)).toContain(
      `http\\://127.0.0.1\\:3900/${prod.bucketName}\\?cors`,
    );
    // The bucket's own key is never what sets it.
    expect(put.command).not.toContain(KEY_ID);
    expect(put.command).not.toContain(SECRET_KEY);

    // Removing one sends the list as it now stands.
    execMock.execAsyncRemote.mockClear();
    const removed = await putOrigins(prod.bucketId, ['http://localhost:3000']);
    expect(removed.status).toBe(200);
    expect(await storedOrigins(prod.bucketId)).toEqual([
      'http://localhost:3000',
    ]);
    expect(sent(corsPrograms()[0].command)).not.toContain('shop.example.com');

    // Removing the last one clears the bucket's CORS.
    execMock.execAsyncRemote.mockClear();
    expect((await putOrigins(prod.bucketId, [])).status).toBe(200);
    expect(await storedOrigins(prod.bucketId)).toEqual([]);
    expect(sent(corsPrograms()[0].command)).toContain('-X DELETE');

    const audited = await ctx.db
      .select({ action: auditLog.action, resourceId: auditLog.resourceId })
      .from(auditLog)
      .where(eq(auditLog.resourceType, 'bucket'));
    expect(audited).toEqual(
      Array.from({ length: 3 }, () => ({
        action: 'update',
        resourceId: prod.bucketId,
      })),
    );
  });

  it('refuses a malformed origin, naming it, and changes nothing', async () => {
    const ids = await applyUploads();
    execMock.execAsyncRemote.mockClear();

    for (const origin of [
      'shop.example.com',
      'https://shop.example.com/',
      'https://shop.example.com/uploads',
      'https://*.example.com',
    ]) {
      const res = await putOrigins(ids[production], [
        'https://ok.example.com',
        origin,
      ]);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        `"${origin}" is not a web origin — write it as a browser sends it, scheme://host or scheme://host:port, with no path`,
      );
    }
    expect((await putOrigins(ids[production], 'https://a.com')).status).toBe(
      400,
    );
    expect(await storedOrigins(ids[production])).toEqual([]);
    expect(corsPrograms()).toEqual([]);
  });

  it('saves nothing when Garage cannot be reached to take the origins', async () => {
    const ids = await applyUploads();
    execMock.execAsyncRemote.mockImplementation(
      (_serverId: string, command: string) =>
        command.includes('?cors')
          ? Promise.reject(new Error('no running task'))
          : Promise.resolve({ stdout: '', stderr: '' }),
    );
    const [row] = await ctx.db
      .select({ bucketName: bucket.bucketName })
      .from(bucket)
      .where(eq(bucket.bucketId, ids[production]));

    const res = await putOrigins(ids[production], ['https://shop.example.com']);
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(
      `Cloudgate could not set the origins on bucket ${row.bucketName}, so they were not saved — try again once its Garage is running`,
    );
    expect(await storedOrigins(ids[production])).toEqual([]);
  });

  it('saves the origins of a bucket not yet deployed, and its deploy sets them', async () => {
    const ids = await applyUploads();
    await ctx.db
      .update(bucket)
      .set({ applicationStatus: 'error' })
      .where(eq(bucket.bucketId, ids[production]));
    execMock.execAsyncRemote.mockClear();

    const res = await putOrigins(ids[production], ['https://shop.example.com']);
    expect(res.status).toBe(200);
    expect(await storedOrigins(ids[production])).toEqual([
      'https://shop.example.com',
    ]);
    expect(corsPrograms()).toEqual([]);

    await ctx.app.get(BucketsService).deploy(ids[production]);
    const [deployed] = corsPrograms();
    expect(sent(deployed.command)).toContain(
      '\\<AllowedOrigin\\>https\\://shop.example.com\\</AllowedOrigin\\>',
    );
  });

  it('refuses a Member whose role lacks service update, and an Agent', async () => {
    const ids = await applyUploads();
    const bucketId = ids[production];

    const ida = await signUpMember(httpServer, cookie);
    await ctx.db.insert(licenseKey).values({
      organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values({
      organizationId,
      role: 'reader',
      permission: { service: ['read'] },
    });
    await ctx.db
      .update(member)
      .set({ role: 'reader', accessedServices: [bucketId] })
      .where(
        and(
          eq(member.userId, ida.id),
          eq(member.organizationId, organizationId),
        ),
      );
    execMock.execAsyncRemote.mockClear();

    const refused = await putOrigins(
      bucketId,
      ['https://shop.example.com'],
      ida.cookie,
    );
    expect(refused.status).toBe(403);
    const read = await request(httpServer)
      .get(`/buckets/${bucketId}`)
      .set('Cookie', ida.cookie);
    expect(read.status).toBe(200);

    // Every Agent role holds service read or call, never update.
    const created = await request(httpServer)
      .post('/agents')
      .set('Cookie', cookie)
      .send({
        name: 'storage-bot',
        role: 'agentOperator',
        grant: {
          accessedProjects: [projectId],
          accessedEnvironments: [production],
          accessedServices: [bucketId],
        },
      });
    expect(created.status).toBe(201);
    const agent = (created.body as { agent: { id: string } }).agent;
    const agentCtx = {
      user: { id: agent.id },
      session: { activeOrganizationId: organizationId },
    };
    await expect(
      ctx.app
        .get(PermissionService)
        .checkServiceAccess(agentCtx, bucketId, 'update'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      ctx.app
        .get(BucketsService)
        .updateOrigins(agentCtx, bucketId, ['https://shop.example.com']),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(await storedOrigins(bucketId)).toEqual([]);
    expect(corsPrograms()).toEqual([]);
  });
});
