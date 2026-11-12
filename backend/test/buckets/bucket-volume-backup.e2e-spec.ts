import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { bucket, server as serverTable } from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * A Bucket's volume backed up by the existing volume backup: off until
 * an operator sets one on the bucket, then run through the same route, the same
 * tar-then-rclone script and the same rights as a volume backup of any other
 * Service. The bucket is applied from a Project config onto a Server whose
 * shell and Docker daemon are the doubles; words and names are written out
 * here, never imported (§1.7).
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCESS_KEY = 'AKIAEXAMPLEACCESSKEY';
const SECRET = 'wJalrXUtnFEMI-example-secret-key';

const UPLOADS = `version: 1
services:
  uploads:
    kind: bucket
    description: Product photos
`;

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("A bucket's volume backup (e2e)", () => {
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

  /** The commands the Server was asked to run, with the env each carried. */
  const ranOnServer = () =>
    execMock.execAsyncRemote.mock.calls.map(
      ([onServer, command, , options]: [
        string,
        string,
        unknown,
        { env?: Record<string, string> } | undefined,
      ]) => ({ onServer, command, env: options?.env }),
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
            stdout:
              'CLOUDGATE_KEY_ID=GK3a1f0c9e2b7d4c6a8e1f0b2d\nCLOUDGATE_SECRET_KEY=9f8e7d6c5b4a39281706f5e4d3c2b1a0\n',
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

  /** Plans and applies UPLOADS and waits for its deploy to settle. */
  async function applyUploads() {
    const saved = await request(httpServer)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: UPLOADS });
    expect(saved.status).toBe(201);
    const plan = (
      saved.body as { plans: Array<{ planId: string; environmentId: string }> }
    ).plans.find((one) => one.environmentId === environmentId);
    const applied = await request(httpServer)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: plan?.planId, confirmDestroy: [] });
    expect(applied.status).toBe(200);
    const [result] = (applied.body as { results: Array<{ serviceId: string }> })
      .results;
    await waitFor(async () => {
      const [row] = await ctx.db
        .select({ status: bucket.applicationStatus })
        .from(bucket)
        .where(eq(bucket.bucketId, result.serviceId));
      return row?.status === 'done' || row?.status === 'error';
    });
    const [row] = await ctx.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, result.serviceId));
    return row;
  }

  async function createDestination(as = cookie) {
    const res = await request(httpServer)
      .post('/destinations')
      .set('Cookie', as)
      .send({
        name: 'prod-backups',
        provider: 'Cloudflare',
        accessKey: ACCESS_KEY,
        secretAccessKey: SECRET,
        bucket: 'cloudgate-backups',
        region: 'auto',
        endpoint: 'https://accountid.r2.cloudflarestorage.com',
      });
    expect(res.status).toBe(201);
    return (res.body as { destinationId: string }).destinationId;
  }

  const listBackups = (bucketId: string, as = cookie) =>
    request(httpServer)
      .get('/volume-backups')
      .query({ serviceId: bucketId, serviceType: 'bucket' })
      .set('Cookie', as);

  it('has no volume backup when the plan makes it', async () => {
    const row = await applyUploads();

    const listed = await listBackups(row.bucketId);

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
  });

  it("names the bucket's own volume on its read", async () => {
    const row = await applyUploads();

    const read = await request(httpServer)
      .get(`/buckets/${row.bucketId}`)
      .set('Cookie', cookie);

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ volumeName: `${row.appName}-data` });
  });

  it("backs up the bucket's volume on its Server through the existing volume-backup run", async () => {
    const row = await applyUploads();
    const destinationId = await createDestination();

    const created = await request(httpServer)
      .post('/volume-backups')
      .set('Cookie', cookie)
      .send({
        name: 'Nightly uploads',
        volumeName: `${row.appName}-data`,
        prefix: 'nightly',
        schedule: '0 3 * * *',
        serviceType: 'bucket',
        serviceId: row.bucketId,
        destinationId,
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      serviceType: 'bucket',
      bucketId: row.bucketId,
      volumeName: `${row.appName}-data`,
      turnOff: false,
    });
    const { volumeBackupId } = created.body as { volumeBackupId: string };

    const listed = await listBackups(row.bucketId);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ volumeBackupId, bucketId: row.bucketId }),
    ]);

    execMock.execAsyncRemote.mockClear();
    const ran = await request(httpServer)
      .post(`/volume-backups/${volumeBackupId}/run`)
      .set('Cookie', cookie);
    expect(ran.status).toBeLessThan(300);

    // The tar runs on the bucket's own Server, against its volume, and the
    // tarball lands under the bucket's appName in the destination.
    const script = ranOnServer().find(({ command }) =>
      command.includes('rclone copyto'),
    );
    expect(script).toBeDefined();
    expect(script?.onServer).toBe(serverId);
    expect(script?.command).toContain(`-v ${row.appName}-data\\:/volume_data`);
    expect(script?.command).toContain(
      `\\:s3\\:cloudgate-backups/${row.appName}/nightly/${row.appName}-data-`,
    );
    expect(script?.command).not.toContain(SECRET);
    expect(script?.env).toMatchObject({
      RCLONE_S3_ACCESS_KEY_ID: ACCESS_KEY,
      RCLONE_S3_SECRET_ACCESS_KEY: SECRET,
    });

    const runs = await request(httpServer)
      .get(`/volume-backups/${volumeBackupId}/deployments`)
      .set('Cookie', cookie);
    expect(runs.status).toBe(200);
    expect(runs.body).toEqual([expect.objectContaining({ status: 'done' })]);
  });

  it("stops the bucket's Garage while the tar runs when asked to, and starts it again", async () => {
    const row = await applyUploads();
    const destinationId = await createDestination();
    execMock.execAsyncRemote.mockImplementation(
      (_serverId: string, command: string) =>
        Promise.resolve({
          stdout: command.includes('docker service inspect') ? '1' : '',
          stderr: '',
        }),
    );

    const created = await request(httpServer)
      .post('/volume-backups')
      .set('Cookie', cookie)
      .send({
        name: 'Quiet uploads',
        volumeName: `${row.appName}-data`,
        prefix: 'nightly',
        schedule: '0 3 * * *',
        serviceType: 'bucket',
        serviceId: row.bucketId,
        turnOff: true,
        destinationId,
      });
    expect(created.status).toBe(201);
    const { volumeBackupId } = created.body as { volumeBackupId: string };

    const ran = await request(httpServer)
      .post(`/volume-backups/${volumeBackupId}/run`)
      .set('Cookie', cookie);
    expect(ran.status).toBeLessThan(300);

    const script = ranOnServer().find(({ command }) =>
      command.includes('rclone copyto'),
    );
    expect(script?.command).toContain(
      `docker service update --replicas=0 ${row.appName}`,
    );
    expect(script?.command).toContain(
      `docker service update --replicas="$ACTUAL_REPLICAS" --with-registry-auth ${row.appName}`,
    );
    expect(script?.command).toContain('Stopping bucket to 0 replicas');
  });

  it("restores the bucket's volume from its backup on its Server, stopping its Garage for the restore and starting it again", async () => {
    const row = await applyUploads();
    const destinationId = await createDestination();
    execMock.execAsyncRemote.mockClear();

    const restored = await request(httpServer)
      .post('/volume-backups/restore')
      .set('Cookie', cookie)
      .send({
        serviceType: 'bucket',
        serviceId: row.bucketId,
        volumeName: `${row.appName}-data`,
        backupFileName: `${row.appName}/nightly/${row.appName}-data-2026-10-17T03-00-00-000Z.tar`,
        destinationId,
      });

    expect(restored.status).toBe(204);
    const script = ranOnServer().find(({ command }) =>
      command.includes('VOLUME RESTORE FOR BUCKET'),
    );
    expect(script?.onServer).toBe(serverId);
    expect(script?.command).toContain(
      `docker service update --replicas=0 ${row.appName}`,
    );
    expect(script?.command).toContain('trap restore_workload EXIT');
    expect(script?.command).toContain(
      `docker service update --replicas="$ACTUAL_REPLICAS" --with-registry-auth ${row.appName}`,
    );
    expect(script?.command).toContain(
      `\\:s3\\:cloudgate-backups/${row.appName}/nightly/${row.appName}-data-2026-10-17T03-00-00-000Z.tar`,
    );
    expect(script?.command).not.toContain(SECRET);
  });

  it('refuses a member the bucket was never shared with, as on any other Service', async () => {
    const row = await applyUploads();
    const destinationId = await createDestination();

    const invite = await request(httpServer)
      .post('/organizations/invitations')
      .set('Cookie', cookie)
      .send({ email: 'ida@example.com', role: 'member' });
    const inviteId = (invite.body as { id: string }).id;
    const signedUp = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({
        name: 'Ida Rhodes',
        email: 'ida@example.com',
        password: 'super-secret-password',
      });
    const memberCookie = (signedUp.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const accepted = await request(httpServer)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', memberCookie);
    expect(accepted.status).toBe(201);

    const refused = await request(httpServer)
      .post('/volume-backups')
      .set('Cookie', memberCookie)
      .send({
        name: 'Not mine',
        volumeName: `${row.appName}-data`,
        prefix: 'nightly',
        schedule: '0 3 * * *',
        serviceType: 'bucket',
        serviceId: row.bucketId,
        destinationId,
      });

    expect(refused.status).toBe(403);
    expect((await listBackups(row.bucketId)).body).toEqual([]);
  });
});
