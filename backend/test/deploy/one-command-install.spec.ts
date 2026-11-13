import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The repository's root `install.sh`, the one-command Self-hosted install,
 * driven as far as a test can take it off a real box, and the step of
 * `deploy/install.sh` that puts the Cloudgate version it was handed in place.
 *
 * `install.sh` is piped to `sh`, which is dash on Ubuntu, so it is run here
 * under `sh` and never bash. The boundaries are shimmed: `curl` serves the
 * GitHub answers and release assets from a scratch directory (and anything it
 * has no file for fails as a 404 does), `apt-get` and `systemctl` only record
 * that they were called, and `id` and `uname` say what the test needs.
 * `INSTALL_ROOT` points every path the script touches (`/etc/os-release`,
 * `/opt/cloudgate`, `/etc/default/cloudgate-console`) into scratch.
 *
 * The version tarballs are built here, flat as `deploy/version-tarball.sh`
 * packs them, and hold a stand-in `deploy/install.sh` that records which
 * version it was run from and where, which is the hand-over.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const installer = path.join(repoRoot, 'install.sh');

const RELEASES_API =
  'api.github.com/repos/octabyte-io/cloudgate/releases?per_page=100';
const DOWNLOAD = 'github.com/octabyte-io/cloudgate/releases/download';

let scratch: string;
let calls: string;
let root: string;
let served: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'one-command-install-'));
  calls = path.join(scratch, 'calls');
  root = path.join(scratch, 'root');
  served = path.join(scratch, 'served');
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
  fs.mkdirSync(path.join(root, 'opt'));
  fs.writeFileSync(
    path.join(root, 'etc/os-release'),
    'ID=ubuntu\nVERSION_ID="24.04"\n',
  );
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['git', 'apt-get', 'systemctl']) {
    fs.writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n`,
      { mode: 0o755 },
    );
  }
  fs.writeFileSync(
    path.join(bin, 'uname'),
    '#!/bin/sh\n[ "$1" = -m ] && echo x86_64 || echo Linux\n',
    { mode: 0o755 },
  );
  // `curl [flags] [-o file] <url>`: the served file for the URL, to stdout or
  // to -o, or curl's own exit code for an HTTP error under -f.
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/sh
out=''
url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    http*) url="$1" ;;
  esac
  shift
done
echo "curl $url" >> "${calls}"
file="${served}/\${url#https://}"
[ -f "$file" ] || exit 22
if [ -n "$out" ]; then cat "$file" > "$out"; else cat "$file"; fi
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Serves `path` (a URL without its scheme) with `content`. */
function serve(url: string, content: string | Buffer) {
  const at = path.join(served, url);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, content);
}

/** GitHub's list of this repository's releases, newest first. */
function releases(...tags: string[]) {
  serve(
    RELEASES_API,
    JSON.stringify(
      tags.map((tag) => ({ tag_name: tag, draft: false })),
      null,
      2,
    ),
  );
}

/** The stand-in deploy/install.sh every version tarball here carries. */
const STAND_IN = `#!/usr/bin/env bash
dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
echo "deploy/install.sh $(cat "$dir/VERSION") from $dir host=$CLOUDGATE_PUBLIC_HOST" >> "${'$'}{CALLS}"
`;

/** A version's files, flat: what goes at /opt/cloudgate. */
function versionTree(version: string, into: string) {
  fs.mkdirSync(path.join(into, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(into, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(into, 'deploy/install.sh'), STAND_IN, {
    mode: 0o755,
  });
}

/**
 * Publishes `version` as a release: its tarball, and its checksum in
 * sha256sum's format, computed here rather than by the script under test.
 */
function publish(version: string, options: { checksumOf?: Buffer } = {}) {
  const tree = path.join(scratch, `tree-${version}`);
  versionTree(version, tree);
  const name = `cloudgate-${version}-linux-amd64.tar.gz`;
  const tarball = path.join(scratch, name);
  const packed = spawnSync('tar', ['-czf', tarball, '-C', tree, '.']);
  if (packed.status !== 0) throw new Error(String(packed.stderr));
  const bytes = fs.readFileSync(tarball);
  const sum = createHash('sha256')
    .update(options.checksumOf ?? bytes)
    .digest('hex');
  serve(`${DOWNLOAD}/v${version}/${name}`, bytes);
  serve(`${DOWNLOAD}/v${version}/${name}.sha256`, `${sum}  ${name}\n`);
}

/** Runs `script` under sh as `uid`, the host as `extra` says. */
function run(script: string, uid: number, extra: Record<string, string> = {}) {
  const bin = path.join(scratch, 'bin');
  fs.writeFileSync(path.join(bin, 'id'), `#!/bin/sh\necho ${uid}\n`, {
    mode: 0o755,
  });
  return spawnSync('sh', [script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: scratch,
      CALLS: calls,
      ...extra,
    },
    encoding: 'utf8',
  });
}

/** A root run of install.sh on the scratch host. */
function install(extra: Record<string, string> = {}) {
  return run(installer, 0, {
    INSTALL_ROOT: root,
    CLOUDGATE_PUBLIC_HOST: '203.0.113.10',
    ...extra,
  });
}

function called(): string {
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
}

/** Every path under the scratch host's /opt, so a run can be shown to change none. */
function opt(): string[] {
  return fs
    .readdirSync(path.join(root, 'opt'), { recursive: true })
    .map(String)
    .sort();
}

describe('install.sh (the one-command install)', () => {
  it('is POSIX sh, so `curl | sh` parses it under dash', () => {
    const parse = spawnSync('sh', ['-n', installer], { encoding: 'utf8' });

    expect(parse.stderr).toBe('');
    expect(parse.status).toBe(0);
  });

  it('refuses a run that is not root before it touches anything, saying how to run it', () => {
    const refused = run(installer, 1000);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Run it as root:');
    expect(refused.stderr).toContain('| sudo sh');
    expect(called()).toBe('');
  });

  it('runs nothing when the download is cut short', () => {
    const source = fs.readFileSync(installer, 'utf8');
    const lastLine = 'main "$@"\n';
    expect(source.endsWith(lastLine)).toBe(true);

    // Every prefix that stops before the call is a partial download.
    const lines = source.split('\n');
    for (let kept = 1; kept < lines.length - 1; kept += 7) {
      const partial = path.join(scratch, `partial-${kept}.sh`);
      fs.writeFileSync(partial, lines.slice(0, kept).join('\n'));

      const cut = run(partial, 0);

      expect({ kept, out: cut.stdout }).toEqual({ kept, out: '' });
      expect(called()).toBe('');
    }
  });

  it('downloads over HTTPS from the public repository, and never clones it', () => {
    const source = fs.readFileSync(installer, 'utf8');

    expect(source).toContain(
      'https://github.com/octabyte-io/cloudgate/releases/download',
    );
    expect(source).not.toMatch(/^\s*git /m);
  });

  describe('the Cloudgate version it installs', () => {
    it('installs the latest Cloudgate version when none is named, never a CLI tag', () => {
      releases('cli-v1.4.0', 'v0.10.0', 'cli-v1.3.0', 'v0.9.0', 'v0.3.0');
      publish('0.10.0');
      publish('0.9.0');

      const fresh = install();

      expect(fresh.stderr).toBe('');
      expect(fresh.status).toBe(0);
      expect(called()).toContain(
        `curl https://${DOWNLOAD}/v0.10.0/cloudgate-0.10.0-linux-amd64.tar.gz\n`,
      );
      expect(called()).toContain(
        `deploy/install.sh 0.10.0 from ${root}/opt/cloudgate.next host=203.0.113.10\n`,
      );
      expect(called()).not.toContain('0.9.0');
      // The download is gone once unpacked; only the staged version is left.
      expect(opt()).toContain('cloudgate.next');
      expect(
        opt().filter((entry) => !entry.startsWith('cloudgate.next')),
      ).toEqual([]);
    });

    it('installs the version CLOUDGATE_VERSION names', () => {
      releases('v0.10.0', 'v0.9.0');
      publish('0.10.0');
      publish('0.9.0');

      const named = install({ CLOUDGATE_VERSION: 'v0.9.0' });

      expect(named.status).toBe(0);
      expect(called()).toContain(
        `deploy/install.sh 0.9.0 from ${root}/opt/cloudgate.next`,
      );
      expect(called()).not.toContain('0.10.0');
      // A named version is fetched directly; the release list is not asked for.
      expect(called()).not.toContain(RELEASES_API);
    });

    it('takes the version without its v', () => {
      publish('0.9.0');

      const named = install({ CLOUDGATE_VERSION: '0.9.0' });

      expect(named.status).toBe(0);
      expect(called()).toContain('deploy/install.sh 0.9.0 from');
    });

    it('refuses a version that has no release, before changing anything', () => {
      publish('0.9.0');

      const unknown = install({ CLOUDGATE_VERSION: 'v9.9.9' });

      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain(
        'Cloudgate v9.9.9 has no published release',
      );
      expect(opt()).toEqual([]);
      expect(called()).not.toContain('deploy/install.sh');
    });

    it.each(['main', 'cli-v1.4.0', 'v1.2', 'v0.9.0-rc.1'])(
      'refuses CLOUDGATE_VERSION=%s, which is not a Cloudgate version',
      (value) => {
        const refused = install({ CLOUDGATE_VERSION: value });

        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(
          `CLOUDGATE_VERSION names a Cloudgate version such as v0.3.0, not "${value}".`,
        );
        expect(called()).toBe('');
      },
    );

    it('says so when no Cloudgate version has been published', () => {
      releases('cli-v1.4.0');

      const none = install();

      expect(none.status).toBe(1);
      expect(none.stderr).toContain(
        'No Cloudgate version has been published yet',
      );
      expect(opt()).toEqual([]);
    });

    it('refuses a download whose checksum does not match, before unpacking anything', () => {
      releases('v0.10.0');
      publish('0.10.0', { checksumOf: Buffer.from('another tarball') });

      const tampered = install();

      expect(tampered.status).toBe(1);
      expect(tampered.stderr).toContain(
        'cloudgate-0.10.0-linux-amd64.tar.gz does not match its published sha256',
      );
      // Nothing unpacked, nothing left behind, nothing handed over.
      expect(opt()).toEqual([]);
      expect(called()).not.toContain('deploy/install.sh');
    });

    it('re-runs the installed version’s own install, without downloading it, when it is the latest', () => {
      releases('v0.10.0');
      publish('0.10.0');
      versionTree('0.10.0', path.join(root, 'opt/cloudgate'));
      const before = opt();

      const rerun = install();

      expect(rerun.status).toBe(0);
      expect(rerun.stdout).toContain('Cloudgate 0.10.0 is already installed');
      expect(called()).not.toContain('.tar.gz');
      expect(called()).toContain(
        `deploy/install.sh 0.10.0 from ${root}/opt/cloudgate host=`,
      );
      expect(opt()).toEqual(before);
    });

    it('stages a newer version beside the installed one, leaving the installed one as it is', () => {
      releases('v0.10.0');
      publish('0.10.0');
      versionTree('0.9.0', path.join(root, 'opt/cloudgate'));

      const upgrade = install();

      expect(upgrade.status).toBe(0);
      expect(called()).toContain(
        `deploy/install.sh 0.10.0 from ${root}/opt/cloudgate.next`,
      );
      expect(
        fs.readFileSync(path.join(root, 'opt/cloudgate/VERSION'), 'utf8'),
      ).toBe('0.9.0\n');
    });

    it('replaces what an interrupted run left staged', () => {
      releases('v0.10.0');
      publish('0.10.0');
      const leftover = path.join(root, 'opt/cloudgate.next');
      versionTree('0.9.0', leftover);
      fs.writeFileSync(path.join(leftover, 'half-written'), '');

      const again = install();

      expect(again.status).toBe(0);
      expect(fs.existsSync(path.join(leftover, 'half-written'))).toBe(false);
      expect(fs.readFileSync(path.join(leftover, 'VERSION'), 'utf8')).toBe(
        '0.10.0\n',
      );
    });

    it('refuses CLOUDGATE_REF, naming CLOUDGATE_VERSION, before changing anything', () => {
      const refused = install({ CLOUDGATE_REF: 'main' });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('CLOUDGATE_REF is no longer read');
      expect(refused.stderr).toContain('CLOUDGATE_VERSION=v0.3.0');
      expect(called()).toBe('');
    });

    // Until a checkout is switched over by the run itself (ADR-0082), a box
    // still holding one is refused rather than half-converted.
    it('refuses a git checkout at /opt/cloudgate before changing anything', () => {
      releases('v0.10.0');
      publish('0.10.0');
      fs.mkdirSync(path.join(root, 'opt/cloudgate/.git'), { recursive: true });
      const before = opt();

      const refused = install();

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('is a git checkout');
      expect(opt()).toEqual(before);
      expect(called()).toBe('');
    });

    it('refuses an /opt/cloudgate that holds no Cloudgate version', () => {
      fs.mkdirSync(path.join(root, 'opt/cloudgate'));
      fs.writeFileSync(path.join(root, 'opt/cloudgate/notes'), '');

      const refused = install();

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('holds no Cloudgate version');
      expect(called()).toBe('');
    });
  });

  /**
   * A re-run reuses the host the last install gave the console. The console
   * env file names it CLOUDGATE_API_URL now (ADR-0082), and a box installed
   * before that still has NEXT_PUBLIC_API_URL until this run rewrites it.
   */
  describe('the host a re-run reuses', () => {
    function previousHost(consoleEnv: string): string {
      const source = fs.readFileSync(installer, 'utf8');
      const fn = source.match(/^previous_public_host\(\) \{\n[\s\S]*?\n\}\n/m);
      if (!fn) throw new Error('no previous_public_host in install.sh');
      const envFile = path.join(scratch, 'cloudgate-console');
      fs.writeFileSync(envFile, consoleEnv);
      const script = path.join(scratch, 'previous-host.sh');
      fs.writeFileSync(
        script,
        `CONSOLE_ENV_FILE='${envFile}'\n${fn[0]}previous_public_host\n`,
      );
      return spawnSync('sh', [script], { encoding: 'utf8' }).stdout.trim();
    }

    it('reads it from CLOUDGATE_API_URL', () => {
      expect(
        previousHost(
          'NODE_ENV=production\nPORT=3000\nCLOUDGATE_API_URL=http://203.0.113.10:4000\n',
        ),
      ).toBe('203.0.113.10');
    });

    it('reads it from the NEXT_PUBLIC_API_URL a console env file written before held', () => {
      expect(
        previousHost(
          'NODE_ENV=production\nPORT=3000\nNEXT_PUBLIC_API_URL=http://198.51.100.7:4000\n',
        ),
      ).toBe('198.51.100.7');
    });
  });
});

/**
 * The version install.sh hands over is installed by that version's own
 * `deploy/install.sh`. Most of that script changes the host and cannot run
 * here; what can is its version step, `place_version`, taken out of the file
 * as written and run against scratch directories, and what it refuses before
 * touching anything.
 */
describe('deploy/install.sh', () => {
  const script = path.join(repoRoot, 'deploy/install.sh');
  const source = () => fs.readFileSync(script, 'utf8');
  /** The lines that run, without the comments that explain them. */
  const code = () =>
    source()
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  describe('place_version', () => {
    /** Runs place_version run from `from` for an install at `into`; prints REPO_ROOT after. */
    function place(from: string, into: string) {
      const fn = source().match(/^place_version\(\) \{\n[\s\S]*?\n\}\n/m);
      if (!fn) throw new Error('no place_version in deploy/install.sh');
      return spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; REPO_ROOT="$1"; INSTALL_DIR="$2"; ${fn[0]} place_version; echo "REPO_ROOT=$REPO_ROOT"`,
          'bash',
          from,
          into,
        ],
        { encoding: 'utf8' },
      );
    }

    it('puts the staged version in place of the installed one, keeping neither the old one nor the staging directory', () => {
      const into = path.join(root, 'opt/cloudgate');
      versionTree('0.9.0', into);
      fs.writeFileSync(path.join(into, 'only-in-0.9.0'), '');
      versionTree('0.10.0', `${into}.next`);

      const placed = place(`${into}.next`, into);

      expect(placed.stderr).toBe('');
      expect(placed.status).toBe(0);
      expect(placed.stdout).toContain(`REPO_ROOT=${into}\n`);
      expect(fs.readFileSync(path.join(into, 'VERSION'), 'utf8')).toBe(
        '0.10.0\n',
      );
      expect(fs.existsSync(path.join(into, 'only-in-0.9.0'))).toBe(false);
      expect(fs.readdirSync(path.join(root, 'opt'))).toEqual(['cloudgate']);
    });

    it('puts the staged version in place on a first install', () => {
      const into = path.join(root, 'opt/cloudgate');
      versionTree('0.10.0', `${into}.next`);

      const placed = place(`${into}.next`, into);

      expect(placed.status).toBe(0);
      expect(fs.readFileSync(path.join(into, 'VERSION'), 'utf8')).toBe(
        '0.10.0\n',
      );
      expect(fs.readdirSync(path.join(root, 'opt'))).toEqual(['cloudgate']);
    });

    it('leaves the installed version as it is when it is the one being installed', () => {
      const into = path.join(root, 'opt/cloudgate');
      versionTree('0.10.0', into);
      const before = fs.statSync(path.join(into, 'VERSION')).ino;

      const placed = place(into, into);

      expect(placed.status).toBe(0);
      expect(placed.stdout).toContain(`REPO_ROOT=${into}\n`);
      // The same file, not a copy of it: nothing was moved.
      expect(fs.statSync(path.join(into, 'VERSION')).ino).toBe(before);
      expect(opt()).toEqual([
        'cloudgate',
        'cloudgate/VERSION',
        'cloudgate/deploy',
        'cloudgate/deploy/install.sh',
      ]);
    });
  });

  // The order a re-run on the installed version depends on: everything before
  // place_version is guarded, migrating an up-to-date database applies nothing,
  // and the restart is what is left.
  it('places the version, migrates with its own drizzle-kit, then restarts both units', () => {
    const lines = code();
    const placed = lines.indexOf('\nplace_version\n');
    const migrated = lines.indexOf('node_modules/.bin/drizzle-kit migrate');
    const restarted = lines.indexOf('systemctl restart cloudgate-backend\n');

    expect(placed).toBeGreaterThan(-1);
    expect(migrated).toBeGreaterThan(placed);
    expect(restarted).toBeGreaterThan(migrated);
    expect(lines).toContain('systemctl restart cloudgate-console\n');
  });

  it('builds nothing and installs no build tools', () => {
    const lines = code();

    for (const gone of [
      'build-essential',
      'python3',
      'pnpm',
      'corepack',
      'git clone',
      'swapon',
      'fallocate',
    ]) {
      expect({ gone, found: lines.includes(gone) }).toEqual({
        gone,
        found: false,
      });
    }
  });

  // The console in a version tarball was built to reach its API at
  // 127.0.0.1:4000 (deploy/version-tarball.sh), and its rewrites keep that.
  it('refuses an API_PORT the version’s console cannot reach, before touching the box', () => {
    const bin = path.join(scratch, 'bin');
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 1000\n', {
      mode: 0o755,
    });

    const refused = spawnSync('bash', [script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: scratch,
        CLOUDGATE_PUBLIC_HOST: '203.0.113.10',
        API_PORT: '4001',
      },
      encoding: 'utf8',
    });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('API_PORT=4001');
    expect(refused.stderr).toContain('4000');
    expect(refused.stderr).not.toContain('must run as root');
    expect(refused.stdout).not.toContain('==>');
  });
});
