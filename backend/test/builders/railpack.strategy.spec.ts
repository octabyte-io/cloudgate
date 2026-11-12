import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'shell-quote';
import {
  leftoverRailpackBuilderReclamation,
  railpackStrategy,
} from '../../src/builders/strategies/railpack.strategy';
import {
  expectQuotedInCommand,
  SEPARATOR_PAYLOAD,
  SHELL_PAYLOAD,
} from '../utils/shell-safety';

const execFileAsync = promisify(execFile);

describe('railpackStrategy.getProgram', () => {
  // The `export NODE_ENV=production` line this program used to open the
  // build with is gone — one holder carries the value to both the `--env` word
  // and the `--secret` flag, and the exec layer sends it on the SSH channel.
  it('prepares the build plan and builds with the railpack frontend, passing env as buildx secrets', () => {
    const program = railpackStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
      env: 'NODE_ENV=production',
      railpackVersion: '0.8.0',
    });

    expect(program.command).toBe(
      `export RAILPACK_VERSION=0.8.0
bash -c "$(curl -fsSL https://railpack.com/install.sh)"
for cg_leftover in $(docker buildx ls 2>/dev/null); do
  case "$cg_leftover" in railpack-api-???????????)
    echo "♻️  Removing a Railpack builder a killed build left behind: $cg_leftover" ;
    docker buildx rm "$cg_leftover" || true ;;
  esac
done
docker buildx create --name railpack-api-nonce123456 --driver docker-container || true
echo "Preparing Railpack build plan..." ;
railpack prepare /apps/api/code --plan-out /apps/api/code/railpack-plan.json --info-out /apps/api/code/railpack-info.json --env NODE_ENV"=$CG_BUILD_ENV_0" || {
  echo "❌ Railpack prepare failed" ;
  docker buildx rm railpack-api-nonce123456 || true
  exit 1;
}
echo "✅ Railpack prepare completed." ;
echo "Building with Railpack frontend..." ;
docker buildx build --builder railpack-api-nonce123456 --build-arg BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.8.0 -f /apps/api/code/railpack-plan.json --output type=docker,name=api --secret id=NODE_ENV,env=CG_BUILD_ENV_0 /apps/api/code || {
  echo "❌ Railpack build failed" ;
  docker buildx rm railpack-api-nonce123456 || true
  exit 1;
}
echo "✅ Railpack build completed." ;
docker buildx rm railpack-api-nonce123456 || true`,
    );
    expect(program.env).toEqual({ CG_BUILD_ENV_0: 'production' });
  });

  it('invalidates buildx layers via secrets-hash and cache-key args when clearing the cache', () => {
    const { command } = railpackStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
      cleanCache: true,
    });

    expect(command).toBe(
      `export RAILPACK_VERSION=0.15.4
bash -c "$(curl -fsSL https://railpack.com/install.sh)"
for cg_leftover in $(docker buildx ls 2>/dev/null); do
  case "$cg_leftover" in railpack-api-???????????)
    echo "♻️  Removing a Railpack builder a killed build left behind: $cg_leftover" ;
    docker buildx rm "$cg_leftover" || true ;;
  esac
done
docker buildx create --name railpack-api-nonce123456 --driver docker-container || true
echo "Preparing Railpack build plan..." ;
railpack prepare /apps/api/code --plan-out /apps/api/code/railpack-plan.json --info-out /apps/api/code/railpack-info.json || {
  echo "❌ Railpack prepare failed" ;
  docker buildx rm railpack-api-nonce123456 || true
  exit 1;
}
echo "✅ Railpack prepare completed." ;
echo "Building with Railpack frontend..." ;
docker buildx build --builder railpack-api-nonce123456 --build-arg secrets-hash=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 --build-arg cache-key=nonce123456 --build-arg BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.15.4 -f /apps/api/code/railpack-plan.json --output type=docker,name=api /apps/api/code || {
  echo "❌ Railpack build failed" ;
  docker buildx rm railpack-api-nonce123456 || true
  exit 1;
}
echo "✅ Railpack build completed." ;
docker buildx rm railpack-api-nonce123456 || true`,
    );
  });

  // `appName` reaches the builder name and the `--output` word,
  // `buildAppDirectory` four argument positions, and `railpackVersion` both
  // the `export` and the BUILDKIT_SYNTAX tag.
  it('quotes the app name, the build directory and the railpack version', () => {
    const { command } = railpackStrategy.getProgram({
      appName: SHELL_PAYLOAD,
      buildAppDirectory: `/apps/${SHELL_PAYLOAD}/code`,
      buildNonce: 'nonce123456',
      railpackVersion: SHELL_PAYLOAD,
    });

    // One substitution, and it is the contract rather than an injection: since
    // the leftover fix the program opens by enumerating the host's buildx builders with
    // `$(docker buildx ls …)` so it can reclaim the ones a killed build of this
    // Application left behind. `buildScheduleCommandScript`'s
    // `CONTAINER_ID=$(…)` is the precedent this argument is spelled out at.
    expectQuotedInCommand(command, SHELL_PAYLOAD, 1);
    expect(command).toContain('docker buildx create');
    expect(command).toContain('--output');
  });
});

/**
 * `railpackStrategy` removes its per-build `docker-container`
 * buildx builder on both failure branches and at the end — so the one path
 * where nothing removes it is the path where **no branch runs**: a `SIGKILL`, a
 * dropped SSH channel, a cancelled Deployment. The builder and its state volume
 * then sit on the build host under a name no row records.
 *
 * **A shell `trap` was rejected on the same fact that makes this a defect.**
 * `trap … EXIT INT TERM` inside the program is the obvious reach and it catches
 * exactly the cases the two `|| { … }` branches already catch; `SIGKILL` cannot
 * be trapped at all, and a build program that carries an environment is read by
 * `sh -s` over a channel that a dropped connection tears down under it. So the
 * fix cannot be *in* the killed build. It is in the next one.
 *
 * **A nightly sweep with an age predicate was rejected too, and this is the
 * interesting half of the ticket.** ADR-0020's sweep is safe because `-mtime`
 * makes an in-flight log structurally unselectable — the file's mtime *is*
 * now. A buildx builder has no such fact: its container's uptime is as long for
 * a live two-hour build as for a leftover, so any age predicate is a guess
 * about the longest build anyone will ever run, and getting it wrong kills a
 * running build. The queue gives an exact answer instead:
 * `deployment-queue/job-types.ts`' `getGroup` returns `application:<id>` for
 * both an Application and its previews, and `InMemoryQueue` holds one job per
 * group in flight — *"two builds of the same service never run in parallel"*.
 * So at the moment this program runs, **no other build of this Application can
 * be in flight**, and every `railpack-<appName>-<nonce>` builder that exists is
 * from a build that has ended.
 *
 * What that costs, stated rather than hidden: reclamation is deferred to the
 * next build of the same Application, so the leak is bounded at one leftover
 * per Application instead of one per killed build, and an Application that
 * never builds again keeps its leftover until it is deleted. The delete is
 * where that belongs (ADR-0016's slot, beside `${appName}:latest`) and it is
 * not in this change.
 */
describe('leftoverRailpackBuilderReclamation', () => {
  /**
   * The safety property, and it is a *length* rather than a prefix.
   *
   * `appName` is operator-chosen and only unique — nothing stops an
   * organization owning both `web` and `web-2` — so the obvious glob
   * `railpack-web-*` also matches `railpack-web-2-<nonce>`, which belongs to a
   * different Application, in a different FIFO group, whose build may be
   * running right now. The nonce is a fixed-width `nanoid()`, so the pattern
   * ends in exactly as many single-character wildcards as this build's own
   * nonce has characters: any name that extends `web-` adds a segment and a
   * separator and can never be that length.
   */
  it('cannot match the builder of an Application whose appName extends this one', () => {
    const program = leftoverRailpackBuilderReclamation('web', 21);

    expect(program).toContain(`railpack-web-${'?'.repeat(21)})`);
    expect(program).not.toContain('railpack-web-*');
  });

  /**
   * The generated shell, executed — the shape `volume-lock.spec.ts` uses,
   * because *"the pattern is right"* read off a string is not the claim: what
   * matters is which names a real `sh` hands to `docker buildx rm`.
   */
  describe('the generated shell, executed', () => {
    /** `docker buildx ls` output, in the two-line-per-builder shape buildx
     *  prints: the builder, then its indented node. */
    const BUILDX_LS = [
      'NAME/NODE                        DRIVER/ENDPOINT   STATUS    BUILDKIT',
      'default *                        docker',
      ' \\_ default                       \\_ default        running   v0.17.2',
      'railpack-web-aaaaaaaaaaaaaaaaaaaaa docker-container',
      ' \\_ railpack-web-aaaaaaaaaaaaaaaaaaaaa0  \\_ unix:///var/run/docker.sock  running   v0.17.2',
      'railpack-web-bbbbbbbbbbbbbbbbbbbbb docker-container',
      ' \\_ railpack-web-bbbbbbbbbbbbbbbbbbbbb0  \\_ unix:///var/run/docker.sock  inactive',
      'railpack-web-2-ccccccccccccccccccccc docker-container',
      ' \\_ railpack-web-2-ccccccccccccccccccccc0  \\_ unix:///var/run/docker.sock  running   v0.17.2',
      'railpack-worker-ddddddddddddddddddddd docker-container',
      ' \\_ railpack-worker-ddddddddddddddddddddd0  \\_ unix:///var/run/docker.sock  running   v0.17.2',
    ].join('\n');

    /**
     * Runs a program with a `docker` on `PATH` that answers `buildx ls` from a
     * file and records every `buildx rm` it is asked for. Answers the names it
     * was asked to remove, in order.
     */
    async function removedBy(program: string): Promise<string[]> {
      const dir = await mkdtemp(join(tmpdir(), 'cloudgate-buildx-'));
      await writeFile(join(dir, 'ls.txt'), `${BUILDX_LS}\n`);
      await writeFile(
        join(dir, 'docker'),
        [
          '#!/bin/sh',
          `if [ "$1" = buildx ] && [ "$2" = ls ]; then cat "${dir}/ls.txt"; exit 0; fi`,
          `if [ "$1" = buildx ] && [ "$2" = rm ]; then printf '%s\\n' "$3" >> "${dir}/rm.log"; exit 0; fi`,
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );

      await execFileAsync('sh', ['-c', program], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });

      return readFile(join(dir, 'rm.log'), 'utf8').then(
        (text) => text.split('\n').filter(Boolean),
        () => [],
      );
    }

    it('removes this Application’s leftover builders and nothing else', async () => {
      const removed = await removedBy(
        leftoverRailpackBuilderReclamation('web', 21),
      );

      // Both of `web`'s leftovers, whatever state their nodes are in — a
      // builder whose node reads `running` is not a build in flight, it is a
      // buildkit container nobody stopped, which is precisely what a killed
      // build leaves.
      expect(removed).toEqual([
        `railpack-web-${'a'.repeat(21)}`,
        `railpack-web-${'b'.repeat(21)}`,
      ]);
      // Nothing was asked about `web-2` or `worker`: their names are a
      // different Application's, and `web-2`'s is the one a prefix glob would
      // have swept away mid-build.
      expect(removed.join('\n')).not.toContain('web-2');
      expect(removed.join('\n')).not.toContain('worker');
    });

    it('asks for nothing when the host has no builders and buildx is not installed', async () => {
      // `docker buildx ls` exits non-zero on a host with no buildx plugin, and
      // there is no `set -e` in a build program — but the loop must also not
      // hand `docker buildx rm` an empty word, which on some hosts is an error
      // the build log would carry for ever.
      const program = leftoverRailpackBuilderReclamation('none', 21);
      const dir = await mkdtemp(join(tmpdir(), 'cloudgate-nobuildx-'));
      await writeFile(
        join(dir, 'docker'),
        [
          '#!/bin/sh',
          'if [ "$1" = buildx ] && [ "$2" = ls ]; then echo "unknown command" >&2; exit 125; fi',
          `printf '%s\\n' "$*" >> "${dir}/calls.log"`,
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );

      const { stdout, stderr } = await execFileAsync('sh', ['-c', program], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });

      expect(stdout).toBe('');
      expect(stderr).toBe('');
      await expect(readFile(join(dir, 'calls.log'), 'utf8')).rejects.toThrow();
    });

    it('reads a shell-hostile appName as one inert pattern', async () => {
      // `quote()` is the defence (`build-strategy.ts`), and a `case` pattern is
      // its own glob context: the prefix arrives quoted so no metacharacter in
      // an operator's `appName` becomes a wildcard, while the `?`s stay outside
      // the quotes so they stay wildcards.
      //
      // `expectQuotedInCommand` cannot be the assertion here, and the reason is
      // worth stating rather than working around: `shell-quote`'s `parse`
      // reports a word carrying `?` as a `glob` rather than as a string, so the
      // payload is never in that helper's `literals` however well it is quoted.
      // The payload is `SEPARATOR_PAYLOAD` rather than `SHELL_PAYLOAD` for
      // H-12's reason — it separates *and* substitutes *and* holds a space, and
      // a `case` pattern is a context where all three matter.
      const program = leftoverRailpackBuilderReclamation(SEPARATOR_PAYLOAD, 21);
      const words = parse(program);
      const opsNamed = (op: string) =>
        words.filter(
          (word) => typeof word !== 'string' && 'op' in word && word.op === op,
        );

      // The whole pattern is one word, the payload is in it verbatim, and the
      // `$(id)` inside it introduced no substitution of its own.
      expect(opsNamed('glob')).toEqual([
        {
          op: 'glob',
          pattern: `railpack-${SEPARATOR_PAYLOAD}-${'?'.repeat(21)}`,
        },
      ]);
      expect(opsNamed('(')).toHaveLength(1);

      // And run: a `;` that survived would have made this a second command, and
      // an unquoted `$(id)` would have run `id`.
      expect(await removedBy(program)).toEqual([]);
    });
  });
});
