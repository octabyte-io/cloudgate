import { BadRequestException } from '@nestjs/common';
import { resolveRepoFilePath } from '../../src/patch/patch-repo.service';

/**
 * The confinement rule behind `GET /patches/repo/file`, at the pure seam.
 * A caller-supplied path may only name a file inside *this* entity's clone:
 * not the platform directory around it, not a sibling clone (which belongs to
 * another service, possibly another organization), and not the shell outside
 * the double quotes `cat` wraps it in.
 */
describe('resolveRepoFilePath', () => {
  const repo = '/etc/cloudgate/patch-repos/application/blog-app';

  it('resolves a repo-relative path into the clone', () => {
    expect(resolveRepoFilePath(repo, 'src/index.ts')).toBe(
      '/etc/cloudgate/patch-repos/application/blog-app/src/index.ts',
    );
    expect(resolveRepoFilePath(repo, 'README.md')).toBe(
      '/etc/cloudgate/patch-repos/application/blog-app/README.md',
    );
    // Dotfiles, spaces and dots inside a name are ordinary repository files.
    expect(resolveRepoFilePath(repo, '.github/workflows/ci (copy).yml')).toBe(
      '/etc/cloudgate/patch-repos/application/blog-app/.github/workflows/ci (copy).yml',
    );
  });

  it('confines an absolute path into the clone instead of honouring it', () => {
    expect(resolveRepoFilePath(repo, '/etc/passwd')).toBe(
      '/etc/cloudgate/patch-repos/application/blog-app/etc/passwd',
    );
  });

  it.each([
    ['climbs out of the platform directory', '../../../../etc/passwd'],
    ['climbs to the platform directory', '../../../etc/passwd'],
    ['climbs above the filesystem root', '../../../../../../etc/passwd'],
    ['climbs into a sibling clone', '../blog-app-evil/.env'],
    ['climbs into another entity type', '../../compose/victim-stack/.env'],
    ['climbs after descending', 'src/../../../../etc/shadow'],
    ['climbs with backslashes', '..\\..\\..\\etc\\passwd'],
    ['names the clone root itself', ''],
    ['names the clone root by dot', '.'],
    ['breaks out of the cat quotes', 'README.md"; cat /etc/passwd; echo "'],
    ['substitutes a command', 'README$(cat /etc/passwd).md'],
    ['substitutes with backticks', 'README`cat /etc/passwd`.md'],
    ['expands a variable', '$HOME/.ssh/id_rsa'],
    ['smuggles a newline', 'README.md\ncat /etc/passwd'],
  ])('refuses a path that %s', (_reason, filePath) => {
    expect(() => resolveRepoFilePath(repo, filePath)).toThrow(
      BadRequestException,
    );
  });
});
