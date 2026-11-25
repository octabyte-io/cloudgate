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
/**
 * The name of a Project folder's working copy of the Project config, beside
 * `.cloudgate/`, when it has none yet. One it holds may be spelt
 * {@link WORKING_COPY_YML} instead (ADR-0089); {@link workingCopyFileIn}
 * says which.
 */
export const WORKING_COPY_FILE = 'cloudgate.yaml';
/** The other spelling of a working copy, used only when it is the one there. */
export const WORKING_COPY_YML = 'cloudgate.yml';
const LINK_FILE = 'link.json';

/** The working copy's file in a Project folder, as {@link workingCopyFileIn} finds it. */
export interface WorkingCopyFile {
  /** Its name in the folder: the one there, or `cloudgate.yaml` for a new one. */
  name: string;
  /** Its path. */
  file: string;
  /** Whether the folder holds it. */
  held: boolean;
  /** `cloudgate.yml` when the folder holds both names: there, and not read. */
  unread?: string;
}

/**
 * Which file is `folder`'s working copy (ADR-0089, the same rule as a
 * repository's config): `cloudgate.yaml`, else `cloudgate.yml`. With both,
 * `cloudgate.yaml`, naming the other as unread. With neither, `cloudgate.yaml`,
 * the name a new copy is written under.
 */
export function workingCopyFileIn(folder: string): WorkingCopyFile {
  const yaml = existsSync(join(folder, WORKING_COPY_FILE));
  const yml = existsSync(join(folder, WORKING_COPY_YML));
  const name = !yaml && yml ? WORKING_COPY_YML : WORKING_COPY_FILE;
  return {
    name,
    file: join(folder, name),
    held: yaml || yml,
    ...(yaml && yml ? { unread: WORKING_COPY_YML } : {}),
  };
}

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
 * `cloudgate.yaml` and `cloudgate.yml` too: a link and a working copy are
 * the person's own and are never committed (ADR-0080). A line already there
 * is left as it is.
 */
export function writeLink(folder: string, link: FolderLink): void {
  mkdirSync(join(folder, LINK_FOLDER), { recursive: true });
  writeFileSync(linkFileIn(folder), `${JSON.stringify(link, null, 2)}\n`);
  ignoreInGit(folder, IGNORES_LINK);
  if (isProjectFolder(link)) {
    for (const ignore of IGNORES_WORKING_COPY) ignoreInGit(folder, ignore);
  }
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

/**
 * Only the copy at the Project folder's root: an app folder's file is not it.
 * Both spellings, so a copy kept as `cloudgate.yml` is never committed either.
 */
const IGNORES_WORKING_COPY: readonly Ignore[] = [
  WORKING_COPY_FILE,
  WORKING_COPY_YML,
].map((name) => ({ line: `/${name}`, spellings: new Set([name, `/${name}`]) }));

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
