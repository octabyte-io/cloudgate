import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { bucket, server as serverTable } from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { PermissionService } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { FAKE_GARAGE_ENDPOINT } from '../utils/fake-object-storage';
import type { FakeEntryKind } from '../utils/fake-object-storage';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Deleting a bucket on a Server never loses a user's files by accident
 * (, the **Delete** entry in `CONTEXT.md`), through the HTTP API: a
 * bucket that holds files is kept — its volume stays — and named once as
 * left behind; an empty one loses its Garage and its volume; "also delete its
 * files" empties it first. The bucket's files are the object-storage port's
 * in-memory fake (`ctx.objectStorage`); the Server (its shell) and its Docker
 * daemon are the doubles. Words and names are written out here (§1.7).
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const KEY_ID = 'GK3a1f0c9e2b7d4c6a8e1f0b2d';
const SECRET_KEY =
  '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';

interface PlanBody {
  planId: string;
  environmentId: string;
  steps: Array<Record<string, unknown>>;
  results: Array<{
    configName: string;
    action: string;
    status: string;
    message: string | null;
    serviceId: string | null;
    leftovers: Record<string, unknown> | null;
  }> | null;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Deleting a bucket on a Server (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let cookie: string;
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

  /** Every command the Server was asked to run, as one string each. */
  const ranOnServer = (): string[] =>
    execMock.execAsyncRemote.mock.calls.map(
      ([, command]: [string, string]) => command,
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
    jest.restoreAllMocks();
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
    const organizationId = (orgs.body as { id: string }[])[0].id;

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

  async function planFor(text: string): Promise<PlanBody> {
    const saved = await request(httpServer)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    return (saved.body as { plans: PlanBody[] }).plans.find(
      (one) => one.environmentId === environmentId,
    ) as PlanBody;
  }

  const apply = (
    planId: string,
    confirmDestroy: string[] = [],
    deleteFilesOf?: string[],
  ) =>
    request(httpServer)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({
        planId,
        confirmDestroy,
        ...(deleteFilesOf ? { deleteFilesOf } : {}),
      });

  const TWO_BUCKETS = `version: 1
services:
  uploads:
    kind: bucket
  avatars:
    kind: bucket
`;
  const NO_SERVICES = 'version: 1\nservices: {}\n';

  /** Plans and applies `text`, and waits until each bucket is deployed. */
  async function applyBuckets(text = TWO_BUCKETS) {
    const open = await planFor(text);
    const applied = await apply(open.planId);
    expect(applied.status).toBe(200);
    await waitFor(async () => {
      const rows = await ctx.db.select().from(bucket);
      return rows.every((row) => row.applicationStatus === 'done');
    });
    const rows = await ctx.db.select().from(bucket);
    const byName = (configName: string) => {
      const found = rows.find((row) => row.configName === configName);
      if (!found) throw new Error(`no bucket ${configName}`);
      return found;
    };
    return { byName };
  }

  const deleteBucket = (bucketId: string, query = '') =>
    request(httpServer)
      .delete(`/buckets/${bucketId}${query}`)
      .set('Cookie', cookie);

  const volumeRemoved = (volumeName: string) =>
    ranOnServer().includes(`docker volume rm ${volumeName} --force`);

  describe("a bucket Service's own Delete", () => {
    it.each<[string, FakeEntryKind]>([
      ['an object', 'object'],
      ['an old version', 'version'],
      ['only a delete marker', 'delete-marker'],
    ])(
      'keeps a bucket that holds %s, its volume named once as left behind',
      async (_what, kind) => {
        const { byName } = await applyBuckets();
        const uploads = byName('uploads');
        ctx.objectStorage.put(uploads.bucketName, kind, 'photos/cat.jpg');
        execMock.execAsyncRemote.mockClear();

        const res = await deleteBucket(uploads.bucketId);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          volumeLeftBehind: false,
          bucketLeftBehind: {
            bucketName: uploads.bucketName,
            volumeName: uploads.volumeName,
            serverId,
            because: 'holds-files',
          },
        });
        expect(ranOnServer()).toEqual(
          expect.arrayContaining([
            `docker service rm ${uploads.appName}`,
            `docker secret rm ${uploads.appName}-garage-config`,
          ]),
        );
        expect(volumeRemoved(uploads.volumeName)).toBe(false);
        expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([
          `${kind}:photos/cat.jpg`,
        ]);
        const left = await ctx.db
          .select()
          .from(bucket)
          .where(eq(bucket.bucketId, uploads.bucketId));
        expect(left).toEqual([]);
      },
    );

    it("removes an empty bucket whole: its Garage, its secret, its volume and its Domains' routes", async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');
      execMock.execAsyncRemote.mockClear();

      const res = await deleteBucket(uploads.bucketId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ volumeLeftBehind: false });
      expect(ranOnServer()).toEqual(
        expect.arrayContaining([
          `docker service rm ${uploads.appName}`,
          `docker volume rm ${uploads.volumeName} --force`,
          // Its generated Domain's Traefik file.
          `rm -f /etc/cloudgate/traefik/dynamic/${uploads.appName}.yml`,
        ]),
      );
    });

    it("reads the bucket at its Garage with the bucket's own key, path-style in us-east-1, and closes the way in", async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');

      await deleteBucket(uploads.bucketId);

      expect(ctx.objectStorage.calls).toEqual([
        {
          call: 'contentsOf',
          target: {
            endpoint: FAKE_GARAGE_ENDPOINT,
            region: 'us-east-1',
            bucket: uploads.bucketName,
            credential: { accessKeyId: KEY_ID, secretAccessKey: SECRET_KEY },
            pathStyle: true,
          },
        },
      ]);
      expect(ctx.objectStorage.reach.opened).toEqual([
        { serverId, appName: uploads.appName },
      ]);
      expect(ctx.objectStorage.reach.closed).toBe(1);
    });

    it("keeps a bucket it can't read, as holding files", async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');
      ctx.objectStorage.makeUnreadable(uploads.bucketName);
      execMock.execAsyncRemote.mockClear();

      const res = await deleteBucket(uploads.bucketId);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        bucketLeftBehind: { because: 'unknown' },
      });
      expect(volumeRemoved(uploads.volumeName)).toBe(false);
    });

    it('"also delete its files" empties the bucket, old versions and delete markers included, then removes it whole', async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a.jpg');
      ctx.objectStorage.put(uploads.bucketName, 'version', 'a.jpg');
      ctx.objectStorage.put(uploads.bucketName, 'delete-marker', 'b.jpg');
      execMock.execAsyncRemote.mockClear();

      const res = await deleteBucket(uploads.bucketId, '?deleteFiles=true');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ volumeLeftBehind: false });
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([]);
      expect(volumeRemoved(uploads.volumeName)).toBe(true);
    });

    it('asks for service: delete on the bucket and nothing more, files and all', async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a.jpg');
      const asked = jest.spyOn(
        ctx.app.get(PermissionService),
        'checkServiceAccess',
      );

      const res = await deleteBucket(uploads.bucketId, '?deleteFiles=true');

      expect(res.status).toBe(200);
      expect(
        asked.mock.calls
          .filter(([, id]) => id === uploads.bucketId)
          .map(([, , action]) => action),
      ).toEqual(['delete']);
    });

    it('finishes a Delete whose emptying fails partway, naming the bucket as partly emptied and keeping its volume', async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a', 'b', 'c');
      ctx.objectStorage.failEmptyAfter(uploads.bucketName, 1);
      execMock.execAsyncRemote.mockClear();

      const res = await deleteBucket(uploads.bucketId, '?deleteFiles=true');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        volumeLeftBehind: false,
        bucketLeftBehind: {
          bucketName: uploads.bucketName,
          volumeName: uploads.volumeName,
          serverId,
          because: 'partly-emptied',
        },
      });
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([
        'object:b',
        'object:c',
      ]);
      expect(volumeRemoved(uploads.volumeName)).toBe(false);
      expect(
        await ctx.db
          .select()
          .from(bucket)
          .where(eq(bucket.bucketId, uploads.bucketId)),
      ).toEqual([]);
    });
  });

  describe("a Plan's destroy", () => {
    it("shows each bucket destroy as holds files, empty or can't tell", async () => {
      await applyBuckets(`version: 1
services:
  uploads:
    kind: bucket
  avatars:
    kind: bucket
  exports:
    kind: bucket
`);
      const rows = await ctx.db.select().from(bucket);
      const named = (configName: string) =>
        rows.find((row) => row.configName === configName)?.bucketName ?? '';
      ctx.objectStorage.put(named('uploads'), 'object', 'a.jpg');
      ctx.objectStorage.makeUnreadable(named('exports'));

      const open = await planFor(NO_SERVICES);

      expect(
        open.steps.map((step) => [step.action, step.configName, step.files]),
      ).toEqual(
        expect.arrayContaining([
          ['destroy', 'uploads', 'holds-files'],
          ['destroy', 'avatars', 'empty'],
          ['destroy', 'exports', 'unknown'],
        ]),
      );
    });

    it('keeps every bucket that holds files unless its own box is ticked, and names each kept one in its step result', async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');
      const avatars = byName('avatars');
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a.jpg');
      ctx.objectStorage.put(avatars.bucketName, 'version', 'me.png');
      execMock.execAsyncRemote.mockClear();

      const open = await planFor(NO_SERVICES);
      const applied = await apply(
        open.planId,
        ['uploads', 'avatars'],
        ['avatars'],
      );

      expect(applied.status).toBe(200);
      const results = (applied.body as PlanBody).results ?? [];
      expect(
        results.map((result) => [
          result.configName,
          result.status,
          result.leftovers,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [
            'uploads',
            'applied',
            {
              bucketLeftBehind: {
                bucketName: uploads.bucketName,
                volumeName: uploads.volumeName,
                serverId,
                because: 'holds-files',
              },
            },
          ],
          ['avatars', 'applied', null],
        ]),
      );
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([
        'object:a.jpg',
      ]);
      expect(ctx.objectStorage.entriesOf(avatars.bucketName)).toEqual([]);
      expect(volumeRemoved(uploads.volumeName)).toBe(false);
      expect(volumeRemoved(avatars.volumeName)).toBe(true);
    });

    it('reads the files again as the step runs: a bucket that filled since the plan is kept', async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');
      const open = await planFor(NO_SERVICES);
      expect(
        open.steps.find((step) => step.configName === 'uploads')?.files,
      ).toBe('empty');
      ctx.objectStorage.put(uploads.bucketName, 'object', 'late.jpg');

      const applied = await apply(open.planId, ['uploads', 'avatars']);

      const result = (applied.body as PlanBody).results?.find(
        (one) => one.configName === 'uploads',
      );
      expect(result?.leftovers).toMatchObject({
        bucketLeftBehind: { because: 'holds-files' },
      });
    });

    it('refuses a tick on anything but a bucket the plan destroys, naming it', async () => {
      await applyBuckets();
      const open = await planFor(
        'version: 1\nservices:\n  uploads:\n    kind: bucket\n',
      );

      const applied = await apply(open.planId, ['avatars'], ['uploads']);

      expect(applied.status).toBe(409);
      expect(applied.body).toMatchObject({
        message: expect.stringContaining(
          'it destroys no bucket uploads',
        ) as string,
      });
    });
  });

  describe("an Environment's Delete", () => {
    it('keeps and names every bucket that holds files, and removes an empty one whole', async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');
      const avatars = byName('avatars');
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a.jpg');
      execMock.execAsyncRemote.mockClear();

      const res = await request(httpServer)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(
        (res.body as { bucketsLeftBehind?: unknown }).bucketsLeftBehind,
      ).toEqual([
        {
          bucketName: uploads.bucketName,
          volumeName: uploads.volumeName,
          serverId,
          because: 'holds-files',
        },
      ]);
      expect(volumeRemoved(uploads.volumeName)).toBe(false);
      expect(volumeRemoved(avatars.volumeName)).toBe(true);
      // Each bucket's Domain routes go with it.
      expect(ranOnServer()).toEqual(
        expect.arrayContaining([
          `rm -f /etc/cloudgate/traefik/dynamic/${uploads.appName}.yml`,
          `rm -f /etc/cloudgate/traefik/dynamic/${avatars.appName}.yml`,
        ]),
      );
      expect(ctx.objectStorage.calls.map((one) => one.call)).not.toContain(
        'empty',
      );
      expect(await ctx.db.select().from(bucket)).toEqual([]);
    });

    it('offers no way to delete files: a deleteFiles it is sent is not read', async () => {
      const { byName } = await applyBuckets();
      const uploads = byName('uploads');
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a.jpg');

      const res = await request(httpServer)
        .delete(`/environments/${environmentId}?deleteFiles=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([
        'object:a.jpg',
      ]);
    });
  });
});
