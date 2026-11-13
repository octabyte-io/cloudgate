import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Hosted instance's updater, `deploy/hosted-update.sh`, as
 * deploy-hosted.yml reaches it over SSH. The network is `curl`, stubbed on
 * PATH: the tag's published `.sha256` answers unless CURL_SHA256_EXIT says
 * otherwise, and the tag's raw `install.sh` is a stand-in that records what it
 * was run with and writes the install directory's VERSION as the real one
 * does. `id`, `sudo`, `systemd-run`, `journalctl` and `systemctl` are stubbed
 * too; the systemd-run stub runs the unit's command in place.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const updater = path.join(repoRoot, 'deploy/hosted-update.sh');

const RELEASES = 'https://github.com/octabyte-io/cloudgate/releases/download';
const RAW = 'https://raw.githubusercontent.com/octabyte-io/cloudgate';

// INSTALLS_VERSION stands for an install that ends on another version.
const STAND_IN_INSTALL = `#!/bin/sh
set -eu
env | grep -E '^(HOSTED_MODE|CLOUDGATE_REF|CLOUDGATE_VERSION|CLOUDGATE_PUBLIC_HOST)=' | sort > "$STUB_LOG/install-env"
echo install >> "$STUB_LOG/order"
installs="\${INSTALLS_VERSION:-\${CLOUDGATE_VERSION#v}}"
printf '%s\\n' "$installs" > "$UPDATE_INSTALL_DIR/VERSION"
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
  // GitHub. A missing release is curl -f's exit 22, no network is 6.
  curl: `#!/usr/bin/env bash
out=/dev/stdout
url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "curl $url" >> "$STUB_LOG/calls"
case "$url" in
  *.sha256)
    [ "\${CURL_SHA256_EXIT:-0}" -eq 0 ] || exit "$CURL_SHA256_EXIT"
    echo "0123abcd  \${url##*/}" > "$out" ;;
  */install.sh)
    [ "\${CURL_INSTALL_EXIT:-0}" -eq 0 ] || exit "$CURL_INSTALL_EXIT"
    cp "$STAND_IN" "$out" ;;
  *) exit 22 ;;
esac
`,
};

let scratch: string;
let bin: string;
let stubLog: string;
let installDir: string;
let standIn: string;
let inputsFile: string;
let backendEnv: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-update-'));
  bin = path.join(scratch, 'bin');
  stubLog = path.join(scratch, 'log');
  fs.mkdirSync(bin);
  fs.mkdirSync(stubLog);
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  standIn = path.join(scratch, 'stand-in-install.sh');
  fs.writeFileSync(standIn, STAND_IN_INSTALL, { mode: 0o755 });

  // The version installed now. Its own install.sh is the previous version's
  // (or, on a box still holding a checkout, a checkout's), never the one run.
  installDir = path.join(scratch, 'opt-cloudgate');
  fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, 'VERSION'), '0.2.0\n');
  fs.writeFileSync(
    path.join(installDir, 'install.sh'),
    '#!/bin/sh\necho installed-install.sh >> "$STUB_LOG/order"\nexit 1\n',
    { mode: 0o755 },
  );

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
      STAND_IN: standIn,
      UPDATE_INSTALL_DIR: installDir,
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

  it('refuses a tag with no published release, before the backup', () => {
    const refused = run(['v0.3.0'], { CURL_SHA256_EXIT: '22' });

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('v0.3.0 has no published release');
    expect(log('calls')).toContain(
      `curl ${RELEASES}/v0.3.0/cloudgate-0.3.0-linux-amd64.tar.gz.sha256\n`,
    );
    expect(log('order')).toBe('');
  });

  it('backs up, then installs the published version with the tag’s own install.sh in hosted mode inside its own unit', () => {
    const upgraded = run(['v0.3.0']);

    expect(upgraded.stderr).toBe('');
    expect(upgraded.status).toBe(0);
    expect(upgraded.stdout).toContain('Upgraded to v0.3.0');
    expect(log('calls')).toContain(
      `systemd-run --unit=cloudgate-update --description=Cloudgate upgrade to v0.3.0 --collect --wait`,
    );
    expect(log('calls')).toContain(`${updater} --apply v0.3.0`);
    expect(log('calls')).toContain(`curl ${RAW}/v0.3.0/install.sh\n`);
    expect(log('order')).toBe(
      'systemctl start cloudgate-backup.service\ninstall\n',
    );
    expect(log('install-env')).toBe(
      'CLOUDGATE_PUBLIC_HOST=203.0.113.10\nCLOUDGATE_VERSION=v0.3.0\nHOSTED_MODE=true\n',
    );
    expect(fs.readFileSync(path.join(installDir, 'VERSION'), 'utf8')).toBe(
      '0.3.0\n',
    );
  });

  it('says GitHub could not be asked, rather than that the tag is unpublished, before the backup', () => {
    const refused = run(['v0.3.0'], { CURL_SHA256_EXIT: '6' });

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(
      'Could not ask GitHub whether v0.3.0 is published (curl exit 6)',
    );
    expect(refused.stderr).not.toContain('has no published release');
    expect(log('order')).toBe('');
  });

  it('backs nothing up when the tag’s install.sh cannot be downloaded', () => {
    const refused = run(['v0.3.0'], { CURL_INSTALL_EXIT: '22' });

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(
      `Could not download ${RAW}/v0.3.0/install.sh`,
    );
    expect(log('order')).toBe('');
  });

  it('installs nothing when the backup before it fails', () => {
    const failed = run(['v0.3.0'], { BACKUP_FAILS: '1' });

    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('The backup before the upgrade failed');
    expect(log('order')).toBe('systemctl start cloudgate-backup.service\n');
  });

  it('fails when the install ends with another version installed', () => {
    const failed = run(['v0.3.0'], { INSTALLS_VERSION: '0.2.0' });

    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain(
      `The install finished but ${installDir}/VERSION says 0.2.0, not 0.3.0.`,
    );
    expect(failed.stdout).not.toContain('Upgraded to v0.3.0');
  });

  it('refuses --apply from anyone but root', () => {
    const refused = run(['--apply', 'v0.3.0'], { FAKE_UID: '1001' });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--apply runs as root');
    expect(log('calls')).toBe('');
  });
});
