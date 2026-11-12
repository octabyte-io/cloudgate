import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import {
  BUILD_NONCE_LENGTH,
  buildLeftoverReclamation,
} from '../../src/builders/build-leftovers';

const execFileAsync = promisify(execFile);

/**
 * The delete-time half of build-leftover reclamation: the same two sweeps, composed
 * for a caller that has no `buildNonce` because there is no build.
 *
 * The next-build reclamations bound each leak at one leftover per Application
 * rather than closing it — an Application that never builds again keeps its
 * leftover until it is deleted — and this is the program the delete sends.
 * It is the *same* generated shell rather than a second statement of the
 * matching rule, which is the whole reason this module is three lines: two
 * copies of a rule that has been wrong once is how it goes wrong again
 * (`rollbacks/preserved-images.ts`' lesson, cited by `common/teardown-steps.ts`).
 */
describe('BUILD_NONCE_LENGTH', () => {
  /**
   * The one thing a constant can get wrong, pinned against the generator rather
   * than against itself.
   *
   * Inside a build the wildcard count comes from `buildNonce.length`, so the
   * pattern and the name it matches cannot fall out of step. The delete has no
   * nonce, so it has to assert the width — and `nanoid()`'s default is the fact
   * being asserted (`DeploymentEngineService.deploy` mints `buildNonce:
   * nanoid()`). An independent source per §1.7: this calls the generator, it
   * does not restate 21.
   */
  it('is the width of the nonce the engine actually mints', () => {
    expect(BUILD_NONCE_LENGTH).toBe(nanoid().length);
  });
});

describe('buildLeftoverReclamation', () => {
  it('sweeps both artifacts a killed build can leave, at the minted nonce’s width', () => {
    const program = buildLeftoverReclamation('web');
    const wildcards = '?'.repeat(BUILD_NONCE_LENGTH);

    // The buildx builder and its state volume…
    expect(program).toContain(`railpack-web-${wildcards})`);
    expect(program).toContain('docker buildx rm');
    // …and the created container the `publishDirectory` branch copies out of.
    expect(program).toContain(`web-${wildcards})`);
    expect(program).toContain("docker ps -a --format '{{.Names}}'");
  });

  it('matches by name length, so an Application whose appName extends this one is untouched', () => {
    const program = buildLeftoverReclamation('web');

    expect(program).not.toContain('railpack-web-*');
    expect(program).not.toContain('web-*');
  });

  /**
   * The composed program, executed against a fake `docker` — the shape
   * `railpack.strategy.spec.ts` uses, because *"the pattern is right"* read off
   * a string is not the claim: what matters is which names a real `sh` hands to
   * `docker buildx rm` and `docker rm`.
   */
  describe('the generated shell, executed', () => {
    const nonce = (letter: string) => letter.repeat(BUILD_NONCE_LENGTH);

    const BUILDX_LS = [
      'NAME/NODE                        DRIVER/ENDPOINT   STATUS    BUILDKIT',
      'default *                        docker',
      `railpack-web-${nonce('a')} docker-container`,
      `railpack-web-2-${nonce('c')} docker-container`,
      `railpack-worker-${nonce('d')} docker-container`,
    ].join('\n');

    const PS_NAMES = [
      'cloudgate-traefik',
      `web-${nonce('e')}`,
      `web-2-${nonce('f')}`,
      `worker-${nonce('g')}`,
      'web.1.qk3n8rq5m2v7t9x1c4b6z8n0p',
    ].join('\n');

    async function run(program: string) {
      const dir = await mkdtemp(join(tmpdir(), 'cloudgate-leftovers-'));
      await writeFile(join(dir, 'ls.txt'), `${BUILDX_LS}\n`);
      await writeFile(join(dir, 'ps.txt'), `${PS_NAMES}\n`);
      await writeFile(
        join(dir, 'docker'),
        [
          '#!/bin/sh',
          `if [ "$1" = buildx ] && [ "$2" = ls ]; then cat "${dir}/ls.txt"; exit 0; fi`,
          `if [ "$1" = buildx ] && [ "$2" = rm ]; then printf '%s\\n' "$3" >> "${dir}/buildx-rm.log"; exit 0; fi`,
          `if [ "$1" = ps ]; then cat "${dir}/ps.txt"; exit 0; fi`,
          `if [ "$1" = rm ]; then printf '%s\\n' "$2" >> "${dir}/rm.log"; exit 0; fi`,
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );

      await execFileAsync('sh', ['-c', program], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });

      const readLog = (name: string) =>
        readFile(join(dir, name), 'utf8').then(
          (text) => text.split('\n').filter(Boolean),
          () => [],
        );
      return {
        builders: await readLog('buildx-rm.log'),
        containers: await readLog('rm.log'),
      };
    }

    it('reclaims this Application’s builder and container, and no other Application’s', async () => {
      const { builders, containers } = await run(
        buildLeftoverReclamation('web'),
      );

      expect(builders).toEqual([`railpack-web-${nonce('a')}`]);
      expect(containers).toEqual([`web-${nonce('e')}`]);
      // `web-2`'s pair is the one a prefix glob would have swept from a
      // different Application, and `web.1.<taskid>` is this Application's own
      // swarm task — saved by the literal `-` in the prefix, since a `?`
      // matches the `.`.
      expect([...builders, ...containers].join('\n')).not.toContain('web-2');
      expect([...builders, ...containers].join('\n')).not.toContain('worker');
      expect(containers.join('\n')).not.toContain('web.1.');
    });
  });
});
