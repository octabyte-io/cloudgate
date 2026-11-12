import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'shell-quote';
import { updateApplicationSchema } from '../../src/applications/dto/application.dto';
import {
  leftoverNixpacksContainerReclamation,
  nixpacksStrategy,
} from '../../src/builders/strategies/nixpacks.strategy';
import {
  expectQuotedInCommand,
  SEPARATOR_PAYLOAD,
  SHELL_PAYLOAD,
} from '../utils/shell-safety';

const execFileAsync = promisify(execFile);

describe('nixpacksStrategy.getProgram', () => {
  // The value is in the environment, not in the flag — see
  // `builders/build-env.ts`.
  it('builds the nixpacks command with no-cache and env words that reference their values', () => {
    const program = nixpacksStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
      env: 'NODE_ENV=production',
      cleanCache: true,
    });

    expect(program.command).toBe(
      `for cg_leftover in $(docker ps -a --format '{{.Names}}' 2>/dev/null); do
  case "$cg_leftover" in api-???????????)
    echo "♻️  Removing a container a killed Nixpacks build left behind: $cg_leftover" ;
    docker rm "$cg_leftover" || true ;;
  esac
done
echo "Starting nixpacks build..." ;
nixpacks build /apps/api/code --name api --no-cache --env NODE_ENV"=$CG_BUILD_ENV_0" || {
  echo "❌ Nixpacks build failed" ;
  exit 1;
}
echo "✅ Nixpacks build completed." ;`,
    );
    expect(program.env).toEqual({ CG_BUILD_ENV_0: 'production' });
  });

  it('copies the publish directory out of the built image and assembles a static image from it', () => {
    const { command } = nixpacksStrategy.getProgram({
      appName: 'web',
      buildAppDirectory: '/apps/web/code',
      buildNonce: 'nonce123456',
      publishDirectory: 'dist',
    });

    expect(command).toBe(
      `for cg_leftover in $(docker ps -a --format '{{.Names}}' 2>/dev/null); do
  case "$cg_leftover" in web-???????????)
    echo "♻️  Removing a container a killed Nixpacks build left behind: $cg_leftover" ;
    docker rm "$cg_leftover" || true ;;
  esac
done
echo "Starting nixpacks build..." ;
nixpacks build /apps/web/code --name web --no-error-without-start || {
  echo "❌ Nixpacks build failed" ;
  exit 1;
}
echo "✅ Nixpacks build completed." ;
docker create --name web-nonce123456 web
mkdir -p /apps/web/code/dist
docker cp web-nonce123456\\:/app/dist/. /apps/web/code/dist || {
  docker rm web-nonce123456
  echo '❌ Copying dist to /apps/web/code/dist failed' ;
  exit 1;
}
docker rm web-nonce123456
mkdir -p "/apps/web/code";
echo "LmdpdAouZW52CkRvY2tlcmZpbGUKLmRvY2tlcmlnbm9yZQ==" | base64 -d > "/apps/web/code/.dockerignore";
mkdir -p "/apps/web/code";
echo "RlJPTSBuZ2lueDphbHBpbmUKV09SS0RJUiAvdXNyL3NoYXJlL25naW54L2h0bWwvCkNPUFkgZGlzdCAuCkNNRCBbIm5naW54IiwgIi1nIiwgImRhZW1vbiBvZmY7Il0=" | base64 -d > "/apps/web/code/Dockerfile";
echo 'Building web' ;
cd /apps/web/code/ || {
  echo '❌ The path /apps/web/code/ does not exist' ;
  exit 1;
}
docker build -t web -f /apps/web/code/Dockerfile . || {
  echo "❌ Docker build failed" ;
  exit 1;
}
echo "✅ Docker build completed." ;`,
    );
  });

  it('copies a single published file without the directory contents suffix', () => {
    const { command } = nixpacksStrategy.getProgram({
      appName: 'web',
      buildAppDirectory: '/apps/web/code',
      buildNonce: 'nonce123456',
      publishDirectory: 'index.html',
    });

    expect(command).toContain(
      'docker cp web-nonce123456\\:/app/index.html /apps/web/code/index.html || {',
    );
  });

  // `publishDirectory` is a `PATCH /applications/:id` column and reached
  // `mkdir -p`, `docker cp` and the failure `echo` bare.
  it('quotes the publish directory in the mkdir, the docker cp and the echo', () => {
    const { command } = nixpacksStrategy.getProgram({
      appName: 'web',
      buildAppDirectory: '/apps/web/code',
      buildNonce: 'nonce123456',
      publishDirectory: SHELL_PAYLOAD,
    });

    // One substitution, and it is the contract rather than an injection: since
    // the leftover fix the program opens by enumerating the host's container names with
    // `$(docker ps -a --format '{{.Names}}' …)` so it can reclaim the ones a
    // killed build of this Application left behind.
    // `buildScheduleCommandScript`'s `CONTAINER_ID=$(…)` is the precedent this
    // argument is spelled out at, and `railpack.strategy.spec.ts` carries the
    // same one.
    expectQuotedInCommand(command, SHELL_PAYLOAD, 1);
    expect(command).toContain('mkdir -p');
    expect(command).toContain('docker cp');
  });
});

/**
 * The order of the assertions is the point.
 *
 * `publishDirectory` is a `PATCH /applications/:id` column, and the copy-out
 * step joins it onto the build directory with a `path.join` that *normalises* —
 * so the escape is proved against the strategy's own command before the refusal
 * is asserted against the DTO. Without the first half this is a test that a
 * schema refuses a string; with it, it is a test that the schema closes a write
 * the builder would otherwise perform.
 *
 * The two halves sit under the two units they actually exercise, per §1.7, and
 * share these helpers rather than a describe: the proof belongs to the strategy
 * and the refusal to the schema, and pretending one unit owns both is what a
 * prose title would have been hiding.
 *
 * The escaped destination is read out of `path.join` rather than written as a
 * literal, on the `wouldWriteTo` idiom in `test/mounts/mount.dto.spec.ts`: the
 * expectation is the *outcome* — the copy lands outside the tree — not a path
 * that a change to the directory layout would silently invalidate.
 */
const buildAppDirectory = '/etc/cloudgate/applications/shop-api/code';

/** Where the copy-out would actually put this publish directory. */
const wouldCopyTo = (publishDirectory: string): string =>
  path.join(buildAppDirectory, publishDirectory);

/** The whole copy-out step the strategy builds for this publish directory. */
const copyOut = (publishDirectory: string): string =>
  nixpacksStrategy.getProgram({
    appName: 'shop-api',
    buildAppDirectory,
    buildNonce: 'nonce123456',
    publishDirectory,
  }).command;

const isInside = (target: string): boolean =>
  target.startsWith(`${buildAppDirectory}/`);

describe('nixpacksStrategy.getProgram', () => {
  describe('a publishDirectory outside the build directory', () => {
    it('is a write the builder really performs outside the application tree', () => {
      const escape = '../../../traefik/dynamic';

      expect(isInside(wouldCopyTo(escape))).toBe(false);
      // …and the strategy names that destination in both the mkdir it creates and
      // the docker cp it copies into, so nothing downstream confines it.
      expect(copyOut(escape)).toContain(`mkdir -p ${wouldCopyTo(escape)}`);
      expect(copyOut(escape)).toContain(`${wouldCopyTo(escape)} || {`);
    });
  });
});

describe('updateApplicationSchema', () => {
  describe('a publishDirectory outside the build directory', () => {
    it('is refused by the column that sets it', () => {
      expect(
        updateApplicationSchema.safeParse({
          publishDirectory: '../../../traefik/dynamic',
        }).success,
      ).toBe(false);
      expect(
        updateApplicationSchema.safeParse({
          publishDirectory: 'dist/../../../../etc',
        }).success,
      ).toBe(false);
    });

    it('is refused when absolute rather than silently confined', () => {
      // path.join re-roots it, so the column would say /dist while the artifacts
      // sat in …/code/dist — a row that lies about itself (the traversal rule's reasoning).
      expect(wouldCopyTo('/dist')).toBe(`${buildAppDirectory}/dist`);
      expect(
        updateApplicationSchema.safeParse({ publishDirectory: '/dist' })
          .success,
      ).toBe(false);
    });

    it('leaves a publish directory inside the tree, and both spellings of unset, alone', () => {
      for (const publishDirectory of [
        'dist',
        'dist/',
        'build/static',
        'index.html',
        // `''` and `null` are what a client sends for "serve the whole tree", and
        // every builder reads them that way — refusing either would be a 400 for
        // the default.
        '',
        null,
      ]) {
        expect(
          updateApplicationSchema.safeParse({ publishDirectory }).success,
        ).toBe(true);
      }
      expect(isInside(wouldCopyTo('build/static'))).toBe(true);
    });
  });
});

/**
 * The railpack leftover defect on a different artifact, and the two arguments
 * that settled it are reused here rather than re-derived.
 *
 * The `publishDirectory` branch `docker create`s a throwaway container to
 * `docker cp` the compiled artifacts out of, and it `docker rm`s it on the
 * copy-failure branch and again at the end. So the one path where nothing
 * removes it is the path where **no branch runs**: a `SIGKILL`, a dropped SSH
 * channel, a cancelled Deployment. What is left is a container in `Created`
 * state holding a writable layer, under a name no row records.
 *
 * **Reclamation belongs in the next build of the same Application** because
 * `deployment-queue/job-types.ts`' `getGroup` returns `application:<id>` and
 * `InMemoryQueue` admits one job per group, so at the moment this program runs
 * no other build of this Application can be in flight. **And the match is a
 * name length rather than a prefix** because `appName` is operator-chosen and
 * merely unique, so `web-*` would match `web-2`'s artifacts. Both arguments are
 * `leftoverRailpackBuilderReclamation`'s, at full strength; what differs is the
 * reclaim verb and the enumeration.
 */
describe('leftoverNixpacksContainerReclamation', () => {
  /** The safety property, and it is a *length* rather than a prefix. */
  it('cannot match the container of an Application whose appName extends this one', () => {
    const program = leftoverNixpacksContainerReclamation('web', 21);

    expect(program).toContain(`web-${'?'.repeat(21)})`);
    expect(program).not.toContain('web-*');
  });

  /**
   * The invocation, which is the one thing the ticket asked to be established rather
   * than carried over: `docker ps -a --format '{{.Names}}'` names the field it
   * wants, where `leftoverRailpackBuilderReclamation` had to consider every
   * word of a `docker buildx ls` table because that command offered no field to
   * name.
   */
  it('enumerates container names by naming the field rather than a column', () => {
    const program = leftoverNixpacksContainerReclamation('web', 21);

    expect(program).toContain("docker ps -a --format '{{.Names}}'");
    // No `--filter name=`: that is a Go regexp, a second pattern language that
    // could disagree with the `case` pattern which is the actual filter.
    expect(program).not.toContain('--filter');
    // No `read` loop — with an environment the build program is on the shell's
    // own stdin (`RemoteExecService`'s `DEFAULT_REMOTE_ENV_SHELL`).
    expect(program).not.toContain('read ');
    expect(program).not.toContain('awk');
  });

  describe('the generated shell, executed', () => {
    /** `docker ps -a --format '{{.Names}}'` output: one name per line. */
    const PS_NAMES = [
      'cloudgate-traefik',
      `web-${'a'.repeat(21)}`,
      `web-${'b'.repeat(21)}`,
      `web-2-${'c'.repeat(21)}`,
      `worker-${'d'.repeat(21)}`,
      'web.1.qk3n8rq5m2v7t9x1c4b6z8n0p',
    ].join('\n');

    /**
     * Runs a program with a `docker` on `PATH` that answers `ps` from a file
     * and records every `rm` it is asked for.
     */
    async function removedBy(program: string): Promise<string[]> {
      const dir = await mkdtemp(join(tmpdir(), 'cloudgate-nixpacks-ps-'));
      await writeFile(join(dir, 'ps.txt'), `${PS_NAMES}\n`);
      await writeFile(
        join(dir, 'docker'),
        [
          '#!/bin/sh',
          `if [ "$1" = ps ]; then cat "${dir}/ps.txt"; exit 0; fi`,
          `if [ "$1" = rm ]; then printf '%s\\n' "$2" >> "${dir}/rm.log"; exit 0; fi`,
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

    it('removes this Application’s leftover containers and nothing else', async () => {
      const removed = await removedBy(
        leftoverNixpacksContainerReclamation('web', 21),
      );

      expect(removed).toEqual([
        `web-${'a'.repeat(21)}`,
        `web-${'b'.repeat(21)}`,
      ]);
      // `web-2`'s is the one a prefix glob would have taken from a different
      // Application in a different FIFO group, possibly mid-build.
      expect(removed.join('\n')).not.toContain('web-2');
      expect(removed.join('\n')).not.toContain('worker');
      // And a swarm task of this very Application is `web.1.<taskid>` — a `?`
      // matches the `.`, so what saves it is the literal `-` in the prefix.
      expect(removed.join('\n')).not.toContain('web.1.');
    });

    it('asks for nothing when the host lists no containers at all', async () => {
      const program = leftoverNixpacksContainerReclamation('none', 21);
      const dir = await mkdtemp(join(tmpdir(), 'cloudgate-nops-'));
      await writeFile(
        join(dir, 'docker'),
        [
          '#!/bin/sh',
          'if [ "$1" = ps ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi',
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
      // its own glob context: the prefix arrives quoted so nothing in an
      // operator's `appName` becomes a wildcard, while the `?`s stay outside the
      // quotes so they stay wildcards. `expectQuotedInCommand` cannot be the
      // assertion — `shell-quote`'s `parse` reports a word carrying `?` as a
      // `glob` rather than a string, so the payload is never in its `literals`.
      const program = leftoverNixpacksContainerReclamation(
        SEPARATOR_PAYLOAD,
        21,
      );
      const words = parse(program);
      const opsNamed = (op: string) =>
        words.filter(
          (word) => typeof word !== 'string' && 'op' in word && word.op === op,
        );

      expect(opsNamed('glob')).toEqual([
        {
          op: 'glob',
          pattern: `${SEPARATOR_PAYLOAD}-${'?'.repeat(21)}`,
        },
      ]);
      // One substitution, and it is the `$(docker ps …)` this program is built
      // around rather than anything the payload introduced.
      expect(opsNamed('(')).toHaveLength(1);
      expect(await removedBy(program)).toEqual([]);
    });
  });
});

/**
 * The sweep runs on **every** nixpacks build and before the `docker create`,
 * and both halves are load-bearing.
 */
describe('nixpacksStrategy.getProgram, leftover reclamation placement', () => {
  it('sweeps before creating this build’s own container, so its own name cannot match', () => {
    const { command } = nixpacksStrategy.getProgram({
      appName: 'web',
      buildAppDirectory: '/apps/web/code',
      buildNonce: 'nonce123456',
      publishDirectory: 'dist',
    });

    expect(command.indexOf('docker ps -a')).toBeGreaterThanOrEqual(0);
    expect(command.indexOf('docker ps -a')).toBeLessThan(
      command.indexOf('docker create'),
    );
  });

  it('sweeps even when no publishDirectory is set, because that column is a PATCH column', () => {
    // An operator who sets `publishDirectory`, has a build killed, and then
    // clears the column would otherwise keep the leftover until the delete: the
    // sweep must not be conditioned on the same column that conditions the
    // `docker create`.
    const { command } = nixpacksStrategy.getProgram({
      appName: 'web',
      buildAppDirectory: '/apps/web/code',
      buildNonce: 'nonce123456',
    });

    expect(command).toContain("docker ps -a --format '{{.Names}}'");
    expect(command).not.toContain('docker create');
  });
});
