import { ConflictException } from '@nestjs/common';

/**
 * A write only the file can make, refused on a repository-kept config
 * (ADR-0029): a config-owned setting, a new variable name, a new
 * Service of a kind the config describes, the Delete of a Service it lists,
 * or the whole-YAML edit. The answer carries {@link ConfigPointer} as
 * `pointer`, so the console, the API and an Agent all learn where the change
 * is made instead.
 */
export const PROJECT_CONFIG_REPOSITORY_KEPT_CODE =
  'PROJECT_CONFIG_REPOSITORY_KEPT';

/**
 * A repository-kept config could not be read (US54): the repository is
 * unreachable, the Config branch is missing, or the file is. The message names
 * the repository and branch; there is no fallback copy to plan from instead.
 */
export const CONFIG_UNREADABLE_CODE = 'CONFIG_UNREADABLE';

/**
 * Where a refused change is made: the file, and the branch the Environment
 * reads it from (its Config branch, else the repository's default branch).
 * `branch` is `null` only when the default branch could not be learned,
 * because the repository could not be reached.
 */
export interface ConfigPointer {
  readonly repository: string;
  readonly path: string;
  readonly branch: string | null;
  /** A link to the file at the commit read; `null` when it was not read. */
  readonly fileUrl: string | null;
}

/** `acme/shop at cloudgate.yaml on branch main`. */
export function pointedAt(pointer: ConfigPointer): string {
  const branch = pointer.branch === null ? '' : ` on branch ${pointer.branch}`;
  return `${pointer.repository} at ${pointer.path}${branch}`;
}

/** The 409 of a write the file makes instead, with its pointer. */
export function repositoryKept(
  message: string,
  pointer: ConfigPointer,
): ConflictException {
  return new ConflictException({
    message,
    code: PROJECT_CONFIG_REPOSITORY_KEPT_CODE,
    pointer: {
      repository: pointer.repository,
      path: pointer.path,
      branch: pointer.branch,
      fileUrl: pointer.fileUrl,
    },
  });
}
