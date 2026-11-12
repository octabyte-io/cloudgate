import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import { isLeftOutOfCatalogue } from 'cloudgate-template-check';
import type { CatalogueFolder } from 'cloudgate-template-check';

import { usageError } from './errors.js';

/**
 * The template folders at `path`, read as `cg-templates` holds them: `path`
 * is one template folder (it holds a `template.yaml`), or a folder of
 * template folders. `template check` and `template pack` both start here, so
 * a folder is checked exactly as it is packed.
 *
 * Every file is read except the website's (`index.md`, `screenshots/`) and
 * `test-values.yaml`, which `encodeCatalogue` would leave out anyway;
 * skipping them here only spares reading the screenshots. Any other file is kept, so the check names
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
  return folders.map((folder) => ({
    id: basename(folder),
    revision,
    files: filesUnder(folder),
  }));
}

/** Whether `path` is a folder, refusing one that does not exist (exit 2). */
export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    throw usageError(`${path} does not exist`);
  }
}

function isTemplateFolder(path: string): boolean {
  try {
    return statSync(join(path, 'template.yaml')).isFile();
  } catch {
    return false;
  }
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
