import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

import type { ProjectConfigLocation } from 'api-schemas';

/**
 * Where a folder sits in git: the `origin` remote's `owner/repo`, and the
 * folder's path inside the checkout. `cloudgate link` lists first the Project
 * whose config is kept in that repository at or above the folder (CLI spec),
 * so the likely answer is at the top. Only ordering hangs on this: a folder
 * outside git, or a machine without git, simply gets no Project listed first.
 */
export interface FolderInGit {
  /** `owner/repo`, lower-cased. */
  repository: string;
  /** The folder's path inside the checkout, `''` or ending in `/`. */
  prefix: string;
}

export function folderInGit(cwd: string): FolderInGit | undefined {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    const repository = repositoryOf(git(['remote', 'get-url', 'origin']));
    if (!repository) return undefined;
    return { repository, prefix: git(['rev-parse', '--show-prefix']) };
  } catch {
    return undefined;
  }
}

/**
 * `owner/repo` (or `group/sub/repo`) from a remote URL, lower-cased: the
 * scp-like `git@host:owner/repo.git` and any `scheme://host/owner/repo`.
 */
export function repositoryOf(remote: string): string | undefined {
  const trimmed = remote.trim();
  let path: string | undefined;
  const scpLike = /^[^/@]+@[^/:]+:(.+)$/.exec(trimmed);
  if (scpLike) {
    path = scpLike[1];
  } else {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  }
  const cleaned = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  return cleaned.includes('/') ? cleaned.toLowerCase() : undefined;
}

/**
 * Whether a Project's config location is this folder's: kept in the same
 * repository, in a directory at or above the folder (a root `cloudgate.yaml`
 * covers every app in a monorepo; `apps/web/cloudgate.yaml` does not cover
 * `apps/api`).
 */
export function configMatchesFolder(
  location: ProjectConfigLocation['location'],
  folder: FolderInGit,
): boolean {
  if (location?.kind !== 'repository' || !location.repository) return false;
  if (location.repository.toLowerCase() !== folder.repository) return false;
  const directory = posix.dirname(location.path ?? 'cloudgate.yaml');
  if (directory === '.') return true;
  return `${folder.prefix}`.startsWith(`${directory.replace(/\/+$/, '')}/`);
}
