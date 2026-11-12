import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { quote } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import { ComposeService } from '../../src/compose/compose.service';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { PatchRepoService } from '../../src/patch/patch-repo.service';
import { PatchService } from '../../src/patch/patch.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * The platform host's root, **asked of the machine rather than spelled**.
 *
 * Every Service `setUpServices` creates has no Server, so its code tree, its
 * patch-repo clone and the tree `cleanRepos` globs with no `serverId` are all
 * on the platform host — whose root is this process's `CLOUDGATE_DIRECTORY`,
 * and `/etc/cloudgate` only while that is unset. The literal these assertions
 * used to spell was green by that coincidence alone. Only the root comes from
 * here; every tail below is still written out, so each assertion pins the full
 * path. A function rather than a constant because the root is read per call,
 * for `localCloudgateDirectory`'s own reason.
 */
const platformHostRoot = () => cloudgateDirectoryOn(null);

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
  const id = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id };
}

describe('Patch (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let composeService: ComposeService;
  let patches: PatchService;
  let patchRepos: PatchRepoService;
  let engine: DeploymentEngineService;

  type ExecResult = { stdout: string; stderr: string; exitCode: number };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  /** A Swarm with no existing service: inspect rejects, so a deploy
   * converges by creating the service. */
  const dockerService = {
    inspect: jest.fn(),
    update: jest.fn(),
  };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };

  /** A release is now followed by a convergence poll that counts the
   * Service's running tasks. Three already running satisfies every replica
   * count these tests deploy, so the poll answers on its first read and
   * nothing here waits out a budget. */
  const convergedTasks = [1, 2, 3].map((n) => ({
    Status: { State: 'running', Timestamp: `2026-08-24T00:00:0${n}Z` },
  }));
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    composeService = ctx.app.get(ComposeService);
    patches = ctx.app.get(PatchService);
    patchRepos = ctx.app.get(PatchRepoService);
    engine = ctx.app.get(DeploymentEngineService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.getService.mockClear();
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks.mockReset().mockResolvedValue(convergedTasks);
    dockerFactoryMock.getRemoteDocker.mockClear();
  });

  /** An owner ctx plus a project + environment + application + compose to patch. */
  async function setUpServices() {
    const { organizationId, owner: ownerSession } = await setUpOwner(server);
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
    const compose = await composeService.create(ownerCtx, {
      name: 'Stack',
      appName: 'blog-stack',
      environmentId: environment.environmentId,
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      project,
      environment,
      application,
      compose,
    };
  }

  describe('generateApplyPatchesCommand', () => {
    // The builder's literal segments, whitespace and all. The path is one
    // `quote()`d word rather than a double-quoted interpolation.
    const writeSegment = (filePath: string, b64: string) =>
      `\nfile=${quote([filePath])}` +
      '\ndir="$(dirname -- "$file")"' +
      '\nmkdir -p -- "$dir"' +
      `\necho "${b64}" | base64 -d > "$file"\n`;
    const deleteSegment = (filePath: string) =>
      `\nrm -f -- ${quote([filePath])};\n`;
    // The link check every Patch gets ahead of any write: each
    // existing component of its path, `[ -L ]`-tested on the machine.
    const linkSegment = (patchPath: string, components: string[]) =>
      `\nfor cg_part in ${quote(components)}; do if [ -L "$cg_part" ]; then echo ${quote(
        [
          `❌ Patch "${patchPath}" cannot be applied: its path goes through a link committed in the repository, and a Patch is never written or removed through a link. Point the Patch at the file the link leads to, or remove the link from the repository, then deploy again.`,
        ],
      )}; exit 1; fi; done\n`;

    it('produces the enabled patches in filePath order against the app code tree (known literal)', async () => {
      const { ownerCtx, application } = await setUpServices();
      await patches.create(ownerCtx, {
        filePath: 'src/old.ts',
        content: '',
        type: 'delete',
        applicationId: application.applicationId,
      });
      await patches.create(ownerCtx, {
        filePath: 'src/config.ts',
        content: 'export const DEBUG = true;\n',
        applicationId: application.applicationId,
      });
      const disabled = await patches.create(ownerCtx, {
        filePath: 'src/skipped.ts',
        content: 'nope\n',
        applicationId: application.applicationId,
      });
      await patches.toggleEnabled(ownerCtx, disabled.patchId, false);

      const command = await patches.generateApplyPatchesCommand({
        id: application.applicationId,
        type: 'application',
        // The platform host. These two tests are about the block's *words*;
        // which root a machine answers with is `the root it writes each patch
        // under` below, in this same file — the reference named a
        // `patch-apply-roots.e2e-spec.ts` that has never existed. The
        // root is still the platform host's own, taken from the machine rather
        // than spelled, because it is only `/etc/cloudgate` while
        // CLOUDGATE_DIRECTORY is unset.
        serverId: null,
      });

      const code = `${platformHostRoot()}/applications/blog-app/code`;
      expect(command).toBe(
        'echo "Applying 2 patch(es)...";' +
          // Every check before any write; a delete's own last component may
          // be a link, since `rm` removes the link.
          linkSegment('src/config.ts', [
            `${code}/src`,
            `${code}/src/config.ts`,
          ]) +
          linkSegment('src/old.ts', [`${code}/src`]) +
          writeSegment(
            `${platformHostRoot()}/applications/blog-app/code/src/config.ts`,
            'ZXhwb3J0IGNvbnN0IERFQlVHID0gdHJ1ZTsK',
          ) +
          deleteSegment(
            `${platformHostRoot()}/applications/blog-app/code/src/old.ts`,
          ),
      );
    });

    it('targets the compose code tree for compose patches and returns "" with none', async () => {
      const { ownerCtx, compose } = await setUpServices();

      expect(
        await patches.generateApplyPatchesCommand({
          id: compose.composeId,
          type: 'compose',
          serverId: null,
        }),
      ).toBe('');

      await patches.create(ownerCtx, {
        filePath: 'docker-compose.yml',
        content: 'services:\n  web:\n    image: nginx\n',
        composeId: compose.composeId,
      });

      expect(
        await patches.generateApplyPatchesCommand({
          id: compose.composeId,
          type: 'compose',
          serverId: null,
        }),
      ).toBe(
        'echo "Applying 1 patch(es)...";' +
          linkSegment('docker-compose.yml', [
            `${platformHostRoot()}/compose/blog-stack/code/docker-compose.yml`,
          ]) +
          writeSegment(
            `${platformHostRoot()}/compose/blog-stack/code/docker-compose.yml`,
            'c2VydmljZXM6CiAgd2ViOgogICAgaW1hZ2U6IG5naW54Cg==',
          ),
      );
    });

    /**
     * Which **root** the patch block writes under, and the sixth call site of
     * `applicationsDirectoryOn` that the first five missed.
     *
     * The two arms above resolved `composeDirectory()`/`applicationsDirectory()`
     * — `localCloudgateDirectory()`, *this process's* root — for every machine
     * alike, while the block is spliced into a program `DeploymentEngineService`
     * dispatches to the machine holding the clone. With `CLOUDGATE_DIRECTORY`
     * unset the two roots are the same literal, so the two assertions above —
     * which take the platform host's root from the machine — cannot
     * tell the roots apart in a run that leaves it unset. That is why these
     * set the variable themselves and name the *resolved* temp path, rather
     * than depend on what the run was started with.
     *
     * **The application arm is a live failure rather than a misplaced
     * directory, and that is what makes it worth its own tests.** It is a
     * second *writer* into the source tree, beside `codeDirectory`'s clone —
     * the root change enumerated the paths a **Delete** names and so did not see it. On an
     * install with a dedicated build Server and this variable set, the block
     * `mkdir -p`'d and `base64 -d >`'d each patched file at
     * `{local}/applications/{appName}/code/...` on the builder while the clone
     * had written `{remote}/applications/{appName}/code`. `mkdir -p` succeeds,
     * so `set -e` never fired: the deploy went green having applied no patch,
     * and built the unpatched tree.
     */
    describe('the root it writes each patch under', () => {
      const configuredRoot = fs.realpathSync(
        fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-patch-root-')),
      );
      const originalRoot = process.env.CLOUDGATE_DIRECTORY;

      beforeEach(() => {
        process.env.CLOUDGATE_DIRECTORY = configuredRoot;
      });

      afterEach(() => {
        if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
        else process.env.CLOUDGATE_DIRECTORY = originalRoot;
      });

      afterAll(() => {
        fs.rmSync(configuredRoot, { recursive: true, force: true });
      });

      it('writes an Application’s patch under the build host’s own root', async () => {
        const { ownerCtx, application } = await setUpServices();
        await patches.create(ownerCtx, {
          filePath: 'src/config.ts',
          content: 'export const DEBUG = true;\n',
          applicationId: application.applicationId,
        });

        const command = await patches.generateApplyPatchesCommand({
          id: application.applicationId,
          type: 'application',
          serverId: 'srv-build',
        });

        expect(command).toContain(
          `file=${quote([`${REMOTE_CLOUDGATE_DIRECTORY}/applications/blog-app/code/src/config.ts`])}`,
        );
        // The whole defect in one line: not one word of this instance's own
        // layout may reach a machine that has never heard of it.
        expect(command).not.toContain(configuredRoot);
      });

      it('writes a stack’s patch under the stack’s own Server’s root', async () => {
        const { ownerCtx, compose } = await setUpServices();
        await patches.create(ownerCtx, {
          filePath: 'docker-compose.yml',
          content: 'services:\n  web:\n    image: nginx\n',
          composeId: compose.composeId,
        });

        const command = await patches.generateApplyPatchesCommand({
          id: compose.composeId,
          type: 'compose',
          serverId: 'srv-stack',
        });

        expect(command).toContain(
          `file=${quote([`${REMOTE_CLOUDGATE_DIRECTORY}/compose/blog-stack/code/docker-compose.yml`])}`,
        );
        expect(command).not.toContain(configuredRoot);
      });

      /**
       * The branch that has to keep working: a build in this process patches
       * where this process can write, which is the whole reason
       * `CLOUDGATE_DIRECTORY` exists. A `delete` patch, because that arm
       * emits the path through a different template than the write.
       */
      it('keeps a platform-host patch under this instance’s configured root', async () => {
        const { ownerCtx, application } = await setUpServices();
        await patches.create(ownerCtx, {
          filePath: 'src/old.ts',
          content: '',
          type: 'delete',
          applicationId: application.applicationId,
        });

        const command = await patches.generateApplyPatchesCommand({
          id: application.applicationId,
          type: 'application',
          serverId: null,
        });

        expect(command).toContain(
          `rm -f -- ${quote([`${configuredRoot}/applications/blog-app/code/src/old.ts`])}`,
        );
        expect(command).not.toContain(REMOTE_CLOUDGATE_DIRECTORY);
      });

      /**
       * **The composition, and the reason the parameter is a parameter.**
       * `PatchService` cannot derive the build host: `findParentService`
       * projects `SERVICE_TABLES[…].serverId`, the *run* Server, and no
       * `buildServerId` — so a derivation here would have been confidently
       * wrong for exactly the install the defect is reachable on. The engine
       * passes `buildHostServerId`'s answer instead, and this asserts the two
       * halves meet: the patch block names the directory the clone in the same
       * program wrote, taken from that clone's own words rather than restated.
       */
      it('patches the tree the clone in its own program wrote', async () => {
        const { ownerCtx, application } = await setUpServices();
        await applications.update(ownerCtx, application.applicationId, {
          sourceType: 'git',
          customGitUrl: 'https://git.example.com/acme/blog.git',
          customGitBranch: 'main',
        });
        await patches.create(ownerCtx, {
          filePath: 'src/config.ts',
          content: 'export const DEBUG = true;\n',
          applicationId: application.applicationId,
        });

        const deployable = await applications.findDeployable(
          application.applicationId,
        );
        await engine.deploy(deployable);

        const program = execMock.execAsync.mock.calls
          .map((call) => call[0])
          .find((command) =>
            command.includes('git -c protocol.file.allow=never clone'),
          );
        expect(program).toBeDefined();
        // Read off the clone rather than restated: the expectation is the
        // directory the writer named, so a root that forks between the two
        // fails here whichever of them is wrong.
        const tree = `${configuredRoot}/applications/blog-app/code`;
        expect(program).toContain(`${tree}`);
        expect(program).toContain(`file=${quote([`${tree}/src/config.ts`])}`);
        expect(program).not.toContain(REMOTE_CLOUDGATE_DIRECTORY);
      });
    });
  });

  describe('deploy integration', () => {
    it('applies patches between clone and build for a non-docker application deploy', async () => {
      const { ownerCtx, application } = await setUpServices();
      await applications.update(ownerCtx, application.applicationId, {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/blog.git',
        customGitBranch: 'main',
      });
      await patches.create(ownerCtx, {
        filePath: 'src/config.ts',
        content: 'export const DEBUG = true;\n',
        applicationId: application.applicationId,
      });

      const deployable = await applications.findDeployable(
        application.applicationId,
      );
      await engine.deploy(deployable);

      const command = execMock.execAsync.mock.calls
        .map((call) => call[0])
        .find((c) => c.includes('git -c protocol.file.allow=never clone'));
      expect(command).toBeDefined();
      expect(command).toContain('echo "Applying 1 patch(es)...";');
      expect(command).toContain(
        'echo "ZXhwb3J0IGNvbnN0IERFQlVHID0gdHJ1ZTsK" | base64 -d > "$file"',
      );
      expect(
        command!.indexOf('git -c protocol.file.allow=never clone'),
      ).toBeLessThan(command!.indexOf('Applying 1 patch(es)'));
      expect(command!.indexOf('Applying 1 patch(es)')).toBeLessThan(
        command!.indexOf('nixpacks build'),
      );
    });

    it('skips patches for a docker-sourced application deploy', async () => {
      const { ownerCtx, application } = await setUpServices();
      await applications.update(ownerCtx, application.applicationId, {
        sourceType: 'docker',
        dockerImage: 'nginx:latest',
      });
      await patches.create(ownerCtx, {
        filePath: 'src/config.ts',
        content: 'export const DEBUG = true;\n',
        applicationId: application.applicationId,
      });

      const deployable = await applications.findDeployable(
        application.applicationId,
      );
      await engine.deploy(deployable);

      const command = execMock.execAsync.mock.calls[0][0];
      expect(command).not.toContain('Applying');
    });

    it('applies patches as their own logged step after clone for a git compose deploy', async () => {
      const { ownerCtx, compose } = await setUpServices();
      await composeService.update(ownerCtx, compose.composeId, {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/stack.git',
        customGitBranch: 'main',
      });
      await patches.create(ownerCtx, {
        filePath: 'docker-compose.yml',
        content: 'services:\n  web:\n    image: nginx\n',
        composeId: compose.composeId,
      });
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve({
          stdout: command.startsWith('cat ')
            ? 'services:\n  web:\n    image: nginx\n'
            : '',
          stderr: '',
          exitCode: 0,
        }),
      );

      const deployable = await composeService.findDeployable(compose.composeId);
      await engine.deployCompose(deployable);

      const commands = execMock.execAsync.mock.calls.map((call) => call[0]);
      // clone → apply patches → cat compose file → build.
      const patchStep = commands.find((command) =>
        command.includes('Applying 1 patch(es)'),
      );
      expect(patchStep).toBeDefined();
      expect(patchStep!.startsWith('(set -e;\n')).toBe(true);
      expect(patchStep!.includes('docker-compose.yml')).toBe(true);
      // Its output appended to the Deployment log, with stdin closed as the
      // run target closes it on every logged step (`appendingTo`).
      expect(patchStep!.endsWith('2>&1 < /dev/null')).toBe(true);
      expect(
        commands.findIndex((c) =>
          c.includes('git -c protocol.file.allow=never clone'),
        ),
      ).toBeLessThan(commands.indexOf(patchStep!));
      expect(commands.indexOf(patchStep!)).toBeLessThan(
        commands.findIndex((c) => c.startsWith('cat ')),
      );
    });

    it('does not run a patch step for raw compose or when no patches exist', async () => {
      const { ownerCtx, compose } = await setUpServices();

      // Raw source: patches never apply to a raw compose stack, which has no
      // repository to patch.
      await composeService.update(ownerCtx, compose.composeId, {
        sourceType: 'raw',
        composeFile: 'services:\n  web:\n    image: nginx\n',
      });
      await patches.create(ownerCtx, {
        filePath: 'docker-compose.yml',
        content: 'ignored\n',
        composeId: compose.composeId,
      });
      let deployable = await composeService.findDeployable(compose.composeId);
      await engine.deployCompose(deployable);
      expect(
        execMock.execAsync.mock.calls.some((call) =>
          call[0].includes('Applying'),
        ),
      ).toBe(false);

      // Git source with zero patches: the empty command is not exec'd.
      execMock.execAsync.mockClear();
      const second = await composeService.create(ownerCtx, {
        name: 'Stack 2',
        appName: 'blog-stack-2',
        environmentId: compose.environmentId,
      });
      await composeService.update(ownerCtx, second.composeId, {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/stack.git',
        customGitBranch: 'main',
      });
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve({
          stdout: command.startsWith('cat ')
            ? 'services:\n  web:\n    image: nginx\n'
            : '',
          stderr: '',
          exitCode: 0,
        }),
      );
      deployable = await composeService.findDeployable(second.composeId);
      await engine.deployCompose(deployable);
      expect(
        execMock.execAsync.mock.calls.some(
          (call) => call[0].match(/^\(set -e;\n\) >>/) !== null,
        ),
      ).toBe(false);
    });
  });

  describe('patch repos', () => {
    it('ensureRepo clones the source into the patch-repos tree and returns its path', async () => {
      const { ownerCtx, application, compose } = await setUpServices();
      await applications.update(ownerCtx, application.applicationId, {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/blog.git',
        customGitBranch: 'main',
      });

      const repoPath = await patchRepos.ensureRepo(ownerCtx, {
        id: application.applicationId,
        type: 'application',
      });
      expect(repoPath).toBe(
        `${platformHostRoot()}/patch-repos/application/blog-app`,
      );

      const command = execMock.execAsync.mock.calls
        .map((call) => call[0])
        .find((c) => c.includes('git -c protocol.file.allow=never clone'));
      expect(command).toBeDefined();
      expect(command!.startsWith('set -e;')).toBe(true);
      expect(command).toContain('https://git.example.com/acme/blog.git');
      expect(command).toContain(
        `${platformHostRoot()}/patch-repos/application/blog-app`,
      );

      // Compose repos land under their own type segment.
      await composeService.update(ownerCtx, compose.composeId, {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/stack.git',
        customGitBranch: 'main',
      });
      expect(
        await patchRepos.ensureRepo(ownerCtx, {
          id: compose.composeId,
          type: 'compose',
        }),
      ).toBe(`${platformHostRoot()}/patch-repos/compose/blog-stack`);
    });

    it('readRepoDirectory parses git ls-tree output into a directory tree', async () => {
      const { ownerCtx, application } = await setUpServices();
      execMock.execAsync.mockResolvedValue({
        stdout: 'src/index.ts\nsrc/utils/helper.ts\nREADME.md\n',
        stderr: '',
        exitCode: 0,
      });

      const tree = await patchRepos.readRepoDirectory(ownerCtx, {
        id: application.applicationId,
        type: 'application',
      });

      expect(execMock.execAsync).toHaveBeenCalledWith(
        `cd "${platformHostRoot()}/patch-repos/application/blog-app" && git ls-tree -r --name-only HEAD`,
      );
      expect(tree).toEqual([
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
                {
                  name: 'helper.ts',
                  path: 'src/utils/helper.ts',
                  type: 'file',
                },
              ],
            },
          ],
        },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ]);
    });

    it('confines repo reads to the patch-repos tree', async () => {
      const { ownerCtx, application } = await setUpServices();

      // readRepoDirectory used to take the directory to list and confine it
      // here; it now derives it from the entity, so there is no caller-supplied
      // path left to reject (see repo-directories.e2e-spec.ts).
      await expect(
        patchRepos.readRepoFile(ownerCtx, {
          id: application.applicationId,
          type: 'application',
          filePath: '../../../etc/passwd',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('readRepoFile prefers stored patch content over the repo file', async () => {
      const { ownerCtx, application } = await setUpServices();
      execMock.execAsync.mockResolvedValue({
        stdout: 'original file content',
        stderr: '',
        exitCode: 0,
      });

      // No patch stored: the repo file is read.
      const fromRepo = await patchRepos.readRepoFile(ownerCtx, {
        id: application.applicationId,
        type: 'application',
        filePath: 'src/index.ts',
      });
      expect(fromRepo).toBe('original file content');
      expect(execMock.execAsync).toHaveBeenCalledWith(
        // Unquoted: the path is an argv word now, and `shell-quote`
        // emits a path with nothing to escape bare. `resolveRepoFilePath` is
        // still what confines it.
        `cat ${platformHostRoot()}/patch-repos/application/blog-app/src/index.ts`,
      );

      // A stored content patch wins without touching the repo.
      execMock.execAsync.mockClear();
      await patches.create(ownerCtx, {
        filePath: 'src/index.ts',
        content: 'patched content\n',
        applicationId: application.applicationId,
      });
      const fromPatch = await patchRepos.readRepoFile(ownerCtx, {
        id: application.applicationId,
        type: 'application',
        filePath: 'src/index.ts',
      });
      expect(fromPatch).toBe('patched content\n');
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('readRepoFile shows the doomed repo file for delete patches, with a fallback message', async () => {
      const { ownerCtx, application } = await setUpServices();
      await patches.markFileForDeletion(ownerCtx, {
        id: application.applicationId,
        type: 'application',
        filePath: 'src/old.ts',
      });

      execMock.execAsync.mockResolvedValue({
        stdout: 'content to be deleted',
        stderr: '',
        exitCode: 0,
      });
      const doomed = await patchRepos.readRepoFile(ownerCtx, {
        id: application.applicationId,
        type: 'application',
        filePath: 'src/old.ts',
      });
      expect(doomed).toBe('content to be deleted');

      execMock.execAsync.mockRejectedValue(new Error('cat: no such file'));
      const missing = await patchRepos.readRepoFile(ownerCtx, {
        id: application.applicationId,
        type: 'application',
        filePath: 'src/old.ts',
      });
      expect(missing).toBe(
        '(File not found in repo - will be removed if it exists)',
      );
    });

    it('cleanRepos wipes the patch-repos tree and is admin-gated', async () => {
      const { organizationId, ownerSession, ownerCtx } = await setUpServices();

      await patchRepos.cleanRepos(ownerCtx, {});
      expect(execMock.execAsync).toHaveBeenCalledWith(
        `rm -rf "${platformHostRoot()}/patch-repos"/* 2>/dev/null || true`,
      );

      // An unknown/cross-org serverId reads as absent.
      await expect(
        patchRepos.cleanRepos(ownerCtx, { serverId: 'not-a-server' }),
      ).rejects.toThrow(NotFoundException);

      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);
      await expect(patchRepos.cleanRepos(memberCtx, {})).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('row-level access', () => {
    it('denies a member without row access to the owning service', async () => {
      const { organizationId, ownerSession, ownerCtx, application } =
        await setUpServices();
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);
      const created = await patches.create(ownerCtx, {
        filePath: 'src/config.ts',
        content: 'v1\n',
        applicationId: application.applicationId,
      });

      await expect(
        patches.create(memberCtx, {
          filePath: 'src/other.ts',
          content: 'x\n',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(patches.findOne(memberCtx, created.patchId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        patches.byEntityId(memberCtx, {
          id: application.applicationId,
          type: 'application',
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        patches.update(memberCtx, created.patchId, { content: 'x\n' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        patches.toggleEnabled(memberCtx, created.patchId, false),
      ).rejects.toThrow(ForbiddenException);
      await expect(patches.remove(memberCtx, created.patchId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        patches.saveFileAsPatch(memberCtx, {
          id: application.applicationId,
          type: 'application',
          filePath: 'src/config.ts',
          content: 'x\n',
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        patches.markFileForDeletion(memberCtx, {
          id: application.applicationId,
          type: 'application',
          filePath: 'src/config.ts',
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        patchRepos.ensureRepo(memberCtx, {
          id: application.applicationId,
          type: 'application',
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        patchRepos.readRepoDirectory(memberCtx, {
          id: application.applicationId,
          type: 'application',
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        patchRepos.readRepoFile(memberCtx, {
          id: application.applicationId,
          type: 'application',
          filePath: 'src/config.ts',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hides patches and owning services from other organizations', async () => {
      const { ownerSession, ownerCtx, application } = await setUpServices();
      const created = await patches.create(ownerCtx, {
        filePath: 'src/config.ts',
        content: 'v1\n',
        applicationId: application.applicationId,
      });

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        patches.findOne(secondOrgCtx, created.patchId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        patches.create(secondOrgCtx, {
          filePath: 'src/other.ts',
          content: 'x\n',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        patches.byEntityId(secondOrgCtx, {
          id: application.applicationId,
          type: 'application',
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        patchRepos.ensureRepo(secondOrgCtx, {
          id: application.applicationId,
          type: 'application',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('HTTP surface', () => {
    it('replaces the first patch when a second is added for the same path, on both parents', async () => {
      const { ownerSession, application, compose } = await setUpServices();

      for (const parent of [
        { applicationId: application.applicationId },
        { composeId: compose.composeId },
      ]) {
        const first = await request(server)
          .post('/patches')
          .set('Cookie', ownerSession.cookie)
          .send({
            filePath: 'public/ui-patch.txt',
            content: 'ui-patch-created\n',
            type: 'create',
            ...parent,
          });
        expect(first.status).toBe(201);

        // Not a unique violation surfacing as a 500: the field hint promises
        // that a second save for the same path replaces the first.
        const second = await request(server)
          .post('/patches')
          .set('Cookie', ownerSession.cookie)
          .send({
            filePath: 'public/ui-patch.txt',
            content: 'ui-patch-created-again\n',
            ...parent,
          });
        expect(second.status).toBe(201);
        expect(second.body).toMatchObject({
          patchId: (first.body as { patchId: string }).patchId,
          filePath: 'public/ui-patch.txt',
          content: 'ui-patch-created-again\n',
          // Replaced, not merged: a second save with no `type` is the default
          // a first save with none would have been.
          type: 'update',
          enabled: true,
        });

        const listed = await request(server)
          .get('/patches')
          .query(
            'applicationId' in parent
              ? { id: parent.applicationId, type: 'application' }
              : { id: parent.composeId, type: 'compose' },
          )
          .set('Cookie', ownerSession.cookie);
        expect(listed.status).toBe(200);
        expect(listed.body).toHaveLength(1);
      }
    });

    it('refuses to clone a source that has no repository, naming the source', async () => {
      const { ownerSession, ownerCtx, application, compose } =
        await setUpServices();

      await applications.update(ownerCtx, application.applicationId, {
        sourceType: 'docker',
        dockerImage: 'nginx:latest',
      });
      const image = await request(server)
        .post('/patches/repo/ensure')
        .set('Cookie', ownerSession.cookie)
        .send({ id: application.applicationId, type: 'application' });
      expect(image.status).toBe(409);
      expect((image.body as { message: string }).message).toBe(
        'This Application runs a prebuilt Docker image, so it has no repository to clone',
      );

      await applications.update(ownerCtx, application.applicationId, {
        sourceType: 'drop',
      });
      const dropped = await request(server)
        .post('/patches/repo/ensure')
        .set('Cookie', ownerSession.cookie)
        .send({ id: application.applicationId, type: 'application' });
      expect(dropped.status).toBe(409);
      expect((dropped.body as { message: string }).message).toBe(
        'This Application builds from uploaded files, so it has no repository to clone',
      );

      await composeService.update(ownerCtx, compose.composeId, {
        sourceType: 'raw',
      });
      const raw = await request(server)
        .post('/patches/repo/ensure')
        .set('Cookie', ownerSession.cookie)
        .send({ id: compose.composeId, type: 'compose' });
      expect(raw.status).toBe(409);
      expect((raw.body as { message: string }).message).toBe(
        'This Compose stack is a compose file written in Cloudgate, so it has no repository to clone',
      );

      // Refused before anything ran on the Server, rather than after a bare
      // `set -e;` that answered 200 with a path nothing was cloned into.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('drives the full patch lifecycle through the controller', async () => {
      const { ownerSession, application } = await setUpServices();

      const invalid = await request(server)
        .post('/patches')
        .set('Cookie', ownerSession.cookie)
        .send({ content: 'no file path' });
      expect(invalid.status).toBe(400);

      const created = await request(server)
        .post('/patches')
        .set('Cookie', ownerSession.cookie)
        .send({
          filePath: 'src/config.ts',
          content: 'v1\n',
          applicationId: application.applicationId,
        });
      expect(created.status).toBe(201);
      const { patchId } = created.body as { patchId: string };

      const listed = await request(server)
        .get('/patches')
        .query({ id: application.applicationId, type: 'application' })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);

      const found = await request(server)
        .get(`/patches/${patchId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ filePath: 'src/config.ts' });

      const updated = await request(server)
        .patch(`/patches/${patchId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ content: 'v2' });
      expect(updated.status).toBe(200);
      expect((updated.body as { content: string }).content).toBe('v2\n');

      const toggled = await request(server)
        .post(`/patches/${patchId}/toggle`)
        .set('Cookie', ownerSession.cookie)
        .send({ enabled: false });
      expect(toggled.status).toBe(200);
      expect((toggled.body as { enabled: boolean }).enabled).toBe(false);

      const saved = await request(server)
        .post('/patches/save-file')
        .set('Cookie', ownerSession.cookie)
        .send({
          id: application.applicationId,
          type: 'application',
          filePath: 'src/new.ts',
          content: 'fresh\n',
        });
      expect(saved.status).toBe(200);
      expect((saved.body as { type: string }).type).toBe('update');

      const marked = await request(server)
        .post('/patches/mark-for-deletion')
        .set('Cookie', ownerSession.cookie)
        .send({
          id: application.applicationId,
          type: 'application',
          filePath: 'src/doomed.ts',
        });
      expect(marked.status).toBe(200);
      expect((marked.body as { type: string }).type).toBe('delete');

      const removed = await request(server)
        .delete(`/patches/${patchId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/patches/${patchId}`)
        .set('Cookie', ownerSession.cookie);
      expect(gone.status).toBe(404);
    });

    it('exposes the repo surface and admin-gates the clean endpoint', async () => {
      const { ownerSession, ownerCtx, application } = await setUpServices();
      await applications.update(ownerCtx, application.applicationId, {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/blog.git',
        customGitBranch: 'main',
      });

      const ensured = await request(server)
        .post('/patches/repo/ensure')
        .set('Cookie', ownerSession.cookie)
        .send({ id: application.applicationId, type: 'application' });
      expect(ensured.status).toBe(200);
      expect(ensured.text).toBe(
        `${platformHostRoot()}/patch-repos/application/blog-app`,
      );

      execMock.execAsync.mockResolvedValue({
        stdout: 'README.md\n',
        stderr: '',
        exitCode: 0,
      });
      const tree = await request(server)
        .get('/patches/repo/directories')
        .query({
          id: application.applicationId,
          type: 'application',
          // What an old frontend sent back: the path `ensure` answered with.
          // The schema strips it (see repo-directories.e2e-spec.ts).
          repoPath: ensured.text,
        })
        .set('Cookie', ownerSession.cookie);
      expect(tree.status).toBe(200);
      expect(tree.body).toEqual([
        { name: 'README.md', path: 'README.md', type: 'file' },
      ]);

      execMock.execAsync.mockResolvedValue({
        stdout: 'file body',
        stderr: '',
        exitCode: 0,
      });
      const file = await request(server)
        .get('/patches/repo/file')
        .query({
          id: application.applicationId,
          type: 'application',
          filePath: 'README.md',
        })
        .set('Cookie', ownerSession.cookie);
      expect(file.status).toBe(200);
      expect(file.text).toBe('file body');

      const cleaned = await request(server)
        .post('/patches/repo/clean')
        .set('Cookie', ownerSession.cookie)
        .send({});
      expect(cleaned.status).toBe(200);
      expect(cleaned.text).toBe('true');

      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberClean = await request(server)
        .post('/patches/repo/clean')
        .set('Cookie', member.cookie)
        .send({});
      expect(memberClean.status).toBe(403);
      const memberCreate = await request(server)
        .post('/patches')
        .set('Cookie', member.cookie)
        .send({
          filePath: 'src/x.ts',
          content: 'x\n',
          applicationId: application.applicationId,
        });
      expect(memberCreate.status).toBe(403);
    });
  });

  describe('CRUD', () => {
    it('creates an application patch retrievable by id, defaulting type/enabled', async () => {
      const { ownerCtx, application } = await setUpServices();

      const created = await patches.create(ownerCtx, {
        filePath: 'src/config.ts',
        content: 'export const DEBUG = true;\n',
        applicationId: application.applicationId,
      });

      expect(created.patchId).toEqual(expect.any(String));
      // The defaults: type update, enabled forced true on create.
      expect(created.type).toBe('update');
      expect(created.enabled).toBe(true);
      expect(created.applicationId).toBe(application.applicationId);
      expect(created.composeId).toBeNull();

      const found = await patches.findOne(ownerCtx, created.patchId);
      expect(found).toMatchObject({
        patchId: created.patchId,
        filePath: 'src/config.ts',
        content: 'export const DEBUG = true;\n',
      });
    });

    it('creates a compose patch and rejects a patch with no owning service', async () => {
      const { ownerCtx, compose } = await setUpServices();

      const created = await patches.create(ownerCtx, {
        filePath: 'docker-compose.yml',
        content: 'services: {}\n',
        composeId: compose.composeId,
      });
      expect(created.composeId).toBe(compose.composeId);
      expect(created.applicationId).toBeNull();

      // 400: "Either applicationId or composeId must be provided".
      await expect(
        patches.create(ownerCtx, {
          filePath: 'orphan.txt',
          content: '',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('lists an entity patches ordered by filePath', async () => {
      const { ownerCtx, application, compose } = await setUpServices();
      await patches.create(ownerCtx, {
        filePath: 'zz-last.ts',
        content: 'z\n',
        applicationId: application.applicationId,
      });
      await patches.create(ownerCtx, {
        filePath: 'aa-first.ts',
        content: 'a\n',
        applicationId: application.applicationId,
      });
      await patches.create(ownerCtx, {
        filePath: 'compose-only.yml',
        content: 'c\n',
        composeId: compose.composeId,
      });

      const listed = await patches.byEntityId(ownerCtx, {
        id: application.applicationId,
        type: 'application',
      });
      expect(listed.map((p) => p.filePath)).toEqual([
        'aa-first.ts',
        'zz-last.ts',
      ]);

      const composePatches = await patches.byEntityId(ownerCtx, {
        id: compose.composeId,
        type: 'compose',
      });
      expect(composePatches.map((p) => p.filePath)).toEqual([
        'compose-only.yml',
      ]);
    });

    it('updates a patch appending a missing trailing newline and bumps updatedAt', async () => {
      const { ownerCtx, application } = await setUpServices();
      const created = await patches.create(ownerCtx, {
        filePath: 'src/config.ts',
        content: 'v1\n',
        applicationId: application.applicationId,
      });

      const updated = await patches.update(ownerCtx, created.patchId, {
        content: 'v2 without newline',
      });
      expect(updated.content).toBe('v2 without newline\n');
      expect(updated.updatedAt).not.toBe(created.updatedAt);

      const kept = await patches.update(ownerCtx, created.patchId, {
        content: 'v3 with newline\n',
      });
      expect(kept.content).toBe('v3 with newline\n');
    });

    it('saveFileAsPatch creates on first save and updates the same row after', async () => {
      const { ownerCtx, application } = await setUpServices();

      const created = await patches.saveFileAsPatch(ownerCtx, {
        id: application.applicationId,
        type: 'application',
        filePath: 'src/index.ts',
        content: 'v1\n',
        patchType: 'update',
      });
      expect(created.type).toBe('update');
      expect(created.content).toBe('v1\n');

      const updated = await patches.saveFileAsPatch(ownerCtx, {
        id: application.applicationId,
        type: 'application',
        filePath: 'src/index.ts',
        content: 'v2\n',
        patchType: 'create',
      });
      expect(updated.patchId).toBe(created.patchId);
      expect(updated.type).toBe('create');
      expect(updated.content).toBe('v2\n');

      const listed = await patches.byEntityId(ownerCtx, {
        id: application.applicationId,
        type: 'application',
      });
      expect(listed).toHaveLength(1);
    });

    it('markFileForDeletion converts an existing patch and creates a delete patch otherwise', async () => {
      const { ownerCtx, application } = await setUpServices();
      const existing = await patches.create(ownerCtx, {
        filePath: 'src/old.ts',
        content: 'old content\n',
        applicationId: application.applicationId,
      });

      const converted = await patches.markFileForDeletion(ownerCtx, {
        id: application.applicationId,
        type: 'application',
        filePath: 'src/old.ts',
      });
      expect(converted.patchId).toBe(existing.patchId);
      expect(converted.type).toBe('delete');
      expect(converted.content).toBe('');

      const fresh = await patches.markFileForDeletion(ownerCtx, {
        id: application.applicationId,
        type: 'application',
        filePath: 'src/never-patched.ts',
      });
      expect(fresh.patchId).not.toBe(existing.patchId);
      expect(fresh.type).toBe('delete');
      expect(fresh.content).toBe('');
      expect(fresh.applicationId).toBe(application.applicationId);
    });

    it('encrypts patch content at rest', async () => {
      const { ownerCtx, application } = await setUpServices();
      const created = await patches.create(ownerCtx, {
        filePath: 'src/secrets.env',
        content: 'API_KEY=super-secret\n',
        applicationId: application.applicationId,
      });

      const raw = await ctx.db.execute(
        sql`SELECT content FROM patch WHERE patch_id = ${created.patchId}`,
      );
      const stored = (raw.rows[0] as { content: string }).content;
      expect(stored).not.toContain('API_KEY=super-secret');
    });

    it('toggles enabled and deletes a patch', async () => {
      const { ownerCtx, application } = await setUpServices();
      const created = await patches.create(ownerCtx, {
        filePath: 'src/config.ts',
        content: 'v1\n',
        applicationId: application.applicationId,
      });

      const toggled = await patches.toggleEnabled(
        ownerCtx,
        created.patchId,
        false,
      );
      expect(toggled.enabled).toBe(false);

      const removed = await patches.remove(ownerCtx, created.patchId);
      expect(removed.patchId).toBe(created.patchId);
      await expect(patches.findOne(ownerCtx, created.patchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
