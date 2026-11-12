import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { PatchService } from '../../src/patch/patch.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * The Application's patch-repo clone, **asked of the machine rather than
 * spelled**. The Application has no Server, so its clone is on the
 * platform host, whose root is this process's `CLOUDGATE_DIRECTORY` —
 * `/etc/cloudgate` only while that is unset, which is the coincidence the
 * literal this used to be was green by. A function rather than a constant
 * because the root is read per call, for `localCloudgateDirectory`'s reason.
 */
const repo = () =>
  `${cloudgateDirectoryOn(null)}/patch-repos/application/blog-app`;

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

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
  const cookie = su.headers['set-cookie'];

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id: (su.body as { user: { id: string } }).user.id };
}

/**
 * `GET /patches/repo/file` answered with the patch whenever one
 * stood in front of the path, so for an `update` patch — the default type —
 * the repository's own copy was unreachable and "what does this patch change?"
 * had no answer. The `source` selector asks for one side or the other.
 */
describe('Patch repo file source (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let patches: PatchService;

  type ExecResult = { stdout: string; stderr: string; exitCode: number };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  /** The clone on disk, as a map the `cat` the service runs reads through. */
  const repoFiles = new Map<string, string>();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    patches = ctx.app.get(PatchService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    repoFiles.clear();
    const fakeFs = (command: string): Promise<ExecResult> => {
      // Unquoted: the path is an argv word that `shell-quote` words,
      // and a patch-repo path has nothing in it to escape. The `"` this used to
      // match were the service's own, and were never what made the path safe —
      // `resolveRepoFilePath` is.
      const cat = /^cat (.*)$/.exec(command);
      if (cat) {
        const body = repoFiles.get(cat[1]);
        if (body === undefined) {
          return Promise.reject(
            new Error(`cat: ${cat[1]}: No such file or directory`),
          );
        }
        return Promise.resolve({ stdout: body, stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    };
    execMock.execAsync.mockReset().mockImplementation(fakeFs);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        fakeFs(command),
      );
  });

  /** An owner ctx plus a project + environment + application to patch. */
  async function setUpApplication() {
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
    const application = await applications.create(ownerCtx, {
      name: 'Blog',
      appName: 'blog-app',
      environmentId: environment.environmentId,
    });
    return { organizationId, ownerSession, ownerCtx, application };
  }

  /** `GET /patches/repo/file` for the application, with an optional source. */
  const readFile = (
    cookie: string,
    id: string,
    filePath: string,
    source?: string,
  ) =>
    request(server)
      .get('/patches/repo/file')
      .query({
        id,
        type: 'application',
        filePath,
        ...(source === undefined ? {} : { source }),
      })
      .set('Cookie', cookie);

  it('answers with the patch by default and with the repository copy on source=repo, for an update patch', async () => {
    const { ownerSession, ownerCtx, application } = await setUpApplication();
    repoFiles.set(`${repo()}/src/config.ts`, 'export const DEBUG = false;\n');
    await patches.create(ownerCtx, {
      filePath: 'src/config.ts',
      content: 'export const DEBUG = true;\n',
      applicationId: application.applicationId,
    });

    // Unchanged default: the Patches tab keeps getting the patch content.
    const byDefault = await readFile(
      ownerSession.cookie,
      application.applicationId,
      'src/config.ts',
    );
    expect(byDefault.status).toBe(200);
    expect(byDefault.text).toBe('export const DEBUG = true;\n');

    const explicit = await readFile(
      ownerSession.cookie,
      application.applicationId,
      'src/config.ts',
      'patch',
    );
    expect(explicit.status).toBe(200);
    expect(explicit.text).toBe('export const DEBUG = true;\n');

    // The other side of the diff, now reachable.
    const fromRepo = await readFile(
      ownerSession.cookie,
      application.applicationId,
      'src/config.ts',
      'repo',
    );
    expect(fromRepo.status).toBe(200);
    expect(fromRepo.text).toBe('export const DEBUG = false;\n');
    expect(execMock.execAsync).toHaveBeenCalledWith(
      `cat ${repo()}/src/config.ts`,
    );
  });

  it('reads the repository copy under either source when no patch stands in the way', async () => {
    const { ownerSession, application } = await setUpApplication();
    repoFiles.set(`${repo()}/README.md`, '# Blog\n');

    for (const source of [undefined, 'patch', 'repo']) {
      const res = await readFile(
        ownerSession.cookie,
        application.applicationId,
        'README.md',
        source,
      );
      expect(res.status).toBe(200);
      expect(res.text).toBe('# Blog\n');
    }
  });

  it('keeps the delete-patch semantics, and 404s on source=repo once the file is gone', async () => {
    const { ownerSession, ownerCtx, application } = await setUpApplication();
    repoFiles.set(`${repo()}/src/old.ts`, 'content to be deleted\n');
    await patches.markFileForDeletion(ownerCtx, {
      id: application.applicationId,
      type: 'application',
      filePath: 'src/old.ts',
    });

    // A delete patch already showed the doomed repo file; source=repo agrees.
    for (const source of [undefined, 'patch', 'repo']) {
      const res = await readFile(
        ownerSession.cookie,
        application.applicationId,
        'src/old.ts',
        source,
      );
      expect(res.status).toBe(200);
      expect(res.text).toBe('content to be deleted\n');
    }

    repoFiles.delete(`${repo()}/src/old.ts`);
    const sentinel = await readFile(
      ownerSession.cookie,
      application.applicationId,
      'src/old.ts',
    );
    expect(sentinel.status).toBe(200);
    expect(sentinel.text).toBe(
      '(File not found in repo - will be removed if it exists)',
    );

    // source=repo makes no claim about removal — the file is simply absent.
    const absent = await readFile(
      ownerSession.cookie,
      application.applicationId,
      'src/old.ts',
      'repo',
    );
    expect(absent.status).toBe(404);
    expect(absent.text).not.toContain('will be removed');
  });

  it('404s on source=repo for a file the repository does not have', async () => {
    const { ownerSession, ownerCtx, application } = await setUpApplication();
    await patches.create(ownerCtx, {
      filePath: 'src/new.ts',
      content: 'brand new\n',
      type: 'create',
      applicationId: application.applicationId,
    });

    const byDefault = await readFile(
      ownerSession.cookie,
      application.applicationId,
      'src/new.ts',
    );
    expect(byDefault.status).toBe(200);
    expect(byDefault.text).toBe('brand new\n');

    const fromRepo = await readFile(
      ownerSession.cookie,
      application.applicationId,
      'src/new.ts',
      'repo',
    );
    expect(fromRepo.status).toBe(404);
    expect((fromRepo.body as { message: string }).message).toContain(
      'src/new.ts',
    );
  });

  it('refuses to read outside the patch-repos tree under every source', async () => {
    const { ownerSession, application } = await setUpApplication();
    const traversals = [
      '../../../etc/passwd',
      '../../../../etc/passwd',
      '../../../../../../etc/passwd',
      '../blog-app-evil/.env',
      'src/../../../../etc/shadow',
      '..\\..\\..\\etc\\passwd',
    ];

    for (const filePath of traversals) {
      for (const source of [undefined, 'patch', 'repo']) {
        const res = await readFile(
          ownerSession.cookie,
          application.applicationId,
          filePath,
          source,
        );
        expect([filePath, source, res.status]).toEqual([filePath, source, 400]);
      }
    }
    expect(execMock.execAsync).not.toHaveBeenCalled();

    // An absolute path is confined into the clone rather than escaping it.
    const absolute = await readFile(
      ownerSession.cookie,
      application.applicationId,
      '/etc/passwd',
      'repo',
    );
    expect(absolute.status).toBe(404);
    expect(execMock.execAsync).toHaveBeenCalledWith(`cat ${repo()}/etc/passwd`);
  });

  it('rejects a source it does not know and still enforces service read access', async () => {
    const { ownerSession, application } = await setUpApplication();
    repoFiles.set(`${repo()}/README.md`, '# Blog\n');

    const unknown = await readFile(
      ownerSession.cookie,
      application.applicationId,
      'README.md',
      'host',
    );
    expect(unknown.status).toBe(400);

    const member = await inviteUser(
      server,
      ownerSession.cookie,
      'ida@example.com',
      'member',
    );
    const denied = await readFile(
      member.cookie,
      application.applicationId,
      'README.md',
      'repo',
    );
    expect(denied.status).toBe(403);
  });
});
