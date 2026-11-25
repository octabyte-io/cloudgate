import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import {
  folderFile,
  isLeftOutOfCatalogue,
  spellingsOf,
} from 'cloudgate-template-check';
import type { CatalogueFolder } from 'cloudgate-template-check';

import { CliError, usageError } from './errors.js';
import { EXIT } from './exit-codes.js';

/**
 * The template folders at `path`, read as `cg-templates` holds them: `path`
 * is one template folder (it holds a `template.yaml` or `template.yml`), or
 * a folder of template folders. `template check` and `template pack` both start here, so
 * a folder is checked exactly as it is packed.
 *
 * Every file is read except the website's (`index.md`, `screenshots/`) and
 * the test values, which `encodeCatalogue` would leave out anyway;
 * skipping them here only spares reading the screenshots. Being left out,
 * the test values are the one file the check never sees, so a folder
 * holding both of their spellings is refused here (ADR-0090). Any other file is kept, so the check names
 * a stray one rather than this dropping it unseen (ADR-0072).
 */
export function templateFoldersAt(
  path: string,
  revision: string,
): CatalogueFolder[] {
  const folders = isTemplateFolder(path)
    ? [path]
    : readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => join(path, entry.name))
        .sort();
  return folders.map((folder) => {
    const testValues = testValuesIn(folder);
    if (testValues && 'both' in testValues) {
      throw new CliError(
        `${basename(folder)} holds both ${testValues.both.join(' and ')}; a template folder holds one`,
        EXIT.failed,
      );
    }
    return { id: basename(folder), revision, files: filesUnder(folder) };
  });
}

/**
 * The test values `template try` reads in `folder` (ADR-0078), under
 * whichever spelling it holds; null when there are none, and both paths
 * when it holds both.
 */
export function testValuesIn(folder: string) {
  const present = spellingsOf('test-values').filter((name) =>
    existsSync(join(folder, name)),
  );
  return folderFile(
    Object.fromEntries(present.map((name) => [name, join(folder, name)])),
    'test-values',
  );
}

/** Whether `path` is a folder, refusing one that does not exist (exit 2). */
export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    throw usageError(`${path} does not exist`);
  }
}

/** Whether `path` holds a `template.yaml` or `template.yml`. */
export function isTemplateFolder(path: string): boolean {
  return spellingsOf('template').some((name) => {
    try {
      return statSync(join(path, name)).isFile();
    } catch {
      return false;
    }
  });
}

/** Every file under `folder` but the website's, by its `/`-separated path inside it. */
function filesUnder(folder: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(folder, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const inFolder = relative(folder, full).split(sep).join('/');
    if (isLeftOutOfCatalogue(inFolder)) continue;
    files[inFolder] = readFileSync(full);
  }
  return files;
}
