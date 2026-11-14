import { LOGO_MAX_BYTES } from './template-logo';

/**
 * What a **Template catalogue** zip may hold, and nothing else (ADR-0072):
 *
 * ```
 * catalogue.json
 * templates/<id>/template.yaml
 * templates/<id>/cloudgate.yaml
 * templates/<id>/docker-compose.yml
 * templates/<id>/files/…
 * templates/<id>/logo.svg | logo.png
 * ```
 *
 * A path outside this list refuses the whole zip rather than hiding the one
 * template it sits in: the zip is built by `cg-templates` CI from an allow
 * list, so a file it does not name is either a broken build or a zip someone
 * else made, and nothing in it is kept.
 */

/** The index: the format, and each template's id and revision. */
export const CATALOGUE_INDEX = 'catalogue.json';

/** The folder every template's own folder sits in. */
export const TEMPLATES_FOLDER = 'templates/';

/** The files a template folder holds at its root, beside `files/`. */
export const FOLDER_FILES: ReadonlySet<string> = new Set([
  'template.yaml',
  'cloudgate.yaml',
  'docker-compose.yml',
  'logo.svg',
  'logo.png',
]);

/** The folder a template's config files sit under. */
export const CONFIG_FILES = 'files/';

/**
 * The website's own files, which `cg-templates` keeps in the same folder as
 * a template's. Building a catalogue leaves them out, and
 * `cloudgate template check <folder>` skips them; inside a zip they are as
 * unknown as any other file.
 */
export function isWebsiteFile(pathInFolder: string): boolean {
  return pathInFolder === 'index.md' || pathInFolder.startsWith('screenshots/');
}

/**
 * The values `cloudgate template try` gives a template's `ask` inputs
 * (ADR-0078). A template folder in `cg-templates` may hold it; like the
 * website's files, building a catalogue leaves it out and
 * `cloudgate template check <folder>` skips it, and inside a zip it is
 * refused.
 */
export const TEST_VALUES_FILE = 'test-values.yaml';

/**
 * Whether a path inside a template folder is one the repository keeps and a
 * catalogue leaves out: the website's files and the test values.
 */
export function isLeftOutOfCatalogue(pathInFolder: string): boolean {
  return isWebsiteFile(pathInFolder) || pathInFolder === TEST_VALUES_FILE;
}

/**
 * The endings a config file under `files/` may have, and the few names
 * written without one. A config file is text the template's own containers
 * read; scripts, programs, archives and images are not config, and a new
 * kind is added here only by amending ADR-0072. `.js` is here by ADR-0083:
 * an application may read its config as a JavaScript module.
 */
export const CONFIG_FILE_ENDINGS: readonly string[] = [
  '.conf',
  '.cfg',
  '.ini',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.xml',
  '.properties',
  '.sql',
  '.txt',
  '.html',
  '.css',
  '.tmpl',
  '.js',
];
export const CONFIG_FILE_NAMES: readonly string[] = ['Caddyfile'];

/** The largest catalogue a download may be (ADR-0062, kept by ADR-0072). */
export const CATALOGUE_MAX_BYTES = 10 * 1024 * 1024;
/** The most a catalogue unpacks to, every file together. */
export const CATALOGUE_UNPACKED_MAX_BYTES = 50 * 1024 * 1024;
/** The most entries a catalogue zip holds, folders included. */
export const CATALOGUE_MAX_ENTRIES = 20_000;
/** The largest index. 500 templates are about 50 KB of it. */
export const INDEX_MAX_BYTES = 1024 * 1024;
/** The largest `template.yaml`, `cloudgate.yaml`, compose or config file. */
export const TEXT_FILE_MAX_BYTES = 256 * 1024;
/** The most one template's config files come to, all together. */
export const TEMPLATE_CONFIG_FILES_MAX_BYTES = 1024 * 1024;

/**
 * The cap on the file at `path` in a catalogue zip, or why the zip may not
 * hold it. A folder (its path ends in `/`) may be `templates/`, a template's
 * own folder or a folder under its `files/`.
 */
export function fileCap(path: string): number | { readonly refused: string } {
  const refused = (why: string) => ({ refused: `holds ${path}, ${why}` });
  if (path === CATALOGUE_INDEX) return INDEX_MAX_BYTES;
  if (path === TEMPLATES_FOLDER) return 0;
  if (!path.startsWith(TEMPLATES_FOLDER)) {
    return refused(
      `which is not a file a catalogue holds; it holds ${CATALOGUE_INDEX} and the folders under ${TEMPLATES_FOLDER}`,
    );
  }
  const rest = path.slice(TEMPLATES_FOLDER.length);
  const slash = rest.indexOf('/');
  if (slash < 0) {
    return refused(`which is not in a template's folder`);
  }
  const inFolder = rest.slice(slash + 1);
  const folder = inFolder === '' || inFolder.endsWith('/');

  if (folder) {
    if (inFolder === '' || inFolder === CONFIG_FILES) return 0;
    if (inFolder.startsWith(CONFIG_FILES)) {
      const hidden = hiddenSegment(inFolder.slice(CONFIG_FILES.length));
      return hidden ? refused(hidden) : 0;
    }
    return refused(
      isWebsiteFile(inFolder)
        ? 'a website folder; a catalogue leaves the website out'
        : `which is not a folder a template holds; config files go under ${CONFIG_FILES}`,
    );
  }
  if (FOLDER_FILES.has(inFolder)) {
    return inFolder.startsWith('logo.') ? LOGO_MAX_BYTES : TEXT_FILE_MAX_BYTES;
  }
  if (inFolder.startsWith(CONFIG_FILES)) {
    const problem = configFileNameProblem(inFolder.slice(CONFIG_FILES.length));
    return problem ? refused(problem) : TEXT_FILE_MAX_BYTES;
  }
  if (isWebsiteFile(inFolder)) {
    return refused('a website file; a catalogue leaves the website out');
  }
  if (inFolder === TEST_VALUES_FILE) {
    return refused(
      'the test values template try reads; a catalogue leaves them out',
    );
  }
  if (/compose\.ya?ml$/.test(inFolder)) {
    return refused(
      'a second compose file; a template has at most one, docker-compose.yml',
    );
  }
  return refused(
    `which is not a file a template holds; config files go under ${CONFIG_FILES}`,
  );
}

/**
 * Why a config file at `pathBelowFiles` (its path under `files/`) is not
 * one a template may ship by its name; null when it may.
 */
export function configFileNameProblem(pathBelowFiles: string): string | null {
  const hidden = hiddenSegment(pathBelowFiles);
  if (hidden) return hidden;
  const name = pathBelowFiles.slice(pathBelowFiles.lastIndexOf('/') + 1);
  if (CONFIG_FILE_NAMES.includes(name)) return null;
  const dot = name.lastIndexOf('.');
  if (dot > 0 && CONFIG_FILE_ENDINGS.includes(name.slice(dot))) return null;
  return `which is not a kind of config file a template ships; a config file ends in ${CONFIG_FILE_ENDINGS.join(', ')}, or is named ${CONFIG_FILE_NAMES.join(', ')}`;
}

function hiddenSegment(path: string): string | null {
  return path.split('/').some((segment) => segment.startsWith('.'))
    ? 'a hidden file; a template ships none'
    : null;
}
