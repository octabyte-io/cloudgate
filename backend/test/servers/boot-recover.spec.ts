import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BOOT_RECOVER_SCRIPT,
  BOOT_RECOVER_UNIT,
  bootRecoverProgram,
} from '../../src/servers/boot-recover';
import { serverSetupCommand } from '../../src/servers/server-setup';

/**
 * Server setup's step 8 (#105): it installs `deploy/boot-recover.sh` and its
 * unit on the Server and enables the unit, as `deploy/install.sh` does on the
 * platform host. The step is run as emitted, with its three system paths
 * pointed into scratch, `install` copying without the root owner it asks for,
 * and `systemctl` recording each call.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const read = (relative: string) =>
  fs.readFileSync(path.join(repoRoot, relative), 'utf8');

let scratch: string;
let systemd: string;
let unitDir: string;
let sbin: string;
let calls: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'server-boot-recover-'));
  systemd = path.join(scratch, 'run/systemd/system');
  unitDir = path.join(scratch, 'etc/systemd/system');
  sbin = path.join(scratch, 'usr/local/sbin');
  calls = path.join(scratch, 'calls');
  fs.mkdirSync(systemd, { recursive: true });
  fs.mkdirSync(unitDir, { recursive: true });
  fs.mkdirSync(sbin, { recursive: true });
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'systemctl'),
    `#!/bin/sh\necho "systemctl $*" >> "${calls}"\n`,
    { mode: 0o755 },
  );
  // `install -m MODE -o root -g root SRC DEST`: the copy and its mode.
  fs.writeFileSync(
    path.join(bin, 'install'),
    `#!/bin/sh
echo "install $*" >> "${calls}"
cp "$7" "$8" && chmod "$2" "$8"
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function setupStep() {
  const program = bootRecoverProgram('')
    .replaceAll('/run/systemd/system', systemd)
    .replaceAll('/etc/systemd/system', unitDir)
    // Where the program installs the script, not where the script's own
    // comment names it.
    .replace(
      / \/usr\/local\/sbin\/(?=cloudgate-boot-recover(;|\n))/g,
      ` ${sbin}/`,
    );
  return spawnSync('sh', ['-c', `set -e\n${program}`], {
    encoding: 'utf8',
    env: { PATH: `${path.join(scratch, 'bin')}:${process.env.PATH}` },
  });
}

const installedScript = () =>
  path.join(sbin, path.basename(BOOT_RECOVER_SCRIPT));
const installedUnit = () => path.join(unitDir, BOOT_RECOVER_UNIT);
const called = () =>
  fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];

describe('Server setup, step 8: boot recovery', () => {
  it('runs after the AI model network, as the last step', () => {
    const script = serverSetupCommand();
    const seven = script.indexOf('7. Setting up the AI model network');
    const eight = script.indexOf('8. Setting up boot recovery');

    expect(seven).toBeGreaterThan(0);
    expect(eight).toBeGreaterThan(seven);
    expect(script.slice(eight)).toContain(BOOT_RECOVER_UNIT);
  });

  it('installs the platform host’s script and unit byte for byte, reloads systemd and enables the unit', () => {
    const ran = setupStep();

    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(fs.readFileSync(installedScript(), 'utf8')).toBe(
      read('deploy/boot-recover.sh'),
    );
    expect(fs.statSync(installedScript()).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(installedUnit(), 'utf8')).toBe(
      read(`deploy/systemd/${BOOT_RECOVER_UNIT}`),
    );
    expect(fs.statSync(installedUnit()).mode & 0o777).toBe(0o644);
    expect(called().filter((line) => line.startsWith('systemctl'))).toEqual([
      'systemctl daemon-reload',
      `systemctl enable --quiet ${BOOT_RECOVER_UNIT}`,
    ]);
    expect(called().filter((line) => line.startsWith('install'))).toEqual([
      expect.stringMatching(/^install -m 0755 -o root -g root /),
      expect.stringMatching(/^install -m 0644 -o root -g root /),
    ]);
    expect(ran.stdout).toContain('Boot recovery installed');
  });

  it('changes nothing on a re-run, and says it is already installed', () => {
    expect(setupStep().status).toBe(0);
    fs.rmSync(calls);

    const again = setupStep();

    expect(again.status).toBe(0);
    expect(called()).toEqual([`systemctl enable --quiet ${BOOT_RECOVER_UNIT}`]);
    expect(again.stdout).toContain('Boot recovery already installed');
  });

  it('replaces a script an older Cloudgate installed, and reloads systemd', () => {
    expect(setupStep().status).toBe(0);
    fs.writeFileSync(installedScript(), '#!/bin/sh\necho older\n');
    fs.rmSync(calls);

    const again = setupStep();

    expect(again.status).toBe(0);
    expect(fs.readFileSync(installedScript(), 'utf8')).toBe(
      read('deploy/boot-recover.sh'),
    );
    expect(called()).toEqual([
      expect.stringMatching(/^install -m 0755 /),
      'systemctl daemon-reload',
      `systemctl enable --quiet ${BOOT_RECOVER_UNIT}`,
    ]);
  });

  it('skips on a Server without systemd, saying so and writing nothing', () => {
    fs.rmSync(systemd, { recursive: true });

    const ran = setupStep();

    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('No systemd on this Server');
    expect(fs.existsSync(installedScript())).toBe(false);
    expect(called()).toEqual([]);
  });
});
