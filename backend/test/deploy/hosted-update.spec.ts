import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Hosted instance's updater, `deploy/hosted-update.sh`, as
 * deploy-hosted.yml reaches it over SSH. git is real: an "origin" repository
 * with `main` and release tags, and a clone of it as the box's checkout, whose
 * `install.sh` is a stand-in that records what it was run with and
 * fast-forwards to CLOUDGATE_REF as the real one does. `id`, `sudo`,
 * `systemd-run`, `journalctl` and `systemctl` are stubbed on PATH; the
 * systemd-run stub runs the unit's command in place.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const updater = path.join(repoRoot, 'deploy/hosted-update.sh');

const STAND_IN_INSTALL = `#!/bin/sh
set -eu
env | grep -E '^(HOSTED_MODE|CLOUDGATE_REF|CLOUDGATE_PUBLIC_HOST)=' | sort > "$STUB_LOG/install-env"
echo install >> "$STUB_LOG/order"
cd "$(dirname "$0")"
git fetch -q origin "$CLOUDGATE_REF"
git merge -q --ff-only FETCH_HEAD
`;

const STUBS: Record<string, string> = {
  id: `#!/usr/bin/env bash
[ "$1" = -u ] && { echo "\${FAKE_UID:-0}"; exit 0; }
exec /usr/bin/id "$@"
`,
  sudo: `#!/usr/bin/env bash
echo "sudo $*" >> "$STUB_LOG/calls"
`,
  'systemd-run': `#!/usr/bin/env bash
echo "systemd-run $*" >> "$STUB_LOG/calls"
# The unit's command is the last three arguments: <self> --apply <tag>.
exec "\${@: -3}"
`,
  journalctl: `#!/usr/bin/env bash
echo "journalctl $*" >> "$STUB_LOG/calls"
exec /bin/sleep 30
`,
  systemctl: `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG/calls"
echo "systemctl $*" >> "$STUB_LOG/order"
[ -z "\${BACKUP_FAILS:-}" ] || exit 1
`,
  sleep: `#!/usr/bin/env bash
true
`,
};

let scratch: string;
let bin: string;
let stubLog: string;
let origin: string;
let checkout: string;
let inputsFile: string;
let backendEnv: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(message: string) {
  git(origin, 'commit', '-q', '--allow-empty', '-m', message);
  return git(origin, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-update-'));
  bin = path.join(scratch, 'bin');
  stubLog = path.join(scratch, 'log');
  fs.mkdirSync(bin);
  fs.mkdirSync(stubLog);
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }

  origin = path.join(scratch, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, 'install.sh'), STAND_IN_INSTALL, {
    mode: 0o755,
  });
  git(origin, 'add', 'install.sh');
  git(origin, 'commit', '-q', '-m', 'first');
  checkout = path.join(scratch, 'checkout');
  git(scratch, 'clone', '-q', origin, checkout);

  inputsFile = path.join(scratch, 'cloudgate-hosted');
  fs.writeFileSync(inputsFile, 'CLOUDGATE_HOSTNAME=cloudgate.octabyte.app\n');
  backendEnv = path.join(scratch, 'cloudgate-backend');
  fs.writeFileSync(
    backendEnv,
    "HOSTED_MODE=true\nCLOUDGATE_PUBLIC_HOST='203.0.113.10'\n",
  );
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [updater, ...args], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: scratch,
      STUB_LOG: stubLog,
      UPDATE_CHECKOUT: checkout,
      UPDATE_HOSTED_INPUTS_FILE: inputsFile,
      UPDATE_BACKEND_ENV_FILE: backendEnv,
      UPDATE_SELF: updater,
      ...env,
    },
    encoding: 'utf8',
  });
}

function log(name: string): string {
  const file = path.join(stubLog, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

describe('deploy/hosted-update.sh (cloudgate-update)', () => {
  it.each([[''], ['main'], ['v1.2'], ['v1.2.3; reboot'], ['v1.2.3-beta.1']])(
    'refuses %j as a tag before reaching sudo or the box',
    (tag) => {
      const refused = run([], { FAKE_UID: '1001', SSH_ORIGINAL_COMMAND: tag });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('takes one version tag such as v0.3.0');
      expect(log('calls')).toBe('');
    },
  );

  it('as cloudgate-deploy over SSH, hands the tag alone to sudo and the root-owned copy', () => {
    const handed = run([], {
      FAKE_UID: '1001',
      SSH_ORIGINAL_COMMAND: 'v0.3.0',
    });

    expect(handed.status).toBe(0);
    expect(log('calls')).toBe(`sudo -n ${updater} v0.3.0\n`);
  });

  it('does nothing on a box that is not the Hosted instance', () => {
    fs.rmSync(inputsFile);

    const refused = run(['v0.3.0']);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('this is not a Hosted instance');
    expect(log('calls')).toBe('');
  });

  it('backs up, then installs the tag in hosted mode inside its own unit', () => {
    commit('second');
    const tagged = commit('the tagged commit');
    git(origin, 'tag', '-a', 'v0.3.0', '-m', 'v0.3.0');
    commit('after the tag');

    const upgraded = run(['v0.3.0']);

    expect(upgraded.stderr).toBe('');
    expect(upgraded.status).toBe(0);
    expect(upgraded.stdout).toContain('Upgraded to v0.3.0');
    expect(log('calls')).toContain(
      `systemd-run --unit=cloudgate-update --description=Cloudgate upgrade to v0.3.0 --collect --wait`,
    );
    expect(log('calls')).toContain(`${updater} --apply v0.3.0`);
    expect(log('order')).toBe(
      'systemctl start cloudgate-backup.service\ninstall\n',
    );
    expect(log('install-env')).toBe(
      'CLOUDGATE_PUBLIC_HOST=203.0.113.10\nCLOUDGATE_REF=v0.3.0\nHOSTED_MODE=true\n',
    );
    // At the tag, not at main's newer commit.
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(tagged);
  });

  it('refuses a tag that is not on main, before the backup', () => {
    git(origin, 'checkout', '-q', '-b', 'side');
    commit('only on a branch');
    git(origin, 'tag', 'v0.3.0');
    git(origin, 'checkout', '-q', 'main');

    const refused = run(['v0.3.0']);

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('is not on main');
    expect(log('order')).toBe('');
  });

  it('refuses a tag that does not exist', () => {
    const refused = run(['v9.9.9']);

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('The tag v9.9.9 does not exist on origin');
    expect(log('order')).toBe('');
  });

  it('installs nothing when the backup before it fails', () => {
    commit('the tagged commit');
    git(origin, 'tag', 'v0.3.0');

    const failed = run(['v0.3.0'], { BACKUP_FAILS: '1' });

    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('The backup before the upgrade failed');
    expect(log('order')).toBe('systemctl start cloudgate-backup.service\n');
  });

  it('refuses --apply from anyone but root', () => {
    const refused = run(['--apply', 'v0.3.0'], { FAKE_UID: '1001' });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--apply runs as root');
    expect(log('calls')).toBe('');
  });
});
