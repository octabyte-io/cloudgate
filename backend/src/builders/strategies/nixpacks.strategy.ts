import path from 'node:path';
import { quote } from 'shell-quote';
import { prepareEnvironmentVariables } from '../../docker/docker.utils';
import { carryBuildEnv, envFlagWord } from '../build-env';
import type {
  BuildCommandInput,
  BuildProgram,
  BuildStrategy,
} from '../build-strategy';
import { staticStrategy } from './static.strategy';

/**
 * Reclaim the per-build containers an earlier build of this Application left
 * behind, before this build creates its own.
 *
 * **What broke.** The `publishDirectory` branch of {@link nixpacksStrategy}
 * `docker create`s a throwaway container so it can `docker cp` the compiled
 * artifacts out of the nixpacks image, and it `docker rm`s it on the
 * copy-failure branch and again at the end. So — exactly as
 * `railpack.strategy.ts`'s {@link
 * leftoverRailpackBuilderReclamation}'s docblock records for a buildx builder —
 * the one path where nothing removes it is the path where **no branch runs**: a
 * `SIGKILL`, a dropped SSH channel, a cancelled Deployment. What is left is a
 * container in `Created` state, holding the writable layer `docker create`
 * allocated, under a name no row records.
 *
 * **The railpack reclaim's two arguments are reused rather than re-derived, and both hold at
 * full strength.** First, the reclamation runs in the *next* build of the same
 * Application, because nothing inside the killed program survives it (a
 * `trap … EXIT INT TERM` catches precisely what the `|| { … }` branch already
 * catches, `SIGKILL` cannot be trapped, and a build carrying an operator
 * environment is read by `sh -s` off a channel a dropped connection tears
 * down) and because the queue answers *"is a build of this Application in
 * flight"* exactly where a clock cannot: `deployment-queue/job-types.ts`'
 * `getGroup` returns `application:<id>` for an Application and its previews and
 * `InMemoryQueue` admits one job per group. Second, the match is a **name
 * length and not a prefix**, because `appName` is operator-chosen and merely
 * unique, so an organization may own both `web` and `web-2` and `web-*` would
 * match `web-2-<nonce>` — a different Application, in a different FIFO group,
 * possibly building right now. `buildNonce` is a fixed-width `nanoid()`, so the
 * pattern ends in exactly as many single-character wildcards as this build's
 * own nonce has characters. The width is a **parameter** rather than a module
 * constant so that a build passes `buildNonce.length` and the pattern cannot
 * fall out of step with the name it has to match;
 * `leftoverRailpackBuilderReclamation` states why it is spelled as a length
 * rather than as the nonce.
 *
 * **What is different from railpack is the enumeration, and it is better here.**
 * `leftoverRailpackBuilderReclamation` deliberately pipes nothing and parses no
 * column, because `docker buildx ls` offered no way to name the field it wanted
 * and any assumption about which column a name sits in is an assumption a
 * layout change can silently break. `docker ps` does offer one:
 * `--format '{{.Names}}'` prints one container name per line and nothing else.
 * That is strictly stronger than considering every word — `.Names` is a
 * documented placeholder (`docker-ops/docker-ops.service.ts` says so of the
 * same family, and `settings/docker-resource.service.ts` already uses this
 * exact invocation), it cannot move the way a column can, and a field that
 * ever stopped existing would make `docker ps` *fail* rather than print
 * something the pattern quietly never matches. It also removes the whole class
 * of stray words a table has — `docker ps`'s `COMMAND` column is free text out
 * of the image — that would otherwise earn a pointless `docker rm`.
 *
 * **No `--filter name=`, which is the other invocation that suggests itself.**
 * That filter is an unanchored Go regexp, so it would be a *second* pattern
 * language beside the `case` glob that is the actual filter, able to disagree
 * with it, and needing `appName` escaped for a syntax nothing else in the tree
 * escapes for. One filter, stated once, is `leftoverRailpackBuilderReclamation`'s
 * rule and it is kept.
 *
 * **`docker rm` and deliberately not `docker rm --force`**, which is a
 * difference from `common/teardown-steps.ts`' `removeImagesOn` rather than an
 * oversight. The artifact this reclaims is in `Created` state by construction —
 * `docker create` starts nothing — so `--force` buys the intended target
 * nothing at all. What it would buy is the residual hazard: the pattern is a
 * length, so an operator's own container whose name happens to be `${appName}-`
 * plus exactly `buildNonce.length` characters matches, and without `--force` a
 * *running* one is refused by the daemon and left alone instead of being killed.
 *
 * **No `read` loop**, for `leftoverRailpackBuilderReclamation`'s reason: with an
 * environment the build program is on the shell's own stdin
 * (`RemoteExecService`'s `DEFAULT_REMOTE_ENV_SHELL`) and a stdin-reading command
 * eats the rest of the script under bash — which is why
 * `settings/docker-resource.service.ts`' `while read name` shape, correct where
 * it sits, must not be copied here. A `for` over a command substitution reads
 * nothing, and container names cannot contain whitespace.
 *
 * Every word `quote()`d and the `?`s outside the quotes, because a `case`
 * pattern is its own glob context (`build-strategy.ts` states the rule): the
 * prefix arrives quoted so nothing in an operator's `appName` becomes a
 * wildcard, while the wildcards stay wildcards.
 *
 * What this deliberately does not do, same as railpack: it reclaims on the *next*
 * build, so the leak is bounded at one leftover per Application rather than one
 * per killed build. The delete closes the residual —
 * `applications/build-leftovers.ts`' `reclaimBuildLeftovers`, in ADR-0016's
 * post-refusal slot — which is that function and not this one.
 */
export function leftoverNixpacksContainerReclamation(
  appName: string,
  nonceLength: number,
): string {
  const pattern = `${quote([`${appName}-`])}${'?'.repeat(nonceLength)}`;
  return [
    "for cg_leftover in $(docker ps -a --format '{{.Names}}' 2>/dev/null); do",
    `  case "$cg_leftover" in ${pattern})`,
    '    echo "♻️  Removing a container a killed Nixpacks build left behind: $cg_leftover" ;',
    '    docker rm "$cg_leftover" || true ;;',
    '  esac',
    'done',
  ].join('\n');
}

/**
 * Builds the app with `nixpacks build`. When a publish directory is set,
 * the nixpacks image is only a compile step: the artifacts are copied out
 * of a throwaway container and served via the static strategy's nginx
 * image instead.
 *
 * **The `--env` values travel in the environment, not in the flags**.
 * `nixpacks build … --env STRIPE_KEY\=sk_live_…` put three `encryptedText`
 * columns into `ExecError.command`; the flag now names the key and expands the
 * value out of a holder the exec layer sends on the SSH channel. See
 * `builders/build-env.ts`.
 */
export const nixpacksStrategy: BuildStrategy = {
  buildType: 'nixpacks',

  getProgram(input: BuildCommandInput): BuildProgram {
    const {
      appName,
      buildAppDirectory,
      buildNonce,
      env,
      projectEnv,
      environmentEnv,
      cleanCache,
      publishDirectory,
    } = input;

    const carried = carryBuildEnv(
      'CG_BUILD_ENV',
      prepareEnvironmentVariables(env ?? null, projectEnv, environmentEnv),
    );

    // Quoted per word; the env words pushed below quote the operator's key and
    // reference the value. See `BuildStrategy` for the rule.
    const args = [
      'build',
      quote([buildAppDirectory]),
      '--name',
      quote([appName]),
    ];

    if (cleanCache) {
      args.push('--no-cache');
    }

    for (const entry of carried.entries) {
      args.push('--env', envFlagWord(entry));
    }

    if (publishDirectory) {
      // No start command needed — nginx serves the artifacts later on.
      args.push('--no-error-without-start');
    }

    const lines = [
      // Unconditionally, and **before** anything this build creates. Two halves
      // of the placement are load-bearing. Before: this build's own container
      // does not exist yet, so there is no name to exclude and no way to remove
      // it by mistake — `railpack.strategy.ts` places its own sweep on the same
      // reasoning. And outside the `publishDirectory` branch below, even though
      // that branch is the only one that creates the artifact: `publishDirectory`
      // is a `PATCH /applications/:id` column, so conditioning the sweep on the
      // same column that conditions the `docker create` would make a leftover
      // unreclaimable exactly when an operator clears the column, which is the
      // one state where nothing else will ever look for it.
      // See {@link leftoverNixpacksContainerReclamation}.
      leftoverNixpacksContainerReclamation(appName, buildNonce.length),
      'echo "Starting nixpacks build..." ;',
      `nixpacks ${args.join(' ')} || {`,
      '  echo "❌ Nixpacks build failed" ;',
      '  exit 1;',
      '}',
      'echo "✅ Nixpacks build completed." ;',
    ];

    const programEnv: Record<string, string> = { ...carried.env };

    if (publishDirectory) {
      const buildContainerId = `${appName}-${buildNonce}`;
      const localPath = path.join(buildAppDirectory, publishDirectory);
      const isDirectory =
        publishDirectory.endsWith('/') || !path.extname(publishDirectory);

      // The nginx image the artifacts end up in is built by the static
      // strategy, which delegates to the dockerfile one — so its environment
      // (`buildArgs`, `buildSecrets`) merges into this program's. The holder
      // prefixes are per-column and cannot collide.
      const staticProgram = staticStrategy.getProgram(input);
      Object.assign(programEnv, staticProgram.env);

      lines.push(
        `docker create --name ${quote([buildContainerId])} ${quote([appName])}`,
        `mkdir -p ${quote([localPath])}`,
        `docker cp ${quote([`${buildContainerId}:/app/${publishDirectory}${isDirectory ? '/.' : ''}`])} ${quote([localPath])} || {`,
        `  docker rm ${quote([buildContainerId])}`,
        `  echo ${quote([`❌ Copying ${publishDirectory} to ${localPath} failed`])} ;`,
        '  exit 1;',
        '}',
        `docker rm ${quote([buildContainerId])}`,
        staticProgram.command,
      );
    }

    return { command: lines.join('\n'), env: programEnv };
  },
};
