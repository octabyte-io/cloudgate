import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeApplicationVolumeCommand } from '../../src/applications/application-volumes';
import {
  VOLUME_LOCK_BUSY_EXIT_CODE,
  withVolumeLock,
} from '../../src/deployment-engine/volume-lock';

jest.setTimeout(30_000);

/**
 * The shell program an Application Delete's `?deleteVolumes=true` sends per
 * volume, **executed** under `sh` against a fake `docker` on `PATH`
 * rather than asserted as strings — the lock's release and the wait are
 * behaviour, and `volume-lock.spec.ts` records a string assertion passing
 * throughout a bug of exactly this shape.
 *
 * The fake `docker` answers `ps` with a holder for as many calls as
 * `holders` says, and records every `volume rm` it is asked for, exiting with
 * `rm-status`. Docker itself is the boundary (§1.7).
 */
describe('removeApplicationVolumeCommand', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-676-volumes-')),
  );
  const bin = path.join(root, 'bin');
  const original = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(() => {
    process.env.CLOUDGATE_DIRECTORY = root;
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
state=${JSON.stringify(root)}
if [ "$1" = ps ]; then
  n=$(cat "$state/holders")
  if [ "$n" -gt 0 ]; then echo 0123456789ab; echo $((n - 1)) > "$state/holders"; fi
  exit 0
fi
echo "$*" >> "$state/rm.log"
status=$(cat "$state/rm-status")
if [ "$status" -ne 0 ]; then
  echo "Error response from daemon: remove $4: volume is in use - [0123456789ab]" >&2
fi
exit "$status"
`,
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.writeFileSync(path.join(root, 'holders'), '0');
    fs.writeFileSync(path.join(root, 'rm-status'), '0');
    fs.rmSync(path.join(root, 'rm.log'), { force: true });
  });

  const env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}` });

  const run = (script: string) => {
    const file = path.join(root, 'script.sh');
    fs.writeFileSync(file, script);
    const result = spawnSync('sh', [file], {
      encoding: 'utf8',
      env: env(),
      cwd: root,
    });
    return {
      status: result.status ?? -1,
      output: `${result.stdout}${result.stderr}`,
    };
  };

  const removals = () => {
    const log = path.join(root, 'rm.log');
    return fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split('\n')
      : [];
  };

  it('waits for the stopping task to let go of the volume, then removes it', () => {
    fs.writeFileSync(path.join(root, 'holders'), '2');

    const { status } = run(
      removeApplicationVolumeCommand(null, 'shop-data', 10),
    );

    expect(status).toBe(0);
    expect(removals()).toStrictEqual(['volume rm --force shop-data']);
    expect(fs.readFileSync(path.join(root, 'holders'), 'utf8').trim()).toBe(
      '0',
    );
  });

  it('stops waiting at its deadline and carries Docker’s refusal out as a failure', () => {
    fs.writeFileSync(path.join(root, 'holders'), '100');
    fs.writeFileSync(path.join(root, 'rm-status'), '1');

    const { status, output } = run(
      removeApplicationVolumeCommand(null, 'shop-data', 1),
    );

    expect(status).not.toBe(0);
    expect(status).not.toBe(VOLUME_LOCK_BUSY_EXIT_CODE);
    expect(output).toContain('volume is in use');
    expect(removals()).toStrictEqual(['volume rm --force shop-data']);
  });

  it('releases the Volume lock when the removal fails', () => {
    fs.writeFileSync(path.join(root, 'rm-status'), '1');
    expect(
      run(removeApplicationVolumeCommand(null, 'shop-data', 0)).status,
    ).not.toBe(0);

    // A fail-fast taker gets the lock straight after, so the failure did not
    // leave it held.
    const after = run(
      withVolumeLock(
        { serverId: null, volumeNames: ['shop-data'], mode: 'fail-fast' },
        'echo ACQUIRED',
      ),
    );
    expect(after.status).toBe(0);
    expect(after.output).toContain('ACQUIRED');
  });

  it('refuses with the busy status and removes nothing while a backup holds the lock', () => {
    const holderFile = path.join(root, 'holder.sh');
    fs.writeFileSync(
      holderFile,
      withVolumeLock(
        { serverId: null, volumeNames: ['shop-data'], mode: 'fail-fast' },
        'sleep 3',
      ),
    );
    const holder = spawn('sh', [holderFile], { stdio: 'ignore', env: env() });
    try {
      spawnSync('sh', ['-c', 'sleep 1']);
      const { status } = run(
        removeApplicationVolumeCommand(null, 'shop-data', 10),
      );
      expect(status).toBe(VOLUME_LOCK_BUSY_EXIT_CODE);
      expect(removals()).toStrictEqual([]);
    } finally {
      holder.kill();
    }
  });

  it('passes the volume name as one quoted word', () => {
    const marker = path.join(root, 'pwned');
    // Relative, so the name has no `/` and the lock file beside it can exist.
    const name = 'shop-data$(touch pwned)';

    run(removeApplicationVolumeCommand(null, name, 0));

    expect(fs.existsSync(marker)).toBe(false);
    expect(removals()).toStrictEqual([`volume rm --force ${name}`]);
  });
});
