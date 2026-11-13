import { quote } from 'shell-quote';
import type {
  GitProviderStrategy,
  SourceCommandInput,
} from '../git-provider.strategy';
import type { SourceProgram } from '../source-program';

/**
 * The `drop` source: an operator's zip, already on the build host.
 *
 * **What broke first (item 4): nothing could deploy a drop at all.**
 * `getGitProviderStrategy('drop')` threw, and `sourceTypeEnum`'s comment
 * explained that away as *"'drop' (file upload) has no strategy — it is handled
 * inline"* while `DeploymentEngineService.deploy` had no inline branch of any
 * kind. So `cloneCommand` raised before the first shell step and every
 * `POST /applications/:id/deploy` on a `drop` Application failed with *"No
 * git-provider strategy registered for source type \"drop\""* — an
 * implementation detail standing in for a missing feature. An earlier fix had
 * just fixed the *write* path (the archive lands on the build host, where a
 * build would read it), which is what left this as the separate question of
 * whether anything could then deploy it. The answer was no: the lane was
 * upload-only.
 *
 * **This strategy fetches nothing, and that is the whole design rather than a
 * degenerate case.** `ApplicationsService.uploadDrop` reads the archive in the
 * API process and writes its entries out as one `base64 -d` per file into
 * `{applicationsDirectoryOn(buildHostServerId)}/{appName}/code` — the
 * byte-identical path and machine `deploy` clones into and the build then reads
 * (`CONTEXT.md`'s *Build host*, ADR-0018). There is no retained archive
 * to unpack, so there is nothing for a clone step to do except *not break what
 * is there*.
 *
 * **Which is the trap, and the reason this is a strategy and not four lines in
 * the engine.** Every one of the six sibling strategies opens with
 * `rm -rf <outputPath>` — `git.strategy.ts`, the three provider strategies,
 * `raw.strategy.ts` and, in effect, `docker.strategy.ts`'s pull — because for
 * them the output path is a destination. Here it is the *source*. A branch
 * written by analogy with its neighbours would delete the operator's upload and
 * then build an empty tree, and it would do it on the machine that holds the
 * only copy. Making `drop` a member of the same map means the next person
 * reading the dispatch sees seven arms with one of them explaining itself,
 * rather than six arms and a comment pointing at a branch that does not exist.
 *
 * **The guard, because `sourceType` is a `PATCH` column.**
 * `updateApplicationSchema` admits `sourceType: 'drop'`, so a row can name this
 * source with no archive ever posted — and the two uploads, `uploadDrop` and
 * `applyDrop`, are the only writers of `dropBuildPath` (through
 * `switchToDrop`), so such a row also has no build path of its own. Without the
 * `-d` test the deploy would run a builder over an absent directory and fail
 * inside nixpacks or `docker build`, whose message names neither the drop lane
 * nor the upload route. The refusal is `exit 1` inside the composed program
 * rather than a `throw` in the engine, deliberately: it lands in the Deployment
 * *log*, next to the phase banners, which is where an operator reads a failed
 * deploy — and it costs no round trip, because it is composed into the same
 * redirected program the build already runs.
 *
 * `env` is empty and there is nothing here that could fill it: a drop carries
 * no credential of any kind, which is why this is the one strategy for which
 * {@link SourceProgram}'s second field is structurally rather than incidentally
 * `{}`.
 *
 * `listBranches` and `getCommitInfo` are `null` on `raw.strategy.ts`'s
 * precedent — an uploaded zip has no remote to list and no commit to describe.
 * The console's *Source* card reads both as "not applicable" rather than
 * failing, which is what it already does for `raw` and `docker`.
 */
export const dropStrategy: GitProviderStrategy = {
  sourceType: 'drop',

  cloneProgram(input: SourceCommandInput): SourceProgram {
    const { outputPath } = input;
    // `quote()`d like every other value word in this module. The path is
    // machine-made — `applicationsDirectoryOn(buildHostServerId)` plus an
    // `APP_NAME_REGEX` `appName` — which is the charset-at-a-distance case
    // `BuildStrategy`'s rule says is quoted anyway.
    const path = quote([outputPath]);
    return {
      command: [
        'set -e;',
        `if [ ! -d ${path} ]; then`,
        `  echo ${quote([
          `❌ [Drop] No uploaded files found at '${outputPath}'. ` +
            `This Application's source is a file upload, so there is nothing ` +
            `to build until an archive is posted to ` +
            `/applications/:id/drop.`,
        ])};`,
        '  exit 1;',
        'fi',
        `echo ${quote([
          `📦 [Drop] Building the uploaded files already extracted at '${outputPath}' ✅`,
        ])};`,
      ].join('\n'),
      env: {},
    };
  },

  listBranches(): null {
    return null;
  },

  getCommitInfo(): null {
    return null;
  },
};
