import type { PushHoldFor } from '../deployments/deployments.service';

/**
 * Preparing the Project config plans a push moved (US50), as a port
 * for the push handlers: `ProjectConfigModule` imports `GitProvidersModule`
 * (its config readers and connection lookup), so a push handler here cannot
 * import it, and resolves this token at call time instead, as the console
 * Saves seam resolves `HELD_BUILDS`. `ProjectConfigModule` binds it.
 */
export const CONFIG_PUSH_PLANNER = Symbol('CONFIG_PUSH_PLANNER');

/**
 * A push to a repository, as a provider's push handler hands it over:
 * through which connection it came (the base `git_provider` id), the
 * repository as `owner/repo`, what it pushed, and the paths it touched
 * (`null` when the delivery does not say).
 */
export interface ConfigPush {
  readonly gitProviderId: string;
  readonly repository: string;
  /**
   * The branch the push moved to a new commit, or `null` when it moved
   * none — it deleted the branch, or pushed a tag: there is no copy to
   * read, and nothing is planned.
   */
  readonly branch: string | null;
  readonly changedFiles: readonly string[] | null;
}

export interface ConfigPushPlanner {
  /**
   * Prepares a plan for every Environment reading the pushed branch, and
   * answers which of the same push's builds to hold. Never throws.
   */
  planPush(push: ConfigPush): Promise<PushHoldFor>;
}
