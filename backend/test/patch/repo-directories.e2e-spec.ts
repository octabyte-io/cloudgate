import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { ComposeService } from '../../src/compose/compose.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * The patch-repos tree both clones below sit in, **asked of the machine rather
 * than spelled**. Neither Service here has a Server, so both clones are
 * on the platform host, whose root is this process's `CLOUDGATE_DIRECTORY` —
 * `/etc/cloudgate` only while that is unset, which is the coincidence the
 * literal this used to be was green by. Functions rather than constants
 * because the root is read per call, for `localCloudgateDirectory`'s reason.
 */
const patchRepos = () => `${cloudgateDirectoryOn(null)}/patch-repos`;
const ownClone = () => `${patchRepos()}/application/blog-app`;
const victimClone = () => `${patchRepos()}/compose/victim-stack`;

const OWN_FILES = ['src/index.ts', 'src/utils/helper.ts', 'README.md'];
const VICTIM_FILES = ['deploy/id_rsa', '.env'];

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
 * `GET /patches/repo/directories` took the directory to
 * list from the caller. `validatePath` only rejected a literal `../` and
 * required the resolved path to start with the patch-repos tree, so a caller
 * could name a *sibling* clone — another service's, potentially another
 * organization's, source — and could close the double quotes the path is
 * interpolated into and append commands of its own. The path is now derived
 * from the already-access-checked parent, the way `ensureRepo` derives the one
 * it clones into, so neither is expressible.
 */
describe('Patch repo directory listing (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let composeService: ComposeService;

  type ExecResult = { stdout: string; stderr: string; exitCode: number };
  const execMock = {
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  };

  /** The clones on disk: absolute path → the repo's git-tracked files. */
  const clones = new Map<string, string[]>();

  /**
   * A stand-in for the `/bin/sh -c` that `RemoteExecService.execAsync`
   * (`promisify(exec)`) hands the command to, faithful on the one construct
   * that matters here: `&&` runs each segment as a command of its own. Without
   * that fidelity a mock would swallow an injected command and the exploit
   * would look harmless.
   */
  function fakeShell(command: string): ExecResult {
    let cwd = '';
    let stdout = '';
    for (const segment of command.split('&&').map((s) => s.trim())) {
      const cd = /^cd "(.*)"$/.exec(segment);
      if (cd) {
        cwd = cd[1];
        continue;
      }
      if (segment === 'git ls-tree -r --name-only HEAD') {
        const files = clones.get(cwd);
        if (!files) {
          throw new Error(`fatal: not a git repository: ${cwd}`);
        }
        stdout += `${files.join('\n')}\n`;
        continue;
      }
      const echo = /^echo "?(.*?)"?$/.exec(segment);
      if (echo) {
        stdout += `${echo[1]}\n`;
        continue;
      }
      // `git clone` and the `set -e;` prologue of ensureRepo land here.
      stdout += '';
    }
    return { stdout, stderr: '', exitCode: 0 };
  }

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    composeService = ctx.app.get(ComposeService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    clones.clear();
    clones.set(ownClone(), OWN_FILES);
    clones.set(victimClone(), VICTIM_FILES);
    execMock.execAsync
      .mockReset()
      .mockImplementation((command: string) =>
        Promise.resolve(fakeShell(command)),
      );
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        Promise.resolve(fakeShell(command)),
      );
  });

  /** The caller's own application, plus a compose in a second organization
   * whose clone sits next to it under the patch-repos tree. */
  async function setUpServices() {
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
    // A clonable source, so `repo/ensure` has something to clone.
    await applications.update(ownerCtx, application.applicationId, {
      sourceType: 'git',
      customGitUrl: 'https://git.example.com/acme/blog.git',
      customGitBranch: 'main',
    });

    // The victim: another organization's stack. A second sign-up would 400,
    // so the same owner opens a second organization instead.
    const secondOrg = await createOrganization(
      server,
      ctx.db,
      ownerSession.cookie,
      { name: 'Victim Org' },
    );
    const victimCtx = permissionCtx(
      ownerSession.id,
      (secondOrg.body as { id: string }).id,
    );
    const victimProject = await projects.create(victimCtx, { name: 'victim' });
    const victimEnvironment = await environments.create(victimCtx, {
      name: 'production',
      projectId: victimProject.projectId,
    });
    await composeService.create(victimCtx, {
      name: 'Victim Stack',
      appName: 'victim-stack',
      environmentId: victimEnvironment.environmentId,
    });

    return { ownerSession, ownerCtx, application };
  }

  /** `GET /patches/repo/directories`, with whatever extra query the caller sends. */
  const readDirectories = (
    cookie: string,
    id: string,
    extra: Record<string, string> = {},
  ) =>
    request(server)
      .get('/patches/repo/directories')
      .query({ id, type: 'application', ...extra })
      .set('Cookie', cookie);

  /** Every file path the returned tree names, flattened. */
  function filePaths(tree: unknown): string[] {
    const entries = tree as {
      path: string;
      type: string;
      children?: unknown;
    }[];
    return entries.flatMap((entry) =>
      entry.type === 'file' ? [entry.path] : filePaths(entry.children ?? []),
    );
  }

  it('lists the clone that was cloned for this entity, and nothing else', async () => {
    const { ownerSession, application } = await setUpServices();

    // The path ensureRepo cloned into is the path the listing must read.
    const ensured = await request(server)
      .post('/patches/repo/ensure')
      .set('Cookie', ownerSession.cookie)
      .send({ id: application.applicationId, type: 'application' });
    expect(ensured.status).toBe(200);
    expect(ensured.text).toBe(ownClone());

    execMock.execAsync.mockClear();
    const res = await readDirectories(
      ownerSession.cookie,
      application.applicationId,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        name: 'src',
        path: 'src',
        type: 'directory',
        children: [
          { name: 'index.ts', path: 'src/index.ts', type: 'file' },
          {
            name: 'utils',
            path: 'src/utils',
            type: 'directory',
            children: [
              { name: 'helper.ts', path: 'src/utils/helper.ts', type: 'file' },
            ],
          },
        ],
      },
      { name: 'README.md', path: 'README.md', type: 'file' },
    ]);
    expect(execMock.execAsync).toHaveBeenCalledWith(
      `cd "${ownClone()}" && git ls-tree -r --name-only HEAD`,
    );
  });

  it('still answers a caller that sends the old repoPath, ignoring it', async () => {
    const { ownerSession, application } = await setUpServices();

    // The parameter is gone from the schema, and zod strips what it does not
    // know, so a frontend that has not been redeployed keeps working.
    const res = await readDirectories(
      ownerSession.cookie,
      application.applicationId,
      { repoPath: ownClone() },
    );
    expect(res.status).toBe(200);
    expect(filePaths(res.body)).toEqual(OWN_FILES);
  });

  it('cannot be pointed at a sibling clone belonging to another organization', async () => {
    const { ownerSession, application } = await setUpServices();

    const res = await readDirectories(
      ownerSession.cookie,
      application.applicationId,
      { repoPath: victimClone() },
    );

    // The caller gets its own entity's listing: the path is derived, so a
    // supplied one is not refused, it is simply not expressible.
    expect(res.status).toBe(200);
    expect(filePaths(res.body)).toEqual(OWN_FILES);
    expect(filePaths(res.body)).not.toContain('.env');
    expect(filePaths(res.body)).not.toContain('deploy/id_rsa');
    expect(execMock.execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining(victimClone()),
    );
  });

  it('cannot close the quotes around the path and append a command', async () => {
    const { ownerSession, application } = await setUpServices();

    const res = await readDirectories(
      ownerSession.cookie,
      application.applicationId,
      { repoPath: `${ownClone()}" && echo INJECTED && echo "` },
    );

    expect(res.status).toBe(200);
    // The injected `echo` would surface as a tracked file called INJECTED.
    expect(filePaths(res.body)).toEqual(OWN_FILES);
    for (const call of execMock.execAsync.mock.calls) {
      expect(call[0]).toBe(
        `cd "${ownClone()}" && git ls-tree -r --name-only HEAD`,
      );
    }
  });
});
