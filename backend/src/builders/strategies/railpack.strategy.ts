import { createHash } from 'node:crypto';
import { quote } from 'shell-quote';
import { prepareEnvironmentVariables } from '../../docker/docker.utils';
import { carryBuildEnv, envFlagWord, secretFlagValue } from '../build-env';
import type {
  BuildCommandInput,
  BuildProgram,
  BuildStrategy,
} from '../build-strategy';

// The `application.railpack_version` column default.
const DEFAULT_RAILPACK_VERSION = '0.15.4';

/**
 * Order-independent env fingerprint used to invalidate buildx layers.
 *
 * Over the resolved `KEY=VALUE` pairs, which is what it always hashed —
 * previously by way of the shell-quoted copies of them, because that was the
 * only list the function had. The pairs are the honest input, `--build-arg
 * secrets-hash=` gets a different digest for the same environment than it did
 * before the change, and that costs one cache miss per application on the deploy
 * after the upgrade. A sha256 is not a recoverable value, so this is the one
 * place a build's environment still influences the command string.
 */
const calculateSecretsHash = (pairs: readonly string[]): string => {
  const hash = createHash('sha256');
  for (const pair of [...pairs].sort()) {
    hash.update(pair);
  }
  return hash.digest('hex');
};

/**
 * Reclaim the per-build buildx builders an earlier build of this Application
 * left behind, before creating this build's own.
 *
 * **What broke.** `railpackStrategy` removes its builder on both failure
 * branches and again at the end, so the only path where nothing removes it is
 * the path where **no branch runs**: a `SIGKILL`, a dropped SSH channel, a
 * cancelled Deployment. `docker buildx rm` with no `--keep-state` takes the
 * builder's container *and* its state volume with it — which is exactly why
 * it could be established that railpack otherwise leaks no cache at all — so this
 * is the one path where railpack's own hygiene does not run, and what it leaves
 * is a container and a volume under a name no row records.
 *
 * **Why it cannot be fixed inside the killed build.** A shell `trap … EXIT INT
 * TERM` is the obvious reach and buys nothing the two `|| { … }` branches do
 * not already buy: `SIGKILL` cannot be trapped, and a build carrying an
 * operator environment is read by `sh -s` off a channel that a dropped
 * connection tears down under the shell (`RemoteExecService`'s
 * `DEFAULT_REMOTE_ENV_SHELL`). Whatever runs has to run in a *later* process.
 *
 * **Why the next build and not a nightly sweep — the safety argument, which is
 * the whole of the problem.** ADR-0020's sweep is safe because `-mtime` makes
 * an in-flight log structurally unselectable: the file's mtime *is* now. A
 * buildx builder has no equivalent fact. Its container's uptime is as long for
 * a live two-hour build as for a leftover, and `docker buildx ls` reports a
 * node as `running` whether it is building or merely up — so **any** age
 * predicate is a guess about the longest build anyone will run, and a wrong
 * guess kills a build in flight. The deployment queue answers the same question
 * exactly instead: `deployment-queue/job-types.ts`' `getGroup` returns
 * `application:<id>` for an Application *and* for its preview deployments, and
 * `InMemoryQueue` admits one job per group at a time — *"two builds of the same
 * service never run in parallel"*. So at the moment this program runs, no other
 * build of this Application can be in flight, and every builder matching this
 * Application's name is from a build that has ended. That is a statement about
 * the queue rather than about a clock, and it needs no lock.
 *
 * **The pattern is a length, not a prefix, and that is load-bearing.**
 * `appName` is operator-chosen and merely unique, so an organization can own
 * both `web` and `web-2`, and `railpack-web-*` would match
 * `railpack-web-2-<nonce>` — a different Application, in a different FIFO
 * group, whose build may be running right now. `buildNonce` is fixed-width, so
 * the pattern ends in exactly as many single-character wildcards as this
 * build's own nonce has characters, and any appName extending `web-` adds a
 * segment plus a separator and can never be that length.
 *
 * **The width is a parameter rather than a constant, and the delete-time
 * reclaim is why it is spelled `nonceLength` instead of taking the nonce.** Inside a
 * build the caller passes `buildNonce.length`, so the pattern and the name it has to
 * match
 * cannot fall out of step — that property is unchanged and is still the reason
 * this is not a module constant. What was added is a *second* caller with no
 * nonce at all: `applications/build-leftovers.ts` sends this same program at
 * delete time, where there is no build, and it passes
 * `build-leftovers.ts`' `BUILD_NONCE_LENGTH` (pinned against `nanoid()` by
 * `test/builders/build-leftovers.spec.ts`). Taking a `buildNonce: string` and
 * reading only its `.length` would have made that caller invent a
 * meaningless 21-character string, so the parameter says what is actually used.
 *
 * **Every word `quote()`d, and a `case` pattern is its own glob context**
 * (`build-strategy.ts` states the rule): the prefix arrives quoted so nothing
 * in an operator's `appName` becomes a wildcard, while the `?`s stay outside the
 * quotes so they stay wildcards.
 *
 * Two shapes rejected in the shell itself. **No `awk`**, and no assumption
 * about which column of `docker buildx ls` a name sits in: the loop considers
 * every word and the pattern is the filter, so a change to that command's
 * layout cannot silently stop the reclamation, and the worst a stray word can
 * do is earn a `docker buildx rm` that fails into `|| true`. **No `read`
 * loop**, which would be the natural spelling and is the one thing a build
 * program must not do — with an environment the program is on the shell's own
 * stdin, and a stdin-reading command eats the rest of the script under bash
 * (`RemoteExecService`'s `DEFAULT_REMOTE_ENV_SHELL` measures it). A `for` over
 * a command substitution reads nothing. Builder names cannot contain
 * whitespace, so the word splitting is safe.
 *
 * What this deliberately does not do: it reclaims on the **next** build, so the
 * leak is bounded at one leftover per Application rather than one per killed
 * build, and an Application that never builds again keeps its leftover until it
 * is deleted. The delete is where that belongs — ADR-0016's post-refusal slot,
 * beside the `${appName}:latest` reclamation already there — and **it is
 * there**: `applications/build-leftovers.ts`' `reclaimBuildLeftovers`
 * sends this program on the build host after the presence refusal and before
 * the rows, so the residual this paragraph names is closed. What is still true
 * is the bound itself — between two builds there is at most one leftover.
 */
export function leftoverRailpackBuilderReclamation(
  appName: string,
  nonceLength: number,
): string {
  const pattern = `${quote([`railpack-${appName}-`])}${'?'.repeat(
    nonceLength,
  )}`;
  return [
    'for cg_leftover in $(docker buildx ls 2>/dev/null); do',
    `  case "$cg_leftover" in ${pattern})`,
    '    echo "♻️  Removing a Railpack builder a killed build left behind: $cg_leftover" ;',
    '    docker buildx rm "$cg_leftover" || true ;;',
    '  esac',
    'done',
  ].join('\n');
}

/**
 * `railpack prepare` emits a build plan that a buildx builder consumes via
 * the railpack frontend. The builder name embeds `buildNonce` so concurrent
 * deployments don't race on a shared builder instance (create/use/rm
 * collisions).
 *
 * **The `export KEY='value'` lines this program used to open with are gone**.
 * They were the most direct instance of the whole defect class: three
 * `encryptedText` columns, written into the command string as shell
 * assignments, purely so that the `--secret id=…,env=…` flags below could read
 * them back out of the environment. The environment was always the destination;
 * the command string was a detour through the one field `ExecError` captures.
 * The values now arrive on the SSH channel and the flags name the holder they
 * arrive in — see `builders/build-env.ts`.
 */
export const railpackStrategy: BuildStrategy = {
  buildType: 'railpack',

  getProgram(input: BuildCommandInput): BuildProgram {
    const {
      appName,
      buildAppDirectory,
      buildNonce,
      env,
      projectEnv,
      environmentEnv,
      cleanCache,
      railpackVersion,
    } = input;

    const version = railpackVersion || DEFAULT_RAILPACK_VERSION;
    const builderName = `railpack-${appName}-${buildNonce}`;

    const pairs = prepareEnvironmentVariables(
      env ?? null,
      projectEnv,
      environmentEnv,
    );
    const carried = carryBuildEnv('CG_BUILD_ENV', pairs);

    // Quoted per word; the env words pushed below quote the operator's key and
    // reference the value. See `BuildStrategy` for the rule —
    // `railpackVersion` is as much a `PATCH`-able column as the directory is.
    const prepareArgs = [
      'prepare',
      quote([buildAppDirectory]),
      '--plan-out',
      quote([`${buildAppDirectory}/railpack-plan.json`]),
      '--info-out',
      quote([`${buildAppDirectory}/railpack-info.json`]),
    ];

    for (const entry of carried.entries) {
      prepareArgs.push('--env', envFlagWord(entry));
    }

    const buildArgs = [
      'buildx',
      'build',
      '--builder',
      quote([builderName]),
      ...(cleanCache
        ? [
            '--build-arg',
            `secrets-hash=${quote([calculateSecretsHash(pairs)])}`,
            '--build-arg',
            `cache-key=${quote([buildNonce])}`,
          ]
        : []),
      '--build-arg',
      `BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v${quote([version])}`,
      '-f',
      quote([`${buildAppDirectory}/railpack-plan.json`]),
      '--output',
      `type=docker,name=${quote([appName])}`,
    ];

    // Secrets ride in as environment variables, and now really only as that:
    // the holder is what the exec layer sends, the id stays the operator's key
    // so the plan's `/run/secrets/<key>` is unchanged, and the id is `quote()`d
    // where it used to be bare. The same holders carry both flag sets, so the
    // channel sends each value once.
    //
    // An empty value is skipped as it always was — the pair reaches `--env`,
    // where railpack treats it as an explicit empty string, but not `--secret`,
    // where buildx would mount an empty file rather than refuse. The decision
    // reads the value out of `carried.env`, which is the map that never enters a
    // command string.
    for (const entry of carried.entries) {
      if (!carried.env[entry.holder]) continue;
      buildArgs.push('--secret', secretFlagValue(entry));
    }

    buildArgs.push(quote([buildAppDirectory]));

    const quotedBuilder = quote([builderName]);
    return {
      command: [
        `export RAILPACK_VERSION=${quote([version])}`,
        'bash -c "$(curl -fsSL https://railpack.com/install.sh)"',
        // Before the create, not after: this build's own builder does not exist
        // yet, so there is no name to exclude and no way to remove it by
        // mistake. See {@link leftoverRailpackBuilderReclamation} for why the
        // next build is where a killed build's builder gets reclaimed.
        leftoverRailpackBuilderReclamation(appName, buildNonce.length),
        `docker buildx create --name ${quotedBuilder} --driver docker-container || true`,
        'echo "Preparing Railpack build plan..." ;',
        `railpack ${prepareArgs.join(' ')} || {`,
        '  echo "❌ Railpack prepare failed" ;',
        `  docker buildx rm ${quotedBuilder} || true`,
        '  exit 1;',
        '}',
        'echo "✅ Railpack prepare completed." ;',
        'echo "Building with Railpack frontend..." ;',
        `docker ${buildArgs.join(' ')} || {`,
        '  echo "❌ Railpack build failed" ;',
        `  docker buildx rm ${quotedBuilder} || true`,
        '  exit 1;',
        '}',
        'echo "✅ Railpack build completed." ;',
        `docker buildx rm ${quotedBuilder} || true`,
      ].join('\n'),
      env: carried.env,
    };
  },
};
