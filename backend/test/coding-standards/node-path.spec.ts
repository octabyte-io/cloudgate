import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Cloudgate runs the Node it unpacks into its own folder,
 * /usr/local/share/cloudgate/node, and never one in /usr/local/bin, which may
 * be the operator's: the install used to unpack Node over /usr/local, and the
 * units, `as_service_user`'s PATH and the Node step's version check all named
 * the Node there. A file that names that path again runs the operator's Node,
 * or a stale one an older install left behind, in place of Cloudgate's.
 *
 * The sites are every tracked file outside `docs/`, where the history is
 * told. The needle is built, so this file does not match itself.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const NEEDLE = ['/usr/local/bin', 'node'].join('/');
const OURS = '/usr/local/share/cloudgate/node/bin/node';

describe('deploy/install.sh and deploy/systemd/, on Node in /usr/local/share/cloudgate/node', () => {
  it('names /usr/local/bin/node in no committed file outside docs/', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter((file) => file && !file.startsWith('docs/'))
      .filter((file) => fs.existsSync(path.join(repoRoot, file)));
    // A census over nothing passes for the wrong reason.
    expect(tracked).toContain('deploy/install.sh');

    const naming = tracked.filter((file) =>
      fs.readFileSync(path.join(repoRoot, file), 'utf8').includes(NEEDLE),
    );

    expect(naming).toEqual([]);
  });

  it.each([
    'deploy/systemd/cloudgate-backend.service',
    'deploy/systemd/cloudgate-console.service',
  ])('starts %s with Cloudgate’s own Node', (unit) => {
    const execStart = fs
      .readFileSync(path.join(repoRoot, unit), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('ExecStart='));

    expect(execStart).toHaveLength(1);
    expect(execStart[0]).toMatch(new RegExp(`^ExecStart=${OURS} `));
  });

  // RemoteExecService.execAsync inherits the backend unit's PATH, and a
  // command it runs that says `node` gets the first one there.
  it('puts Cloudgate’s own Node first on the backend unit’s PATH', () => {
    const unit = fs.readFileSync(
      path.join(repoRoot, 'deploy/systemd/cloudgate-backend.service'),
      'utf8',
    );

    expect(unit).toMatch(
      new RegExp(`^Environment=PATH=${path.dirname(OURS)}:`, 'm'),
    );
  });
});
