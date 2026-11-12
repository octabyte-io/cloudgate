import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import {
  application as applicationTable,
  deployment as deploymentTable,
  server as serverTable,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { buildZip } from '../utils/zip-archive';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * Where a drop upload has to land: `{applications directory}/{appName}/code`,
 * on the machine the archive is unpacked on — the platform host (`null`) or the
 * Server it was dispatched to.
 *
 * A function of the machine rather than one constant, because the two roots
 * are different values: the platform host's is this process's
 * `CLOUDGATE_DIRECTORY` and a Server's is the `/etc/cloudgate` literal. This
 * was a single `/etc/cloudgate` string, which every test here matched only
 * because the variable happened to be unset. Spelled from
 * `cloudgateDirectoryOn` plus the literal tail rather than
 * `applicationsDirectoryOn`, the helper `uploadDrop` itself asks (§1.7).
 */
const codeOn = (serverId: string | null) =>
  `${cloudgateDirectoryOn(serverId)}/applications/drop-app/code`;

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * The files a materialization command writes, as {path: content}. Paths come
 * back exactly as the shell would see them, so an escape shows up verbatim.
 */
function filesWritten(command: string): Record<string, string> {
  const written: Record<string, string> = {};
  const pattern = /echo "([^"]*)" \| base64 -d > (?:'([^']*)'|(\S+?));/g;
  for (const match of command.matchAll(pattern)) {
    const path = match[2] ?? match[3];
    written[path] = Buffer.from(match[1], 'base64').toString('utf-8');
  }
  return written;
}

/** The directories a materialization command creates. */
function directoriesCreated(command: string): string[] {
  const pattern = /mkdir -p (?:'([^']*)'|(\S+?));/g;
  return [...command.matchAll(pattern)].map((match) => match[1] ?? match[2]);
}

describe('Application drop upload (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = {
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
    execFileAsync: jest.fn(),
  };

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
    execMock.execAsync.mockResolvedValue(ok);
    execMock.execAsyncRemote.mockResolvedValue(ok);
  });

  /** An owner with a project, an environment and an application to drop into. */
  async function setUpApplication(appName = 'drop-app') {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const created = await applications.create(ownerCtx, {
      name: 'Dropped App',
      appName,
      environmentId: environment.environmentId,
    });

    return { ownerSession, organizationId, ownerCtx, environment, created };
  }

  it('extracts the uploaded archive into the application code directory', async () => {
    const { ownerSession, created } = await setUpApplication();

    const zip = buildZip([
      { name: 'index.js', content: 'console.log("hello");\n' },
      { name: 'src/app.js', content: 'export const app = 1;\n', deflate: true },
      { name: 'src/', content: '' },
    ]);

    const res = await request(server)
      .post(`/applications/${created.applicationId}/drop`)
      .set('Cookie', ownerSession.cookie)
      .attach('zip', zip, 'bundle.zip');

    expect(res.status).toBe(200);

    expect(execMock.execAsync).toHaveBeenCalledTimes(1);
    const command = execMock.execAsync.mock.calls[0][0];

    // No Server on the row, so the tree is the platform host's own.
    const code = codeOn(null);
    expect(filesWritten(command)).toEqual({
      [`${code}/index.js`]: 'console.log("hello");\n',
      [`${code}/src/app.js`]: 'export const app = 1;\n',
    });
    // The previous drop is cleared first — an upload replaces, never merges.
    expect(command).toContain(`rm -rf ${code};`);
    expect(directoriesCreated(command)).toContain(`${code}/src`);
  });

  it('switches the application to the drop source and records the build path', async () => {
    const { ownerSession, ownerCtx, created } = await setUpApplication();
    expect(created.sourceType).toBe('github');

    const res = await request(server)
      .post(`/applications/${created.applicationId}/drop`)
      .set('Cookie', ownerSession.cookie)
      .field('dropBuildPath', '/frontend')
      .attach('zip', buildZip([{ name: 'index.js', content: 'x\n' }]), 'b.zip');

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

  it('defaults dropBuildPath to the archive root when the field is omitted', async () => {
    const { ownerSession, created } = await setUpApplication();

    const res = await request(server)
      .post(`/applications/${created.applicationId}/drop`)
      .set('Cookie', ownerSession.cookie)
      .attach('zip', buildZip([{ name: 'index.js', content: 'x\n' }]), 'b.zip');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dropBuildPath: '/' });
  });

  /**
   * The write side of the same defect the Delete side closed.
   *
   * The archive is unpacked into `{applicationsDirectoryOn(…)}/{appName}/code` —
   * byte for byte the path `DeploymentEngineService` clones into, on
   * `buildHostServerId`, and the path the build then reads. This route sent it
   * to `serverId`, so on an install with a dedicated build Server the tree was
   * written to the runner while the build looked for it on the builder; and
   * once the Delete started removing it from the build host, a `drop`
   * Application's tree stopped being reclaimed at all — written to one machine
   * and deleted from the other.
   *
   * **The assertion names the host, because the words are identical either
   * way.** Both the broken and the fixed code emit the same `rm -rf`/`mkdir
   * -p`/`base64 -d` program; they differ only in who is asked. A mutation
   * restoring `current.serverId` reds this and nothing else in the file.
   */
  it('materializes on the build Server, not the Server the workload runs on', async () => {
    const { ownerSession, organizationId, created } = await setUpApplication();

    const [runner] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'runner-us',
        ipAddress: '198.51.100.4',
        port: 22,
        organizationId,
      })
      .returning();
    const [builder] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'builder-eu',
        ipAddress: '203.0.113.7',
        port: 22,
        organizationId,
      })
      .returning();
    await ctx.db
      .update(applicationTable)
      .set({ serverId: runner.serverId, buildServerId: builder.serverId })
      .where(eq(applicationTable.applicationId, created.applicationId));

    const res = await request(server)
      .post(`/applications/${created.applicationId}/drop`)
      .set('Cookie', ownerSession.cookie)
      .attach('zip', buildZip([{ name: 'index.js', content: 'x\n' }]), 'b.zip');

    expect(res.status).toBe(200);
    expect(execMock.execAsync).not.toHaveBeenCalled();
    // The whole array, not a `toContain`: the run Server must be asked for
    // nothing at all here, and an extra call to it is the defect.
    expect(
      execMock.execAsyncRemote.mock.calls.map(([serverId]) => serverId),
    ).toEqual([builder.serverId]);
    expect(filesWritten(execMock.execAsyncRemote.mock.calls[0][1])).toEqual({
      [`${codeOn(builder.serverId)}/index.js`]: 'x\n',
    });
  });

  /**
   * The **root** half of the same call site — a second, independent
   * mistake at the machine the test above fixed.
   *
   * `applicationsDirectory()`, deleted, was
   * `localCloudgateDirectory()`, so this route unpacked the archive under *this
   * instance's* root whichever machine it was dispatched to, while a Server's
   * tree is the `/etc/cloudgate` literal
   * `serverSetupCommand` created. `cloudgate-directory.ts` says so in as many
   * words: *"every path baked into a command sent over SSH … has to be that
   * literal, whatever this instance's own layout is"*.
   *
   * **The variable has to be set or this proves nothing.** With
   * `CLOUDGATE_DIRECTORY` unset the two roots are the same string, so a
   * Server's tree and the platform host's read identically and any test here
   * passes however the root is resolved — which is exactly why the defect
   * survived, and why `codeOn` now asks the machine rather than spelling one
   * literal. It is set to a fresh temp path for the duration of this
   * test only, because `localCloudgateDirectory()` reads `process.env` on
   * every call by design (*"a constant computed at import time would
   * silently miss a .env entry"*), so the assertion below can name the exact
   * root that must not reach the Server.
   */
  it('unpacks under the build Server’s own root, not this instance’s', async () => {
    const { ownerSession, organizationId, created } = await setUpApplication();
    const [builder] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'builder-eu',
        ipAddress: '203.0.113.7',
        port: 22,
        organizationId,
      })
      .returning();
    await ctx.db
      .update(applicationTable)
      .set({ buildServerId: builder.serverId })
      .where(eq(applicationTable.applicationId, created.applicationId));
    const configured = fs.realpathSync(
      fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-drop-root-')),
    );
    const originalRoot = process.env.CLOUDGATE_DIRECTORY;
    process.env.CLOUDGATE_DIRECTORY = configured;

    try {
      const res = await request(server)
        .post(`/applications/${created.applicationId}/drop`)
        .set('Cookie', ownerSession.cookie)
        .attach(
          'zip',
          buildZip([{ name: 'index.js', content: 'x\n' }]),
          'b.zip',
        );

      expect(res.status).toBe(200);
      expect(
        execMock.execAsyncRemote.mock.calls.map(([serverId]) => serverId),
      ).toEqual([builder.serverId]);
      const command = execMock.execAsyncRemote.mock.calls[0][1];
      expect(filesWritten(command)).toEqual({
        [`${REMOTE_CLOUDGATE_DIRECTORY}/applications/drop-app/code/index.js`]:
          'x\n',
      });
      // Not one word of this instance's own layout reached a machine that has
      // never heard of it.
      expect(command).not.toContain(configured);
    } finally {
      if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
      else process.env.CLOUDGATE_DIRECTORY = originalRoot;
      fs.rmSync(configured, { recursive: true, force: true });
    }
  });

  /**
   * No dedicated build Server, so `buildHostServerId` falls through to
   * `serverId` — the single-Server-with-a-remote-host case, and the reason the
   * defect above stayed green everywhere it was tested.
   */
  it('materializes over SSH when the application runs on a remote server', async () => {
    const { ownerSession, organizationId, created } = await setUpApplication();

    const [remote] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'build-box',
        ipAddress: '10.0.0.7',
        port: 22,
        organizationId,
      })
      .returning();
    await ctx.db
      .update(applicationTable)
      .set({ serverId: remote.serverId })
      .where(eq(applicationTable.applicationId, created.applicationId));

    const res = await request(server)
      .post(`/applications/${created.applicationId}/drop`)
      .set('Cookie', ownerSession.cookie)
      .attach('zip', buildZip([{ name: 'index.js', content: 'x\n' }]), 'b.zip');

    expect(res.status).toBe(200);
    expect(execMock.execAsync).not.toHaveBeenCalled();
    expect(execMock.execAsyncRemote).toHaveBeenCalledTimes(1);
    const [serverId, command] = execMock.execAsyncRemote.mock.calls[0];
    expect(serverId).toBe(remote.serverId);
    expect(filesWritten(command)).toEqual({
      [`${codeOn(remote.serverId)}/index.js`]: 'x\n',
    });
  });

  describe('untrusted archives', () => {
    it('refuses an entry that climbs out of the code directory', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();

      const zip = buildZip([
        { name: 'index.js', content: 'ok\n' },
        { name: '../../../etc/cloudgate/evil.js', content: 'pwned\n' },
      ]);

      const res = await request(server)
        .post(`/applications/${created.applicationId}/drop`)
        .set('Cookie', ownerSession.cookie)
        .attach('zip', zip, 'evil.zip');

      expect(res.status).toBe(400);
      // Nothing at all is materialized: the archive is rejected whole, so the
      // harmless sibling entry never lands either.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();

      const found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.sourceType).toBe('github');
    });

    it('refuses an entry with an absolute path', async () => {
      const { ownerSession, created } = await setUpApplication();

      const zip = buildZip([{ name: '/etc/passwd', content: 'root:x:0:0\n' }]);

      const res = await request(server)
        .post(`/applications/${created.applicationId}/drop`)
        .set('Cookie', ownerSession.cookie)
        .attach('zip', zip, 'evil.zip');

      expect(res.status).toBe(400);
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('refuses a "..\\" Windows-separator escape', async () => {
      const { ownerSession, created } = await setUpApplication();

      const zip = buildZip([
        { name: '..\\..\\windows\\evil.js', content: 'pwned\n' },
      ]);

      const res = await request(server)
        .post(`/applications/${created.applicationId}/drop`)
        .set('Cookie', ownerSession.cookie)
        .attach('zip', zip, 'evil.zip');

      expect(res.status).toBe(400);
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('refuses a payload that is not a zip archive at all', async () => {
      const { ownerSession, created } = await setUpApplication();

      const res = await request(server)
        .post(`/applications/${created.applicationId}/drop`)
        .set('Cookie', ownerSession.cookie)
        .attach('zip', Buffer.from('not a zip file'), 'bundle.zip');

      expect(res.status).toBe(400);
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('refuses a request with no archive attached', async () => {
      const { ownerSession, created } = await setUpApplication();

      const res = await request(server)
        .post(`/applications/${created.applicationId}/drop`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(400);
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });
  });

  it('does not accept a drop for an application outside the acting organization', async () => {
    const { ownerSession, created } = await setUpApplication();

    const secondOrg = await createOrganization(
      server,
      ctx.db,
      ownerSession.cookie,
      { name: 'Second Org' },
    );
    const secondOrgId = (secondOrg.body as { id: string }).id;
    const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);

    await expect(
      applications.uploadDrop(
        secondOrgCtx,
        created.applicationId,
        buildZip([{ name: 'index.js', content: 'x\n' }]),
        {},
      ),
    ).rejects.toThrow(NotFoundException);
    expect(execMock.execAsync).not.toHaveBeenCalled();
  });

  /**
   * An upload deletes the tree a build reads (`rm -rf` of the code
   * directory first), so while a build of the Application is pending or
   * running the route refuses, whoever asks — the console, or a second
   * terminal. One pending or running for more than an hour is taken as stuck
   * and no longer holds the tree, as a held one never did.
   */
  describe('while a build of the Application is in progress', () => {
    const minutesAgo = (minutes: number) =>
      new Date(Date.now() - minutes * 60_000).toISOString();

    async function withDeployment(
      applicationId: string,
      values: Partial<typeof deploymentTable.$inferInsert>,
    ) {
      const [row] = await ctx.db
        .insert(deploymentTable)
        .values({
          title: 'a build',
          logPath: '/tmp/a-build.log',
          applicationId,
          ...values,
        })
        .returning();
      return row;
    }

    const upload = (cookie: string, applicationId: string) =>
      request(server)
        .post(`/applications/${applicationId}/drop`)
        .set('Cookie', cookie)
        .attach(
          'zip',
          buildZip([{ name: 'index.js', content: 'x\n' }]),
          'b.zip',
        );

    it.each(['pending', 'running'] as const)(
      'answers 409 DEPLOYMENT_IN_PROGRESS while one is %s, leaving the tree and the source as they were',
      async (status) => {
        const { ownerSession, ownerCtx, created } = await setUpApplication();
        const building = await withDeployment(created.applicationId, {
          status,
          createdAt: minutesAgo(5),
        });

        const res = await upload(ownerSession.cookie, created.applicationId);

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

    it.each([
      ['held by a plan', { status: 'held' as const, createdAt: minutesAgo(5) }],
      ['done', { status: 'done' as const, createdAt: minutesAgo(5) }],
      ['failed', { status: 'error' as const, createdAt: minutesAgo(5) }],
      [
        'running for more than 60 minutes',
        { status: 'running' as const, createdAt: minutesAgo(61) },
      ],
    ])('accepts the upload when the build is %s', async (_, values) => {
      const { ownerSession, created } = await setUpApplication();
      await withDeployment(created.applicationId, values);

      const res = await upload(ownerSession.cookie, created.applicationId);

      expect(res.status).toBe(200);
      expect(execMock.execAsync).toHaveBeenCalledTimes(1);
    });

    it("is not held by another Application's build", async () => {
      const { ownerSession, environment, ownerCtx, created } =
        await setUpApplication();
      const other = await applications.create(ownerCtx, {
        name: 'Other App',
        appName: 'other-app',
        environmentId: environment.environmentId,
      });
      await withDeployment(other.applicationId, {
        status: 'running',
        createdAt: minutesAgo(1),
      });

      const res = await upload(ownerSession.cookie, created.applicationId);

      expect(res.status).toBe(200);
    });
  });
});
