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
 * Service, so `deploy`, `status`, `logs` and `vars` need no flags in it.
 *
 * Saved at `.cloudgate/link.json` in the linked folder, never in the user's
 * config and never in the Project config. It holds ids, and the Service's
 * **Config name** rather than its id, so `--env other` can find the same
 * Service in another Environment. The `names` are for printing only: the
 * lookup never matches by them, so a renamed Project still resolves.
 */
const folderLinkSchema = z.object({
  /** The Instance address the link was made against. */
  instance: z.string().min(1),
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  /** The default Environment; `--env` picks another. */
  environmentId: z.string().min(1),
  serviceConfigName: z.string().min(1),
  names: z.object({
    organization: z.string(),
    project: z.string(),
    environment: z.string(),
    service: z.string(),
  }),
});

export type FolderLink = z.infer<typeof folderLinkSchema>;

export const LINK_FOLDER = '.cloudgate';
const LINK_FILE = 'link.json';

/** A link, and where it was found. */
export interface FoundLink {
  /** The linked folder: the one holding `.cloudgate/`. */
  folder: string;
  /** The link file itself. */
  file: string;
  link: FolderLink;
}

function linkFileIn(folder: string): string {
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
 * folder's `.gitignore` ignores `.cloudgate/`: a link is the person's own and
 * is never committed. A `.gitignore` already naming it is left as it is.
 */
export function writeLink(folder: string, link: FolderLink): void {
  mkdirSync(join(folder, LINK_FOLDER), { recursive: true });
  writeFileSync(linkFileIn(folder), `${JSON.stringify(link, null, 2)}\n`);
  ignoreLinkFolder(folder);
}

const IGNORES_LINK = new Set([
  '.cloudgate',
  '.cloudgate/',
  '/.cloudgate',
  '/.cloudgate/',
]);

function ignoreLinkFolder(folder: string): void {
  const gitignore = join(folder, '.gitignore');
  const held = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (held.split(/\r?\n/).some((line) => IGNORES_LINK.has(line.trim()))) {
    return;
  }
  const separator = held === '' || held.endsWith('\n') ? '' : '\n';
  writeFileSync(gitignore, `${held}${separator}${LINK_FOLDER}/\n`);
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
