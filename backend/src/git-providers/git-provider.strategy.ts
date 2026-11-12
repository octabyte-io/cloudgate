import type { CheckedDial } from './git-clone-lines';
import type { SourceType } from './git-provider.schema';
import type { SourceProgram } from './source-program';
import { bitbucketStrategy } from './strategies/bitbucket/bitbucket.strategy';
import { dockerStrategy } from './strategies/docker.strategy';
import { dropStrategy } from './strategies/drop.strategy';
import { giteaStrategy } from './strategies/gitea/gitea.strategy';
import { gitStrategy } from './strategies/git.strategy';
import { githubStrategy } from './strategies/github/github.strategy';
import { gitlabStrategy } from './strategies/gitlab/gitlab.strategy';
import { rawStrategy } from './strategies/raw.strategy';

/**
 * Inputs a strategy may need to build its commands. Pure data — decrypted
 * key material and file content are resolved by the caller (service layer);
 * strategies never touch the database or the network.
 *
 * Mirrors the source-related columns of the application/compose rows, which
 * are the eventual callers' source of these values.
 */
export interface SourceCommandInput {
  /** Directory the source is materialized into. */
  outputPath: string;
  /** Repository URL — http(s) or ssh/scp-style (git strategy). */
  url?: string | null;
  branch?: string | null;
  /** Decrypted private key for ssh clones. */
  sshKey?: { privateKey: string } | null;
  enableSubmodules?: boolean;
  /**
   * The address the clone's host was checked at, which git must dial, set
   * only when the clone is held to it: on the platform host, for an
   * Organization other than the instance organization. `SourceCloneService`
   * sets it; a strategy only writes it into the command.
   */
  dial?: CheckedDial | null;
  /** File content to materialize (raw strategy). */
  content?: string | null;
  fileName?: string;
  /** Image reference and optional registry credentials (docker strategy). */
  dockerImage?: string | null;
  registryUrl?: string | null;
  username?: string | null;
  password?: string | null;
  /** The platform the image is pulled for (`linux/amd64`); unset, the host's own. */
  platform?: string | null;
  /** Repository coordinates and installation token (github strategy). */
  owner?: string | null;
  repository?: string | null;
  githubToken?: string | null;
  /** Decrypted OAuth access token (gitlab, gitea strategies). */
  accessToken?: string | null;
  /** Instance base URL and repository path namespace (gitlab strategy). */
  gitlabUrl?: string | null;
  gitlabPathNamespace?: string | null;
  /** Instance base URL (gitea strategy). */
  giteaUrl?: string | null;
  /** Basic-auth credentials (bitbucket strategy; username is shared). */
  apiToken?: string | null;
  appPassword?: string | null;
}

/**
 * A git-provider source strategy is a pure command builder: it returns shell
 * commands that fetch/materialize the source, to be executed locally or over
 * ssh via RemoteExecService.
 *
 * **Every word carrying a value goes through `quote()` from `shell-quote`** —
 * the same rule the build strategies follow, stated in full on `BuildStrategy`.
 * It bites hardest here: a clone command opens with `rm -rf
 * <outputPath>` on the build server, and `url`, `branch` and the credential
 * baked into `cloneUrl` are values a caller sets. Quoting rather than refusing
 * is deliberate, because a repository URL legitimately carries characters a
 * path never would.
 *
 * **`clone` became `cloneProgram`, and the rename is the point rather
 * than a tidy-up** — the same trick used when `BuildStrategy.getCommand`
 * became `getProgram`. A return type widened from `string` to an object is a
 * change every call site has to notice, and a rename is what makes "notice"
 * mean a compile error instead of a `[object Object]` interpolated into a
 * shell program.
 */
export interface GitProviderStrategy {
  readonly sourceType: SourceType;
  /**
   * Shell program that materializes the source into `outputPath`, plus the
   * environment it reads its secrets out of. See {@link SourceProgram}.
   */
  cloneProgram(input: SourceCommandInput): SourceProgram;
  /**
   * Shell command that prints the remote branches, or null when branches
   * do not apply to this source type (raw, docker).
   */
  listBranches(
    input: Pick<SourceCommandInput, 'url' | 'sshKey'>,
  ): string | null;
  /**
   * Shell command that prints `<hash>---DELIMITER---<message>` for the
   * checked-out source, or null when commits do not apply.
   */
  getCommitInfo(input: Pick<SourceCommandInput, 'outputPath'>): string | null;
}

/**
 * Every source type has a strategy now, `drop` included — so
 * {@link getGitProviderStrategy}'s raise is now unreachable from
 * `sourceTypeEnum` rather than being the drop lane's behaviour.
 *
 * `drop` was the exception the enum comment described as *"handled inline"*
 * while `DeploymentEngineService.deploy` had no inline branch, so the raise
 * below *was* how a `drop` Application deployed: it did not. The comment
 * is gone from `git-provider.schema.ts` and the strategy is here, which is the
 * form the interface change for {@link SourceProgram} made cheaper than a
 * branch — a `sourceType` that needs no fetch is still a `sourceType` with a
 * program (a guard and a log line), and putting it in the map keeps the one
 * dispatch honest instead of adding a second one in the engine.
 */
const strategies = new Map<SourceType, GitProviderStrategy>(
  [
    gitStrategy,
    rawStrategy,
    dockerStrategy,
    dropStrategy,
    githubStrategy,
    gitlabStrategy,
    bitbucketStrategy,
    giteaStrategy,
  ].map((s) => [s.sourceType, s]),
);

export function getGitProviderStrategy(
  sourceType: SourceType,
): GitProviderStrategy {
  const strategy = strategies.get(sourceType);
  if (!strategy) {
    throw new Error(
      `No git-provider strategy registered for source type "${sourceType}"`,
    );
  }
  return strategy;
}
