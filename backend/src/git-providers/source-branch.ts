import type { SourceType } from './git-provider.schema';
import type { CloneSource } from './source-clone.service';

/**
 * The column each branch-bearing source type clones its branch from — the
 * same five `SourceCloneService.cloneProgram` reads, one per provider arm.
 *
 * **Why a table and not `branch`.** A preview build is the parent's row
 * with the branch overridden, and it overrode `branch` alone: the GitHub
 * column. That was correct while previews were GitHub's only (the webhook is),
 * and it stopped being correct the moment a Requested preview could be asked
 * of any git-sourced Application: a GitLab Application's clone reads
 * `gitlabBranch`, so its preview would have built the configured branch while
 * its Deployment said it built the one asked for. `docker`, `drop` and `raw`
 * have no branch and are not in the table.
 */
export const BRANCH_COLUMN = {
  git: 'customGitBranch',
  github: 'branch',
  gitlab: 'gitlabBranch',
  gitea: 'giteaBranch',
  bitbucket: 'bitbucketBranch',
} as const satisfies Partial<Record<SourceType, keyof CloneSource>>;

/** A source type a branch can be built from. */
export type BranchedSourceType = keyof typeof BRANCH_COLUMN;

/** Whether `sourceType` builds from a branch at all. */
export function isBranchedSource(
  sourceType: SourceType,
): sourceType is BranchedSourceType {
  return Object.hasOwn(BRANCH_COLUMN, sourceType);
}

/**
 * `source` building `branch` instead of its configured one: a copy with the
 * one column its clone reads set, whatever its provider. A source with no
 * branch is returned as it is — the caller refused it before asking.
 */
export function onBranch<T extends Pick<CloneSource, 'sourceType'>>(
  source: T,
  branch: string,
): T {
  if (!isBranchedSource(source.sourceType)) return source;
  return { ...source, [BRANCH_COLUMN[source.sourceType]]: branch };
}
