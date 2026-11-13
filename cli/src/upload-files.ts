import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ignoredBy, parseIgnoreFile } from './ignore-rules.js';
import type { IgnoreRule } from './ignore-rules.js';

/**
 * One file `deploy` uploads: its path under the folder (`/`-separated), its
 * size, and the SHA-256 of its contents as 64 lowercase hex digits, the
 * fingerprint the Instance compares with the file on its build host (spec
 * #10: contents, never timestamps).
 */
export interface UploadFile {
  path: string;
  size: number;
  sha256: string;
}

/** What {@link selectUploadFiles} found. */
export interface UploadSelection {
  /** Every file to upload, in path order. */
  files: UploadFile[];
  /**
   * The `.env` files left out, by the rule below or by an ignore file, for
   * the one line that names them and points at `cloudgate vars set`.
   */
  leftOutEnvFiles: string[];
  /**
   * Symlinks nothing ignored, left out and never followed: the server keeps
   * no symlinks (CLI spec, Out of Scope), and following one could upload
   * something outside the folder.
   */
  symlinks: string[];
}

/** Folders never uploaded, wherever they are: git's own, and a Folder link's. */
const ALWAYS_LEFT_OUT = new Set(['.git', '.cloudgate']);

/**
 * `.env` and `.env.*`, except `.env.example`, are left out even when nothing
 * ignores them (deploy step 8): a secret belongs in the Service's variables,
 * not in an uploaded tree an image may copy whole. As rules beneath every
 * ignore file's, so `!.env` in a `.cloudgateignore` brings one back.
 */
const ENV_FILE_RULES = parseIgnoreFile('.env\n.env.*\n!.env.example\n', '');

function isEnvFile(name: string): boolean {
  return (
    (name === '.env' || name.startsWith('.env.')) && name !== '.env.example'
  );
}

/**
 * Which files of `root` `cloudgate deploy` uploads (CLI spec, deploy step 8):
 * the folder as it is on disk, uncommitted and untracked files included.
 */
export function selectUploadFiles(root: string): UploadSelection {
  const files: UploadFile[] = [];
  const leftOutEnvFiles: string[] = [];
  const symlinks: string[] = [];
  // Every .gitignore's rules first, shallow to deep, then every
  // .cloudgateignore's: "applied on top", so its `!` wins over any .gitignore.
  const walk = (
    relative: string,
    inherited: { git: IgnoreRule[]; cloudgate: IgnoreRule[] },
  ) => {
    const here = join(root, relative);
    const own = {
      git: [...inherited.git, ...rulesIn(here, '.gitignore', relative)],
      cloudgate: [
        ...inherited.cloudgate,
        ...rulesIn(here, '.cloudgateignore', relative),
      ],
    };
    const rules = [...own.git, ...own.cloudgate];
    const names = readdirSync(here).sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(root, path));
      const isDirectory = stat.isDirectory();
      if (isDirectory && ALWAYS_LEFT_OUT.has(name)) continue;
      const rule = ignoredBy(rules, path, isDirectory);
      if (rule && !rule.negated) {
        if (!isDirectory && isEnvFile(name)) leftOutEnvFiles.push(path);
        continue;
      }
      if (stat.isSymbolicLink()) {
        symlinks.push(path);
      } else if (isDirectory) {
        walk(path, own);
      } else if (stat.isFile()) {
        files.push({
          path,
          size: stat.size,
          sha256: sha256Of(join(root, path)),
        });
      }
    }
  };
  walk('', { git: [...ENV_FILE_RULES], cloudgate: [] });
  files.sort((a, b) => byPath(a.path, b.path));
  leftOutEnvFiles.sort(byPath);
  symlinks.sort(byPath);
  return { files, leftOutEnvFiles, symlinks };
}

/** Above this, `deploy` warns and names the biggest folders, then goes on (deploy step 9). */
export const LARGE_UPLOAD_BYTES = 100_000_000;

/** What `deploy` always says about an upload before sending it. */
export interface UploadSummary {
  count: number;
  totalSize: number;
  /** Over {@link LARGE_UPLOAD_BYTES}. */
  large: boolean;
  /**
   * When large, the five biggest top-level folders, biggest first: where to
   * look for what a `.cloudgateignore` should leave out. Empty otherwise.
   * Top-level only, because a folder is never smaller than one inside it, so
   * the five biggest of every folder would be one folder and its insides.
   */
  biggestFolders: Pick<UploadFile, 'path' | 'size'>[];
}

export function summarizeUpload(
  files: readonly Pick<UploadFile, 'path' | 'size'>[],
): UploadSummary {
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const large = totalSize > LARGE_UPLOAD_BYTES;
  const byFolder = new Map<string, number>();
  if (large) {
    for (const file of files) {
      const slash = file.path.indexOf('/');
      if (slash === -1) continue;
      const folder = file.path.slice(0, slash);
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + file.size);
    }
  }
  const biggestFolders = [...byFolder]
    .map(([path, size]) => ({ path, size }))
    .sort((a, b) => b.size - a.size || byPath(a.path, b.path))
    .slice(0, 5);
  return { count: files.length, totalSize, large, biggestFolders };
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The rules of the ignore file `name` in `folder`, if it has one. */
function rulesIn(folder: string, name: string, base: string): IgnoreRule[] {
  const file = join(folder, name);
  if (!existsSync(file)) return [];
  return parseIgnoreFile(readFileSync(file, 'utf8'), base);
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
