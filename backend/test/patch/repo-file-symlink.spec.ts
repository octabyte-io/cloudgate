import { BadRequestException, NotFoundException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ApplicationsService } from '../../src/applications/applications.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { PatchRepoService } from '../../src/patch/patch-repo.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { PermissionService } from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

const execFileAsync = promisify(execFile);

/**
 * `GET /patches/repo/file` against a clone that carries symlinks.
 *
 * `resolveRepoFilePath` confines the path's **text** to the clone
 * (`repo-file-path.spec.ts`), and the repository is the caller's own: a
 * committed `leak -> /etc/default/cloudgate-backend` passes the text check and
 * `cat` followed it, handing the platform host's secrets to any member who can
 * clone a repository. So the read now resolves the path on the machine that
 * holds the clone and refuses anything whose real path is outside it.
 *
 * The clone is real, on this machine, under a temporary
 * `CLOUDGATE_DIRECTORY`, and the platform host's argv exec is really run:
 * whether a symlink is followed is a property of the file system, and a double
 * would only answer what it was told to.
 */
describe('PatchRepoService.readRepoFile over symlinks', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-repo-symlink-')),
  );
  const clone = `${root}/patch-repos/application/blog-app`;
  const outside = `${root}/secrets.env`;
  const original = process.env.CLOUDGATE_DIRECTORY;

  const ctx: PermissionCtx = {
    user: { id: 'user-1' },
    session: { activeOrganizationId: 'org-a' },
  };

  beforeAll(() => {
    process.env.CLOUDGATE_DIRECTORY = root;
    fs.mkdirSync(`${clone}/src`, { recursive: true });
    fs.mkdirSync(`${root}/patch-repos/application/neighbour`, {
      recursive: true,
    });
    fs.writeFileSync(outside, 'STRIPE_SECRET_KEY=sk_live_x\n');
    fs.writeFileSync(
      `${root}/patch-repos/application/neighbour/.env`,
      'NEIGHBOUR=1\n',
    );
    fs.writeFileSync(`${clone}/README.md`, '# Blog\n');
    fs.writeFileSync(`${clone}/src/index.ts`, 'export {};\n');
    // Out of the clone: absolute, relative, into a sibling clone, and a
    // directory link with an ordinary file under it.
    fs.symlinkSync(outside, `${clone}/leak`);
    fs.symlinkSync('../../../secrets.env', `${clone}/relative-leak`);
    fs.symlinkSync('../neighbour/.env', `${clone}/neighbour-env`);
    fs.symlinkSync(root, `${clone}/up`);
    // Inside the clone: a file link and a directory link.
    fs.symlinkSync('README.md', `${clone}/readme-link`);
    fs.symlinkSync('src', `${clone}/source`);
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * The service with what `readRepoFile` reaches: a database answering the
   * owning Application and, on the patch branch, no stored Patch; the access
   * check passing; the Application building on the platform host; and the
   * platform host's argv exec, really run.
   */
  const service = () => {
    let reads = 0;
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'from', 'innerJoin', 'where']) {
      chain[method] = () => chain;
    }
    chain.limit = () =>
      Promise.resolve(
        reads++ === 0 ? [{ serviceId: 'app-1', appName: 'blog-app' }] : [],
      );
    const remoteExec = {
      execFileAsync: async (command: string, args: string[]) => {
        const { stdout, stderr } = await execFileAsync(command, args);
        return { stdout, stderr };
      },
    } as unknown as RemoteExecService;
    return new PatchRepoService(
      chain as unknown as DrizzleDB,
      {
        checkServiceAccess: () => Promise.resolve(),
      } as unknown as PermissionService,
      remoteExec,
      null as never,
      {
        findDeployable: () =>
          Promise.resolve({ serverId: null, buildServerId: null }),
      } as unknown as ApplicationsService,
      null as never,
      null as never,
    );
  };

  const read = (filePath: string, source?: 'patch' | 'repo') =>
    service().readRepoFile(ctx, {
      id: 'app-1',
      type: 'application',
      filePath,
      ...(source ? { source } : {}),
    });

  it.each([
    ['an absolute link out of the clone', 'leak'],
    ['a relative link out of the clone', 'relative-leak'],
    ['a link into a sibling clone', 'neighbour-env'],
    ['a file under a directory link out of the clone', 'up/secrets.env'],
  ])('refuses %s, on either source', async (_why, filePath) => {
    for (const source of [undefined, 'patch', 'repo'] as const) {
      await expect(read(filePath, source)).rejects.toThrow(
        new BadRequestException('Invalid path'),
      );
    }
  });

  it('still reads a link that stays inside the clone, and an ordinary file', async () => {
    expect(await read('readme-link', 'repo')).toBe('# Blog\n');
    expect(await read('source/index.ts')).toBe('export {};\n');
    expect(await read('README.md')).toBe('# Blog\n');
  });

  it('answers a file the clone does not have as not found, as before', async () => {
    await expect(read('nope.txt', 'repo')).rejects.toThrow(NotFoundException);
  });
});
