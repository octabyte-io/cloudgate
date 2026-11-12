import { parse } from 'yaml';
import { z } from 'zod';

import {
  CATALOGUE_INDEX,
  CATALOGUE_MAX_BYTES,
  CATALOGUE_MAX_ENTRIES,
  CATALOGUE_UNPACKED_MAX_BYTES,
  CONFIG_FILES,
  TEMPLATE_CONFIG_FILES_MAX_BYTES,
  TEMPLATES_FOLDER,
  fileCap,
  isLeftOutOfCatalogue,
} from './catalogue-layout';
import { readZip, writeZip } from './catalogue-zip';
import type { ZipFile } from './catalogue-zip';
import { configPathProblem } from './template-files';

/**
 * `catalogue.zip`, the one file each `cg-templates` release publishes
 * (ADR-0072, amending ADR-0062's `catalogue.json`):
 *
 * ```
 * catalogue.json                { "format": 2, "templates": [ { "id": "ghost", "revision": "<commit>" } ] }
 * templates/ghost/template.yaml
 * templates/ghost/cloudgate.yaml
 * templates/ghost/docker-compose.yml
 * templates/ghost/files/…
 * templates/ghost/logo.svg
 * ```
 *
 * A template is its folder, file by file under the folder's own paths, so
 * the check reads exactly what an author wrote. The index names which
 * folders are templates and carries what a folder cannot: the revision.
 *
 * The one JSON file holding every file's text was replaced because it does
 * not scale: at a few hundred templates, logos written as base64 push it
 * past its 10 MB cap, and a catalogue over the cap is refused, so new
 * templates would quietly stop reaching installs. Reading `cg-templates`
 * live from `main` was rejected in #1403 (ADR-0072 says why).
 *
 * `templates` is a list rather than a map keyed by id because a JSON map
 * cannot hold a key twice: `JSON.parse` keeps the last, so a duplicated id
 * would vanish before anything could refuse it.
 */

/** The one format this Cloudgate reads. */
export const CATALOGUE_FORMAT = 2;

export { CATALOGUE_MAX_BYTES };

/** A file's content as the Template check reads it: text, or a PNG's bytes. */
export type CatalogueFileContent = string | { readonly base64: string };

/** One template, read out of the zip: its id, revision and folder. */
export interface CatalogueEntry {
  readonly id: string;
  /** The last catalogue commit that changed the folder. */
  readonly revision: string;
  /** By path inside the folder, `/`-separated. */
  readonly files: Readonly<Record<string, CatalogueFileContent>>;
}

const index = z.strictObject({
  format: z.number(),
  templates: z.array(
    z.strictObject({
      id: z.string(),
      revision: z.string().min(1, 'must not be empty'),
    }),
  ),
});

export type CatalogueRead =
  | { readonly ok: true; readonly entries: readonly CatalogueEntry[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The catalogue's templates, or the one reason the zip is refused as a
 * whole. Everything ADR-0072 lists is checked here, before any template is:
 * the zip's own safety, that it holds nothing but the files a template has,
 * that the index and the folders name the same templates, and every config
 * file's kind, text and size, and that its `template.yaml` lists it.
 *
 * What is left to the per-template check is what hides one template alone:
 * whether its files are a template this Cloudgate can offer.
 */
export function readCatalogueFile(bytes: Uint8Array): CatalogueRead {
  const refuse = (reason: string): CatalogueRead => ({
    ok: false,
    reason: `The catalogue ${reason}`,
  });
  if (bytes.byteLength > CATALOGUE_MAX_BYTES) {
    return refuse(
      `is ${megabytes(bytes.byteLength)} MB; a catalogue is at most ${megabytes(CATALOGUE_MAX_BYTES)} MB`,
    );
  }
  if (looksLikeJson(bytes)) {
    return refuse(
      'is a catalogue.json, the format before ADR-0072; this Cloudgate reads a catalogue.zip',
    );
  }
  // Every template folder the zip names, its folder entries included: the
  // reader returns files only, so a folder holding none would otherwise
  // pass unnamed by the index.
  const folderIds = new Set<string>();
  const zip = readZip(bytes, {
    maxEntries: CATALOGUE_MAX_ENTRIES,
    maxTotalBytes: CATALOGUE_UNPACKED_MAX_BYTES,
    fileCap: (path) => {
      const cap = fileCap(path);
      const rest = path.slice(TEMPLATES_FOLDER.length);
      if (typeof cap === 'number' && rest.includes('/')) {
        folderIds.add(rest.slice(0, rest.indexOf('/')));
      }
      return cap;
    },
  });
  if (!zip.ok) return refuse(zip.reason);

  const indexFile = zip.files.find((file) => file.path === CATALOGUE_INDEX);
  if (!indexFile) return refuse(`has no ${CATALOGUE_INDEX}`);
  const read = readIndex(indexFile.bytes);
  if (!read.ok) return refuse(read.reason);

  const folders = new Map<string, Record<string, CatalogueFileContent>>();
  for (const file of zip.files) {
    if (file.path === CATALOGUE_INDEX) continue;
    const rest = file.path.slice(TEMPLATES_FOLDER.length);
    const id = rest.slice(0, rest.indexOf('/'));
    const inFolder = rest.slice(id.length + 1);
    const content = contentOf(file, inFolder);
    if (typeof content === 'object' && 'refused' in content) {
      return refuse(content.refused);
    }
    const folder = folders.get(id) ?? {};
    folder[inFolder] = content;
    folders.set(id, folder);
  }

  const listed = new Set<string>();
  for (const { id } of read.templates) {
    if (listed.has(id)) return refuse(`names the template ${id} twice`);
    listed.add(id);
    if (!folders.has(id)) {
      return refuse(`names the template ${id}, which has no folder`);
    }
  }
  for (const id of folderIds) {
    if (!listed.has(id)) {
      return refuse(
        `holds ${TEMPLATES_FOLDER}${id}/, which ${CATALOGUE_INDEX} does not name`,
      );
    }
  }
  for (const [id, files] of folders) {
    const problem = configFilesProblem(files);
    if (problem) return refuse(`holds ${TEMPLATES_FOLDER}${id}/${problem}`);
  }

  return {
    ok: true,
    entries: read.templates.map(({ id, revision }) => ({
      id,
      revision,
      files: folders.get(id) ?? {},
    })),
  };
}

/** One template folder to publish: its id (the folder name) and its files. */
export interface CatalogueFolder {
  readonly id: string;
  readonly revision: string;
  /** By path inside the folder, `/`-separated. */
  readonly files: Readonly<Record<string, Uint8Array>>;
}

/**
 * The `catalogue.zip` holding `folders`: what `cg-templates` CI publishes
 * and what `cloudgate template check` makes of a folder before checking it.
 * The website's `index.md` and `screenshots/`, and the `test-values.yaml`
 * `template try` reads, are left out, so a folder that holds them is
 * published, and checked, as Cloudgate reads it. Every
 * other file is kept, so the check names a stray one rather than the build
 * dropping it unseen.
 */
export function encodeCatalogue(
  folders: readonly CatalogueFolder[],
): Uint8Array {
  const files: ZipFile[] = [
    {
      path: CATALOGUE_INDEX,
      bytes: Buffer.from(
        JSON.stringify({
          format: CATALOGUE_FORMAT,
          templates: folders.map(({ id, revision }) => ({ id, revision })),
        }),
      ),
    },
  ];
  for (const folder of folders) {
    for (const [path, bytes] of Object.entries(folder.files)) {
      if (isLeftOutOfCatalogue(path)) continue;
      files.push({ path: `${TEMPLATES_FOLDER}${folder.id}/${path}`, bytes });
    }
  }
  return writeZip(files);
}

function readIndex(
  bytes: Uint8Array,
):
  | { ok: true; templates: readonly { id: string; revision: string }[] }
  | { ok: false; reason: string } {
  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    return { ok: false, reason: `has a ${CATALOGUE_INDEX} that is not JSON` };
  }
  if (
    document !== null &&
    typeof document === 'object' &&
    'format' in document &&
    document.format !== CATALOGUE_FORMAT
  ) {
    return {
      ok: false,
      reason: `is format ${JSON.stringify(document.format)}; this Cloudgate reads format ${CATALOGUE_FORMAT}`,
    };
  }
  const result = index.safeParse(document);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue.path.map(String).join('.');
    return {
      ok: false,
      reason: `has a ${CATALOGUE_INDEX} that is not a valid index${at ? ` at ${at}` : ''}: ${issue.message}`,
    };
  }
  return { ok: true, templates: result.data.templates };
}

/**
 * A file's content: a PNG logo as its bytes, everything else as UTF-8 text
 * with no NUL, or why the zip is refused. Text is required here rather than
 * in the per-template check because a binary where text belongs is not a
 * mistake in a template but a file that is not what its name says.
 */
function contentOf(
  file: ZipFile,
  inFolder: string,
): CatalogueFileContent | { refused: string } {
  if (inFolder === 'logo.png') {
    return { base64: Buffer.from(file.bytes).toString('base64') };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    return { refused: `holds ${file.path}, which is not UTF-8 text` };
  }
  if (text.includes('\0')) {
    return { refused: `holds ${file.path}, which is not text: it has a NUL` };
  }
  return text;
}

/**
 * Why the folder's config files cannot ship, as the rest of a sentence
 * after the folder's path; null when they can. Every one must be listed in
 * its `template.yaml`, at a path the files rule accepts, and together they
 * are at most 1 MB.
 *
 * Only `files` is read from `template.yaml` here, leniently: one that cannot
 * be read is the per-template check's to explain, and here it lists nothing,
 * so a folder whose `template.yaml` is broken may ship no config file.
 */
function configFilesProblem(
  files: Readonly<Record<string, CatalogueFileContent>>,
): string | null {
  const listed = listedFiles(files['template.yaml']);
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(CONFIG_FILES)) continue;
    const below = path.slice(CONFIG_FILES.length);
    if (!listed.has(below)) {
      return `${path}, which its template.yaml does not list in files`;
    }
    const problem = configPathProblem(below);
    if (problem) return `${path}, whose path ${problem}`;
    total += Buffer.byteLength(content as string, 'utf8');
  }
  return total > TEMPLATE_CONFIG_FILES_MAX_BYTES
    ? `${CONFIG_FILES}, whose files come to ${megabytes(total)} MB; one template's config files are at most ${megabytes(TEMPLATE_CONFIG_FILES_MAX_BYTES)} MB`
    : null;
}

/** The paths `template.yaml`'s `files` lists; none when it cannot be read. */
function listedFiles(templateYaml: CatalogueFileContent | undefined) {
  const paths = new Set<string>();
  if (typeof templateYaml !== 'string') return paths;
  let document: unknown;
  try {
    document = parse(templateYaml, { logLevel: 'silent', maxAliasCount: 100 });
  } catch {
    return paths;
  }
  const files = (document as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return paths;
  for (const file of files as unknown[]) {
    const path = (file as { path?: unknown } | null)?.path;
    if (typeof path === 'string') paths.add(path);
  }
  return paths;
}

/** A file whose first non-blank character opens a JSON object. */
function looksLikeJson(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      continue;
    }
    return byte === 0x7b;
  }
  return false;
}

function megabytes(bytes: number): string {
  return String(Math.round((bytes / (1024 * 1024)) * 10) / 10);
}
