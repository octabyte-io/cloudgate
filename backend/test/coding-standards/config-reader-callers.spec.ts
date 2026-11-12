import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * US53. The property, stated once:
 *
 * > builds and Preview deployments never read a Project config
 *
 * A build that read the config would stop when its repository could not be
 * reached, and would build with settings no plan reviewed. The config reader
 * port is the only way a repository-kept config is read, so the property
 * holds while nothing outside `src/project-config/` names the port: not the
 * token, not the interface, not an implementation. The deployment queue, the
 * deploy engine, previews and the push handlers all live elsewhere, so a
 * reach for the reader from any of them is a file this census reports.
 *
 * The last `it` is the gate on the gate: a walk that stopped finding the
 * port's own files would pass the first trivially.
 */

const srcRoot = join(__dirname, '..', '..', 'src');
const allowedRoot = join(srcRoot, 'project-config');

const PORT_NAMES =
  /\b(CONFIG_READER|ConfigReader|ConfigReaders|GithubConfigReader|GitlabConfigReader|GiteaConfigReader|BitbucketConfigReader|readOverRest|ConfigReadRequest|ConfigReadResult)\b|reader\/config-reader/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('CONFIG_READER, as the only way a Project config is read from a repository', () => {
  const files = sourceFiles(srcRoot);
  const naming = files.filter((file) =>
    PORT_NAMES.test(readFileSync(file, 'utf8')),
  );

  it('names the config reader port only inside src/project-config', () => {
    expect(
      naming
        .filter((file) => !file.startsWith(allowedRoot))
        .map((file) => relative(srcRoot, file)),
    ).toEqual([]);
  });

  it('finds the port and its callers it guards', () => {
    expect(naming.map((file) => relative(srcRoot, file))).toEqual(
      expect.arrayContaining([
        'project-config/reader/config-reader.port.ts',
        'project-config/reader/config-readers.ts',
        'project-config/config-locations.service.ts',
        'project-config/reader/repository-place.ts',
      ]),
    );
  });
});
