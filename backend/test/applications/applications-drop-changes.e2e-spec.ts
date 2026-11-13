import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import {
  application as applicationTable,
  deployment as deploymentTable,
  server as serverTable,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecOptions } from '../../src/remote/remote-exec.service';
import { createTestApp } from '../utils/test-app';
import type { TestAppContext } from '../utils/test-app';
import { buildZip } from '../utils/zip-archive';
import type { ZipEntry } from '../utils/zip-archive';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** A file's SHA-256, as the CLI fingerprints it. */
const sha256 = (content: string) =>
  createHash('sha256').update(content).digest('hex');

/** The list `deploy` sends: each path with the fingerprint of its content. */
const listOf = (files: Record<string, string>) =>
  Object.entries(files).map(([path, content]) => ({
    path,
    sha256: sha256(content),
  }));

/** The tree as it now is on disk under `root`, as {relative path: content}. */
function treeAt(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found[nodePath.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return found;
}

/** Lays `files` down under `root`, as a build host's code directory. */
function plant(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = nodePath.join(root, path);
    fs.mkdirSync(nodePath.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const zipOf = (files: Record<string, string>) =>
  buildZip(
    Object.entries(files).map(([name, content]): ZipEntry => ({
      name,
      content,
    })),
  );

/**
 * The upload of only the changed files: `POST /applications/:id/drop/compare`
 * answers which files the build host is missing, and `…/drop/apply` lands
 * those plus the deletions as one swap.
 *
 * **The platform host is this machine, for real.** The double hands the
 * platform host's programs to a real `RemoteExecService`, under a
 * `CLOUDGATE_DIRECTORY` made fresh for each test, so the expected tree is what
 * is on disk afterwards rather than the words of a command. Only SSH, the
 * system boundary, is a recorder.
 */
describe('Application upload of changed files (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let root: string;
  let originalRoot: string | undefined;

  const real = new RemoteExecService();
  const execMock = {
    execAsync: jest.fn((command: string, options?: ExecOptions) =>
      real.execAsync(command, options),
    ),
    execAsyncRemote: jest.fn<
      Promise<{ stdout: string; stderr: string; exitCode: number }>,
      [string, string, unknown?, unknown?]
    >(),
    execFileAsync: jest.fn(),
  };

  /** The Application's code directory on the platform host. */
  const code = () => nodePath.join(root, 'applications', 'drop-app', 'code');

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    execMock.execAsyncRemote.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    root = fs.realpathSync(
      fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-drop-changes-')),
    );
    originalRoot = process.env.CLOUDGATE_DIRECTORY;
    process.env.CLOUDGATE_DIRECTORY = root;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function setUpApplication() {
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'];
    const userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const created = await applications.create(ownerCtx, {
      name: 'Dropped App',
      appName: 'drop-app',
      environmentId: environment.environmentId,
    });
    return { cookie, organizationId, ownerCtx, created };
  }

  const compare = (cookie: string, applicationId: string, list: unknown) =>
    request(server)
      .post(`/applications/${applicationId}/drop/compare`)
      .set('Cookie', cookie)
      .attach('files', Buffer.from(JSON.stringify(list)), {
        filename: 'files.json',
        contentType: 'application/json',
      });

  const apply = (
    cookie: string,
    applicationId: string,
    list: unknown,
    zip: Buffer,
  ) =>
    request(server)
      .post(`/applications/${applicationId}/drop/apply`)
      .set('Cookie', cookie)
      .attach('files', Buffer.from(JSON.stringify(list)), {
        filename: 'files.json',
        contentType: 'application/json',
      })
      .attach('zip', zip, 'changes.zip');

  async function onBuildServer(
    organizationId: string,
    applicationId: string,
    values: Partial<typeof serverTable.$inferInsert> = {},
  ) {
    const [buildServer] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'build-eu',
        ipAddress: '203.0.113.7',
        port: 22,
        organizationId,
        ...values,
      })
      .returning();
    await ctx.db
      .update(applicationTable)
      .set({ buildServerId: buildServer.serverId })
      .where(eq(applicationTable.applicationId, applicationId));
    return buildServer;
  }

  describe('what the build host is missing', () => {
    it('answers only the files the build host is missing or holds different, with the unchanged and to-delete counts', async () => {
      const { cookie, created } = await setUpApplication();
      plant(code(), {
        'index.js': 'console.log(1);\n',
        'src/app.js': 'export const app = 1;\n',
        'src/old.js': 'gone locally\n',
        'README.md': 'an older readme\n',
      });

      const res = await compare(
        cookie,
        created.applicationId,
        listOf({
          'index.js': 'console.log(1);\n',
          'src/app.js': 'export const app = 1;\n',
          'README.md': 'the new readme\n',
          'src/new.js': 'brand new\n',
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        missing: ['README.md', 'src/new.js'],
        unchanged: 2,
        deleted: 1,
        upToDate: false,
      });
    });

    it('asks for every file when the build host has no tree yet', async () => {
      const { cookie, created } = await setUpApplication();

      const res = await compare(
        cookie,
        created.applicationId,
        listOf({ 'index.js': 'x\n', 'src/app.js': 'y\n' }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        missing: ['index.js', 'src/app.js'],
        unchanged: 0,
        deleted: 0,
        upToDate: false,
      });
    });

    it('does not count the .env a build writes as deleted', async () => {
      const { cookie, created } = await setUpApplication();
      plant(code(), {
        'index.js': 'x\n',
        '.env': 'S=1\n',
        'apps/web/.env': 'S=1\n',
      });

      const res = await compare(
        cookie,
        created.applicationId,
        listOf({ 'index.js': 'x\n' }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ missing: [], unchanged: 1, deleted: 0 });
    });

    it('says the upload is up to date only when the source is uploaded files at the same build path', async () => {
      const { cookie, created } = await setUpApplication();
      plant(code(), { 'index.js': 'x\n' });
      const list = listOf({ 'index.js': 'x\n' });

      // A git source: an apply would switch it.
      const github = await compare(cookie, created.applicationId, list);
      expect(github.body).toMatchObject({ upToDate: false });

      await ctx.db
        .update(applicationTable)
        .set({ sourceType: 'drop', dropUploaded: true, dropBuildPath: '/web' })
        .where(eq(applicationTable.applicationId, created.applicationId));
      const same = await compare(cookie, created.applicationId, list).field(
        'dropBuildPath',
        '/web',
      );
      expect(same.status).toBe(200);
      expect(same.body).toMatchObject({ upToDate: true });

      const moved = await compare(cookie, created.applicationId, list);
      expect(moved.body).toMatchObject({ upToDate: false });
    });

    it('reads the tree on the build host, not the platform host', async () => {
      const { cookie, organizationId, created } = await setUpApplication();
      const buildServer = await onBuildServer(
        organizationId,
        created.applicationId,
      );
      // What `sha256sum -z` prints on the build host: NUL-ended lines.
      execMock.execAsyncRemote.mockResolvedValue({
        stdout: `${sha256('x\n')}  ./index.js\0${sha256('stale\n')}  ./stale.js\0`,
        stderr: '',
        exitCode: 0,
      });

      const res = await compare(
        cookie,
        created.applicationId,
        listOf({ 'index.js': 'x\n', 'new.js': 'n\n' }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        missing: ['new.js'],
        unchanged: 1,
        deleted: 1,
        upToDate: false,
      });
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(
        execMock.execAsyncRemote.mock.calls.map(([serverId]) => serverId),
      ).toEqual([buildServer.serverId]);
      expect(execMock.execAsyncRemote.mock.calls[0][1]).toContain(
        `${REMOTE_CLOUDGATE_DIRECTORY}/applications/drop-app/code`,
      );
    });

    it.each([
      ['climbs out of the code directory', '../../etc/passwd'],
      ['is absolute', '/etc/passwd'],
      ['is not written in its plain form', './index.js'],
    ])('refuses a path that %s', async (_, path) => {
      const { cookie, created } = await setUpApplication();

      const res = await compare(cookie, created.applicationId, [
        { path, sha256: sha256('x') },
      ]);

      expect(res.status).toBe(400);
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('refuses a request with no file list attached', async () => {
      const { cookie, created } = await setUpApplication();

      const res = await request(server)
        .post(`/applications/${created.applicationId}/drop/compare`)
        .set('Cookie', cookie);

      expect(res.status).toBe(400);
    });
  });

  describe('landing the changes', () => {
    /** The 409's message for an apply that failed, whatever the cause. */
    const FAILED_APPLY =
      'The upload could not be applied on the build host: it could not be reached, or the apply stopped part-way';
    const before = {
      'index.js': 'console.log(1);\n',
      'src/app.js': 'export const app = 1;\n',
      'src/old.js': 'gone locally\n',
      'old/only.js': 'a folder deleted locally\n',
      'README.md': 'an older readme\n',
    };
    const folder = {
      'index.js': 'console.log(1);\n',
      'src/app.js': 'export const app = 1;\n',
      'README.md': 'the new readme\n',
      'src/new.js': 'brand new\n',
    };

    it('removes files not in the list, writes the uploaded ones and keeps the unchanged ones', async () => {
      const { cookie, created } = await setUpApplication();
      plant(code(), before);

      const res = await apply(
        cookie,
        created.applicationId,
        listOf(folder),
        zipOf({
          'README.md': 'the new readme\n',
          'src/new.js': 'brand new\n',
        }),
      );

      expect(res.status).toBe(200);
      expect(treeAt(code())).toEqual(folder);
      // The folder deleted locally goes with its last file.
      expect(fs.existsSync(nodePath.join(code(), 'old'))).toBe(false);
      // Nothing of the working tree is left beside the code directory.
      expect(fs.readdirSync(nodePath.dirname(code()))).toEqual(['code']);
    });

    it('switches the source to uploaded files exactly as /drop does', async () => {
      const { cookie, ownerCtx, created } = await setUpApplication();
      expect(created.sourceType).toBe('github');

      const res = await apply(
        cookie,
        created.applicationId,
        listOf({ 'index.js': 'x\n' }),
        zipOf({ 'index.js': 'x\n' }),
      ).field('dropBuildPath', '/frontend');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        applicationId: created.applicationId,
        sourceType: 'drop',
        dropBuildPath: '/frontend',
      });
      const found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.sourceType).toBe('drop');
      expect(found.dropBuildPath).toBe('/frontend');
    });

    it('builds the first tree when the build host has none yet', async () => {
      const { cookie, created } = await setUpApplication();

      const res = await apply(
        cookie,
        created.applicationId,
        listOf(folder),
        zipOf(folder),
      );

      expect(res.status).toBe(200);
      expect(treeAt(code())).toEqual(folder);
    });

    it('refuses with a conflict when a file changed on the build host since the comparison, leaving the previous tree and source', async () => {
      const { cookie, ownerCtx, created } = await setUpApplication();
      plant(code(), before);
      // Compared while `index.js` matched; then a build's Patch rewrote it.
      fs.writeFileSync(nodePath.join(code(), 'index.js'), 'patched\n');

      const res = await apply(
        cookie,
        created.applicationId,
        listOf(folder),
        zipOf({
          'README.md': 'the new readme\n',
          'src/new.js': 'brand new\n',
        }),
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'UPLOAD_CONFLICT',
        message:
          'The files on the build host changed since they were compared, so the upload was not applied',
      });
      expect(treeAt(code())).toEqual({ ...before, 'index.js': 'patched\n' });
      expect(fs.readdirSync(nodePath.dirname(code()))).toEqual(['code']);
      const found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.sourceType).toBe('github');
    });

    it('refuses with a conflict when an uploaded file does not match its fingerprint', async () => {
      const { cookie, created } = await setUpApplication();
      plant(code(), before);

      const res = await apply(
        cookie,
        created.applicationId,
        listOf(folder),
        zipOf({
          'README.md': 'edited after it was fingerprinted\n',
          'src/new.js': 'brand new\n',
        }),
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'UPLOAD_CONFLICT' });
      expect(treeAt(code())).toEqual(before);
    });

    it('leaves the previous tree intact and answers a conflict when the apply fails part-way', async () => {
      const { cookie, created } = await setUpApplication();
      plant(code(), before);
      // `lib` is both a file and a folder in this list: the write of
      // `lib/util.js` fails once `lib` has been written as a file.
      const res = await apply(
        cookie,
        created.applicationId,
        listOf({ ...folder, lib: 'a file\n', 'lib/util.js': 'u\n' }),
        buildZip([
          { name: 'README.md', content: 'the new readme\n' },
          { name: 'src/new.js', content: 'brand new\n' },
          { name: 'lib', content: 'a file\n' },
          { name: 'lib/util.js', content: 'u\n' },
        ]),
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'UPLOAD_CONFLICT',
        message: FAILED_APPLY,
      });
      expect(treeAt(code())).toEqual(before);
      expect(fs.readdirSync(nodePath.dirname(code()))).toEqual(['code']);
    });

    it('answers a conflict that says so, switching nothing, when the build host cannot be reached', async () => {
      const { cookie, ownerCtx, organizationId, created } =
        await setUpApplication();
      await onBuildServer(organizationId, created.applicationId);
      execMock.execAsyncRemote.mockRejectedValue(
        new Error('Connection lost before handshake'),
      );

      const res = await apply(
        cookie,
        created.applicationId,
        listOf({ 'index.js': 'x\n' }),
        zipOf({ 'index.js': 'x\n' }),
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'UPLOAD_CONFLICT',
        message: FAILED_APPLY,
      });
      const found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.sourceType).toBe('github');
    });

    it('writes the tree on the build host, not the run Server', async () => {
      const { cookie, organizationId, created } = await setUpApplication();
      const [runServer] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'run-us',
          ipAddress: '198.51.100.4',
          port: 22,
          organizationId,
        })
        .returning();
      await ctx.db
        .update(applicationTable)
        .set({ serverId: runServer.serverId })
        .where(eq(applicationTable.applicationId, created.applicationId));
      const buildServer = await onBuildServer(
        organizationId,
        created.applicationId,
      );

      const res = await apply(
        cookie,
        created.applicationId,
        listOf({ 'index.js': 'x\n' }),
        zipOf({ 'index.js': 'x\n' }),
      );

      expect(res.status).toBe(200);
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(
        execMock.execAsyncRemote.mock.calls.map(([serverId]) => serverId),
      ).toEqual([buildServer.serverId]);
      expect(execMock.execAsyncRemote.mock.calls[0][1]).toContain(
        `${REMOTE_CLOUDGATE_DIRECTORY}/applications/drop-app/code`,
      );
    });

    it.each([
      ['climbs out of the code directory', '../../../etc/cloudgate/evil.js'],
      ['is absolute', '/etc/passwd'],
      ['uses a Windows separator', '..\\..\\windows\\evil.js'],
    ])(
      'refuses a zip entry that %s, before anything reaches the build host',
      async (_, name) => {
        const { cookie, ownerCtx, created } = await setUpApplication();

        const res = await apply(
          cookie,
          created.applicationId,
          listOf({ 'index.js': 'ok\n' }),
          buildZip([
            { name: 'index.js', content: 'ok\n' },
            { name, content: 'pwned\n' },
          ]),
        );

        expect(res.status).toBe(400);
        expect(execMock.execAsync).not.toHaveBeenCalled();
        expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
        const found = await applications.findOne(
          ownerCtx,
          created.applicationId,
        );
        expect(found.sourceType).toBe('github');
      },
    );

    it('refuses a zip entry that is not in the file list', async () => {
      const { cookie, created } = await setUpApplication();

      const res = await apply(
        cookie,
        created.applicationId,
        listOf({ 'index.js': 'ok\n' }),
        zipOf({ 'index.js': 'ok\n', 'extra.js': 'not listed\n' }),
      );

      expect(res.status).toBe(400);
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('refuses a request with no archive attached', async () => {
      const { cookie, created } = await setUpApplication();

      const res = await request(server)
        .post(`/applications/${created.applicationId}/drop/apply`)
        .set('Cookie', cookie)
        .attach('files', Buffer.from('[]'), {
          filename: 'files.json',
          contentType: 'application/json',
        });

      expect(res.status).toBe(400);
    });
  });

  /**
   * Both routes are refused where `/drop` is: while a build reads the tree,
   * and for a run or build Server in maintenance.
   */
  describe('refusals shared with /drop', () => {
    const routes = [
      [
        'compare',
        (cookie: string, applicationId: string) =>
          compare(cookie, applicationId, listOf({ 'index.js': 'x\n' })),
      ],
      [
        'apply',
        (cookie: string, applicationId: string) =>
          apply(
            cookie,
            applicationId,
            listOf({ 'index.js': 'x\n' }),
            zipOf({ 'index.js': 'x\n' }),
          ),
      ],
    ] as const;

    it.each(routes)(
      'refuses %s with 409 DEPLOYMENT_IN_PROGRESS while a build is running',
      async (_, send) => {
        const { cookie, ownerCtx, created } = await setUpApplication();
        const [building] = await ctx.db
          .insert(deploymentTable)
          .values({
            title: 'a build',
            logPath: '/tmp/a-build.log',
            applicationId: created.applicationId,
            status: 'running',
            createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          })
          .returning();

        const res = await send(cookie, created.applicationId);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'DEPLOYMENT_IN_PROGRESS',
          message: expect.stringContaining(building.deploymentId) as string,
        });
        expect(execMock.execAsync).not.toHaveBeenCalled();
        expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
        const found = await applications.findOne(
          ownerCtx,
          created.applicationId,
        );
        expect(found.sourceType).toBe('github');
      },
    );

    it.each(routes)(
      'refuses %s while the build Server is in maintenance',
      async (_, send) => {
        const { cookie, organizationId, created } = await setUpApplication();
        await onBuildServer(organizationId, created.applicationId, {
          maintenanceSince: new Date().toISOString(),
        });

        const res = await send(cookie, created.applicationId);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'SERVER_IN_MAINTENANCE' });
        expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      },
    );
  });
});
