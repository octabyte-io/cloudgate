import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';

/**
 * A **Folder link** (CONTEXT.md, CLI spec): what ties a folder to one
 * Service, so `deploy`, `status`, `logs` and `vars` need no flags in it, or
 * to a whole Project, making it a **Project folder** (ADR-0080).
 *
 * Saved at `.cloudgate/link.json` in the linked folder, never in the user's
 * config and never in the Project config. It holds ids, and the Service's
 * **Config name** rather than its id, so `--env other` can find the same
 * Service in another Environment. The `names` are for printing only: the
 * lookup never matches by them, so a renamed Project still resolves.
 */
const linkBase = {
  /** The Instance address the link was made against. */
  instance: z.string().min(1),
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  /** The default Environment; `--env` picks another. */
  environmentId: z.string().min(1),
};

const linkNames = {
  organization: z.string(),
  project: z.string(),
  environment: z.string(),
};

/** A link naming one Service, by its Config name. */
const serviceLinkSchema = z.object({
  ...linkBase,
  serviceConfigName: z.string().min(1),
  workingCopy: z.never().optional(),
  names: z.object({ ...linkNames, service: z.string() }),
});

/**
 * A link naming no Service: a Project folder. `workingCopy` is the
 * `cloudgate.yaml` beside `.cloudgate/` as it was downloaded: the Project
 * config's version then, which a whole-YAML edit names so Cloudgate refuses
 * it once the config has moved on, and the SHA-256 of the text written, so
 * `config pull` can tell the copy was edited since.
 */
const projectFolderLinkSchema = z.object({
  ...linkBase,
  serviceConfigName: z.never().optional(),
  workingCopy: z.object({
    version: z.number().int(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  names: z.object(linkNames),
});

const folderLinkSchema = z.union([serviceLinkSchema, projectFolderLinkSchema]);

export type ServiceLink = z.infer<typeof serviceLinkSchema>;
export type ProjectFolderLink = z.infer<typeof projectFolderLinkSchema>;
export type FolderLink = ServiceLink | ProjectFolderLink;

/** Whether `link` makes its folder a Project folder: it names no Service. */
export function isProjectFolder(link: FolderLink): link is ProjectFolderLink {
  return link.workingCopy !== undefined;
}

export const LINK_FOLDER = '.cloudgate';
/** A Project folder's working copy of the Project config, beside `.cloudgate/`. */
export const WORKING_COPY_FILE = 'cloudgate.yaml';
const LINK_FILE = 'link.json';

/** A link, and where it was found. */
export interface FoundLink {
  /** The linked folder: the one holding `.cloudgate/`. */
  folder: string;
  /** The link file itself. */
  file: string;
  link: FolderLink;
}

/** Where `folder`'s link file is, whether or not it holds one. */
export function linkFileIn(folder: string): string {
  return join(folder, LINK_FOLDER, LINK_FILE);
}

/**
 * The nearest Folder link at or above `from`: in a monorepo each app's own
 * link wins over one at the root, and from a subfolder the link above applies.
 * A `.cloudgate/` holding no `link.json` is passed over.
 *
 * A link file that cannot be read is refused rather than passed over: going on
 * to a link further up would send the folder somewhere its owner never chose.
 */
export function findNearestLink(from: string): FoundLink | undefined {
  const folder = nearestLinkedFolder(from);
  if (folder === undefined) return undefined;
  const file = linkFileIn(folder);
  return { folder, file, link: readLink(file) };
}

/**
 * The nearest folder at or above `from` holding a link file, without reading
 * it: `unlink` removes a link it cannot read, too.
 */
export function nearestLinkedFolder(from: string): string | undefined {
  let folder = from;
  for (;;) {
    if (existsSync(linkFileIn(folder))) return folder;
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

/** Whether `folder` itself holds a link file. */
export function holdsLink(folder: string): boolean {
  return existsSync(linkFileIn(folder));
}

/** The link `folder` itself holds, or undefined when it holds none or one that cannot be read. */
export function readLinkIn(folder: string): FolderLink | undefined {
  try {
    return holdsLink(folder) ? readLink(linkFileIn(folder)) : undefined;
  } catch {
    return undefined;
  }
}

function readLink(file: string): FolderLink {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    parsed = undefined;
  }
  const link = folderLinkSchema.safeParse(parsed);
  if (!link.success) {
    throw new CliError(
      `the Folder link ${file} cannot be read`,
      EXIT.failed,
      'Run cloudgate link in that folder to make it again, or cloudgate unlink to remove it.',
    );
  }
  return link.data;
}

/**
 * Saves `link` in `folder`, replacing any link there, and makes sure the
 * folder's `.gitignore` ignores `.cloudgate/`, and in a Project folder its
 * `cloudgate.yaml` too: a link and a working copy are the person's own and
 * are never committed (ADR-0080). A line already there is left as it is.
 */
export function writeLink(folder: string, link: FolderLink): void {
  mkdirSync(join(folder, LINK_FOLDER), { recursive: true });
  writeFileSync(linkFileIn(folder), `${JSON.stringify(link, null, 2)}\n`);
  ignoreInGit(folder, IGNORES_LINK);
  if (isProjectFolder(link)) ignoreInGit(folder, IGNORES_WORKING_COPY);
}

/** A `.gitignore` line to add, and the spellings that already say it. */
interface Ignore {
  line: string;
  spellings: ReadonlySet<string>;
}

const IGNORES_LINK: Ignore = {
  line: `${LINK_FOLDER}/`,
  spellings: new Set([
    '.cloudgate',
    '.cloudgate/',
    '/.cloudgate',
    '/.cloudgate/',
  ]),
};

/** Only the copy at the Project folder's root: an app folder's file is not it. */
const IGNORES_WORKING_COPY: Ignore = {
  line: `/${WORKING_COPY_FILE}`,
  spellings: new Set([WORKING_COPY_FILE, `/${WORKING_COPY_FILE}`]),
};

function ignoreInGit(folder: string, ignore: Ignore): void {
  const gitignore = join(folder, '.gitignore');
  const held = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (held.split(/\r?\n/).some((line) => ignore.spellings.has(line.trim()))) {
    return;
  }
  const separator = held === '' || held.endsWith('\n') ? '' : '\n';
  writeFileSync(gitignore, `${held}${separator}${ignore.line}\n`);
}

/**
 * Deletes the link `folder` holds, and `.cloudgate/` with it when nothing else
 * is in it. Answers whether there was a link. Touches nothing else: not the
 * `.gitignore` line, and nothing on any Instance.
 */
export function removeLink(folder: string): boolean {
  const file = linkFileIn(folder);
  if (!existsSync(file)) return false;
  rmSync(file);
  const linkFolder = join(folder, LINK_FOLDER);
  if (readdirSync(linkFolder).length === 0) rmdirSync(linkFolder);
  return true;
}
