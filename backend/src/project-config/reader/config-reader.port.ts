import type { GitProviderType } from '../../git-providers/git-provider.schema';

/**
 * The **config reader port**: the one seam through which a
 * repository-kept Project config is read. Given a git provider connection, a
 * repository, a path and a ref, it answers the file's text and the commit it
 * was read at, or a typed refusal. Nothing else reads a config from a
 * repository, and builds and Preview deployments never call it (US53):
 * `test/coding-standards/config-reader-callers.spec.ts` holds every caller
 * inside `src/project-config/`.
 *
 * The text is never stored (ADR-0029, "no fallback copy"): a caller plans
 * from it and keeps only the commit sha and a hash.
 *
 * One implementation per hosted provider sits behind {@link CONFIG_READER},
 * chosen by the connection's type (`config-readers.ts`); every e2e spec
 * replaces the whole token with an in-memory fake
 * (`test/utils/fake-config-reader.ts`, registered by `createTestApp`).
 */
export const CONFIG_READER = Symbol('CONFIG_READER');

/** What to read. */
export interface ConfigReadRequest {
  /** The `git_provider` row, whose type picks the implementation. */
  readonly connection: {
    readonly gitProviderId: string;
    readonly providerType: GitProviderType;
  };
  /** As the provider names it: `owner/repo` (a GitLab group path may nest). */
  readonly repository: string;
  /** Inside the repository, no leading slash: `cloudgate.yaml`. */
  readonly path: string;
  /** A branch name; `null` is the repository's default branch. */
  readonly ref: string | null;
}

/**
 * Why a copy could not be read. `repository-unreachable` covers a repository
 * that does not exist, one the connection cannot reach, a connection that is
 * gone or misconfigured, and a provider that does not answer: in each the
 * operator's next step is the connection or the repository, not the branch.
 */
export type ConfigReadRefusalReason =
  'repository-unreachable' | 'branch-missing' | 'file-missing';

export type ConfigReadResult =
  | {
      readonly ok: true;
      readonly text: string;
      /** The commit the text was read at. */
      readonly commitSha: string;
      /** The branch read: `ref`, or the default branch when `ref` was null. */
      readonly branch: string;
      /** A link an operator opens to see the file at that commit. */
      readonly fileUrl: string;
    }
  | {
      readonly ok: false;
      readonly reason: ConfigReadRefusalReason;
      /** The branch asked for, or the default branch once it was known. */
      readonly branch: string | null;
      /** Why, in a sentence, naming the repository (and branch or path). */
      readonly message: string;
    };

export interface ConfigReader {
  read(request: ConfigReadRequest): Promise<ConfigReadResult>;
}
