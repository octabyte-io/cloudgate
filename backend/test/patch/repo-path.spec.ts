import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import { resolveRepoPath } from '../../src/patch/patch-repo.service';

/**
 * The one expression behind an entity's patch-repo clone: `ensureRepo` clones
 * into it, both read routes read from it and the Delete's `rm -rf` names it, so
 * they cannot disagree about which directory a patch applies to.
 *
 * It is built from a `z.enum` type, an `appName` off the row and
 * the machine that holds the clone. `appName` is regex-constrained
 * (`APP_NAME_REGEX`) on the create DTOs, but `ComposeService.createByTemplate`
 * — the templates and AI deploy paths — inserts one that has only been through
 * `cleanAppName` (trim, lowercase, spaces to hyphens), so the derived path is
 * checked rather than trusted: it gets interpolated into a double-quoted shell
 * word exactly like `resolveRepoFilePath`'s.
 */
describe('resolveRepoPath', () => {
  it('derives the clone directory under the entity type', () => {
    // `null` is the platform host, whose root is this process's
    // CLOUDGATE_DIRECTORY — `/etc/cloudgate` only while that is unset — so it
    // is asked of the machine rather than spelled. From
    // `cloudgateDirectoryOn`, not the `patchReposDirectoryOn` this derives it
    // with, so the `patch-repos` segment is still pinned here.
    const root = cloudgateDirectoryOn(null);
    expect(resolveRepoPath('application', 'blog-app', null)).toBe(
      `${root}/patch-repos/application/blog-app`,
    );
    expect(resolveRepoPath('compose', 'blog-stack', null)).toBe(
      `${root}/patch-repos/compose/blog-stack`,
    );
    // The dots and underscores APP_NAME_REGEX allows are ordinary names.
    expect(resolveRepoPath('application', 'my_app.v2-x4k2m9', null)).toBe(
      `${root}/patch-repos/application/my_app.v2-x4k2m9`,
    );
  });

  /**
   * Which **root** the clone sits under, and the reason this block has to set
   * `CLOUDGATE_DIRECTORY` to say anything.
   *
   * The expectations above take the platform host's root from the machine
   * and in a run that leaves the variable unset they still pass
   * whichever root is resolved, because this instance's root and the
   * `/etc/cloudgate` literal `serverSetupCommand` creates on a Server are then
   * the *same string* — and every one of them passes `null`, so none asks a
   * Server at all. That is why the defect was invisible and why nothing there
   * could have caught it: the path was `localCloudgateDirectory()` for every
   * machine alike, so a clone dispatched to a build Server was written and
   * removed under a root that Server never had — captured live in an earlier run
   * as a delete report naming a local temp path as a directory on a remote
   * builder.
   *
   * The temp directory is real and every expectation names the resolved path,
   * because `/etc/cloudgate` exists and is writable on some development hosts
   * and a silent fall back to the default would read as a pass.
   */
  describe('the root it derives the clone under', () => {
    const configured = fs.realpathSync(
      fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-repo-path-')),
    );
    const original = process.env.CLOUDGATE_DIRECTORY;

    beforeEach(() => {
      process.env.CLOUDGATE_DIRECTORY = configured;
    });

    afterEach(() => {
      if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
      else process.env.CLOUDGATE_DIRECTORY = original;
    });

    afterAll(() => {
      fs.rmSync(configured, { recursive: true, force: true });
    });

    it('is the Server’s own root when a machine holds the clone', () => {
      expect(resolveRepoPath('application', 'blog-app', 'srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/patch-repos/application/blog-app`,
      );
      expect(resolveRepoPath('compose', 'blog-stack', 'srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/patch-repos/compose/blog-stack`,
      );
    });

    // The branch that has to keep working, and the whole reason
    // CLOUDGATE_DIRECTORY exists: a clone on the platform host lives where
    // this process can actually write.
    it('is this instance’s configured root for the platform host', () => {
      expect(resolveRepoPath('application', 'blog-app', null)).toBe(
        `${configured}/patch-repos/application/blog-app`,
      );
    });

    // The single-segment guard is applied to the derived path, so it has to
    // hold under either root rather than only under the default.
    it('still refuses a traversing name under a configured root', () => {
      expect(() =>
        resolveRepoPath('application', '../compose/victim-stack', 'srv_123'),
      ).toThrow(BadRequestException);
      expect(() =>
        resolveRepoPath('application', '../compose/victim-stack', null),
      ).toThrow(BadRequestException);
    });
  });

  it.each([
    ['closes the shell quotes', 'blog" && id && echo "'],
    ['substitutes a command', 'blog$(id)'],
    ['substitutes with backticks', 'blog`id`'],
    ['expands a variable', 'blog$HOME'],
    ['escapes with a backslash', 'blog\\"'],
    ['smuggles a newline', 'blog\nid'],
    ['smuggles a carriage return', 'blog\rid'],
  ])('refuses an appName that %s', (_reason, appName) => {
    expect(() => resolveRepoPath('application', appName, null)).toThrow(
      BadRequestException,
    );
  });

  it.each([
    ['climbs out of the type segment', '..'],
    ['climbs out after descending', 'blog/../..'],
    ['climbs into another type', '../compose/victim-stack'],
    ['nests below the type segment', 'blog/sub'],
    ['names the type segment itself', '.'],
    ['is empty', ''],
  ])('refuses an appName that %s', (_reason, appName) => {
    expect(() => resolveRepoPath('application', appName, null)).toThrow(
      BadRequestException,
    );
  });
});
