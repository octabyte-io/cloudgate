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
# INTERRUPT=<signal>: the run is sent it half-way through the tarball's
# download, as Ctrl-C (INT), a kill (TERM) or a dropped SSH session (HUP) does.
case "$url" in
  *.tar.gz)
    if [ -n "\${INTERRUPT:-}" ]; then
      head -c 10 "$file" > "$out"
      kill -"$INTERRUPT" "$PPID"
      sleep 1
      exit 0
    fi
    ;;
esac
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

/**
 * GitHub's list of this repository's releases, newest first, each in the
 * order GitHub writes its fields: `tag_name` and `name` before `assets`. A
 * `vX.Y.Z` release carries its tarball and checksum unless `bare` names it,
 * as one made by hand, or still being published, does not yet.
 */
function releases(...tags: string[]) {
  releasesWithout([], ...tags);
}

function releasesWithout(bare: string[], ...tags: string[]) {
  serve(
    RELEASES_API,
    JSON.stringify(
      tags.map((tag) => {
        const tarball = `cloudgate-${tag.replace(/^v/, '')}-linux-amd64.tar.gz`;
        return {
          tag_name: tag,
          name: tag,
          draft: false,
          assets:
            bare.includes(tag) || !tag.startsWith('v')
              ? []
              : [{ name: tarball }, { name: `${tarball}.sha256` }],
        };
      }),
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

/**
 * A root run of install.sh on the scratch host. The preflight is skipped
 * unless `extra` turns it back on: it reads the test machine's own ports,
 * disk and memory otherwise.
 */
function install(extra: Record<string, string> = {}) {
  return run(installer, 0, {
    INSTALL_ROOT: root,
    CLOUDGATE_PUBLIC_HOST: '203.0.113.10',
    CLOUDGATE_SKIP_PREFLIGHT: '1',
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

  /**
   * One tarball, built on 24.04, installs on Ubuntu 24.04 and 26.04 amd64
   * (ADR-0085); every other Ubuntu version or distribution is refused by name,
   * before anything is downloaded.
   */
  describe('the Ubuntu versions it installs on', () => {
    function hostOs(content: string) {
      fs.writeFileSync(path.join(root, 'etc/os-release'), content);
    }

    it('installs on Ubuntu 26.04', () => {
      hostOs('ID=ubuntu\nVERSION_ID="26.04"\n');
      releases('v0.10.0');
      publish('0.10.0');

      const fresh = install();

      expect(fresh.stderr).toBe('');
      expect(fresh.status).toBe(0);
      expect(called()).toContain(
        `deploy/install.sh 0.10.0 from ${root}/opt/cloudgate.next`,
      );
    });

    it.each([
      ['Ubuntu 22.04', 'ID=ubuntu\nVERSION_ID="22.04"\n', 'ubuntu 22.04'],
      ['Debian 12', 'ID=debian\nVERSION_ID="12"\n', 'debian 12'],
    ])(
      'refuses %s, naming 24.04 and 26.04, before downloading anything',
      (_, content, found) => {
        hostOs(content);
        releases('v0.10.0');
        publish('0.10.0');

        const refused = install();

        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(
          `Cloudgate installs on Ubuntu 24.04 or 26.04; this host is ${found}.`,
        );
        expect(called()).toBe('');
        expect(opt()).toEqual([]);
      },
    );
  });

  describe('one run at a time', () => {
    it('refuses a run while another is under way, before changing anything', () => {
      releases('v0.10.0');
      publish('0.10.0');
      const lock = path.join(root, 'run/lock/cloudgate-install.lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      const bin = path.join(scratch, 'bin');
      fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 0\n', {
        mode: 0o755,
      });

      // The run under way holds the lock on its own open of the file.
      const second = spawnSync(
        'sh',
        ['-c', 'exec 8>"$1"; flock 8; exec sh "$2"', 'sh', lock, installer],
        {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: scratch,
            CALLS: calls,
            INSTALL_ROOT: root,
            CLOUDGATE_PUBLIC_HOST: '203.0.113.10',
          },
          encoding: 'utf8',
        },
      );

      expect(second.status).toBe(1);
      expect(second.stderr).toContain(
        'Another Cloudgate install is running on this host',
      );
      expect(called()).toBe('');
      expect(opt()).toEqual([]);
    });
  });

  describe('a run that is stopped', () => {
    it.each(['INT', 'TERM', 'HUP'])(
      'removes its download directory when it is sent SIG%s mid-download',
      (signal) => {
        releases('v0.10.0');
        publish('0.10.0');

        const stopped = install({ INTERRUPT: signal });

        expect(stopped.status).not.toBe(0);
        expect(called()).not.toContain('deploy/install.sh');
        expect(opt()).toEqual([]);
      },
    );

    it('sweeps away a download directory a killed run left behind', () => {
      releases('v0.10.0');
      publish('0.10.0');
      const leftover = path.join(root, 'opt/cloudgate.download.Ab12Cd');
      fs.mkdirSync(leftover);
      fs.writeFileSync(path.join(leftover, 'half.tar.gz'), 'half');

      const again = install();

      expect(again.status).toBe(0);
      expect(fs.existsSync(leftover)).toBe(false);
    });
  });

  describe('CLOUDGATE_PUBLIC_HOST', () => {
    it.each([
      'https://cloud.example.com',
      'cloud.example.com:3000',
      '203.0.113.10/',
      'http://203.0.113.10:4000',
      'cloud example.com',
    ])(
      'refuses %j, which is not a host alone, before changing anything',
      (host) => {
        releases('v0.10.0');
        publish('0.10.0');

        const refused = install({ CLOUDGATE_PUBLIC_HOST: host });

        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(
          `CLOUDGATE_PUBLIC_HOST is the public IP address or hostname alone`,
        );
        expect(refused.stderr).toContain(JSON.stringify(host));
        expect(called()).toBe('');
        expect(opt()).toEqual([]);
      },
    );

    it.each(['2001:db8::10', '[2001:db8::10]'])(
      'takes the IPv6 address %s, handing it over without brackets',
      (host) => {
        releases('v0.10.0');
        publish('0.10.0');

        const v6 = install({ CLOUDGATE_PUBLIC_HOST: host });

        expect(v6.stderr).toBe('');
        expect(v6.status).toBe(0);
        expect(called()).toContain(
          `deploy/install.sh 0.10.0 from ${root}/opt/cloudgate.next host=2001:db8::10\n`,
        );
      },
    );

    it('takes a hostname', () => {
      releases('v0.10.0');
      publish('0.10.0');

      const named = install({ CLOUDGATE_PUBLIC_HOST: 'cloud.example.com' });

      expect(named.status).toBe(0);
      expect(called()).toContain('host=cloud.example.com\n');
    });
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

    it('never counts a tag whose tarball has not been attached as the latest version', () => {
      releasesWithout(['v0.11.0'], 'v0.11.0', 'v0.10.0');
      publish('0.10.0');

      const fresh = install();

      expect(fresh.stderr).toBe('');
      expect(fresh.status).toBe(0);
      expect(called()).toContain(
        `deploy/install.sh 0.10.0 from ${root}/opt/cloudgate.next`,
      );
      expect(called()).not.toContain('0.11.0');
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

    it('refuses a CLOUDGATE_VERSION older than the installed one, naming both, before changing anything', () => {
      publish('0.9.0');
      versionTree('0.10.0', path.join(root, 'opt/cloudgate'));
      const before = opt();

      const older = install({ CLOUDGATE_VERSION: 'v0.9.0' });

      expect(older.status).toBe(1);
      expect(older.stderr).toContain(
        'Cloudgate 0.10.0 is installed, and 0.9.0 is older',
      );
      expect(opt()).toEqual(before);
      expect(called()).toBe('');
    });

    it('refuses CLOUDGATE_REF, naming CLOUDGATE_VERSION, before changing anything', () => {
      const refused = install({ CLOUDGATE_REF: 'main' });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('CLOUDGATE_REF is no longer read');
      expect(refused.stderr).toContain('CLOUDGATE_VERSION=v0.3.0');
      expect(called()).toBe('');
    });

    // A box installed from a git checkout, before the install installed
    // versions, is switched over by its next run (ADR-0082). The checkout has
    // no VERSION, so the run installs as on a new box; the version's own
    // deploy/install.sh moves the checkout aside (place_version, below).
    it('installs the latest version over a git checkout, keeping the checkout and /etc/default/cloudgate-* as they are', () => {
      releases('v0.10.0');
      publish('0.10.0');
      const checkout = path.join(root, 'opt/cloudgate');
      fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
      fs.writeFileSync(
        path.join(checkout, '.git/HEAD'),
        'ref: refs/heads/main\n',
      );
      fs.mkdirSync(path.join(checkout, 'deploy'));
      fs.writeFileSync(path.join(checkout, 'deploy/install.sh'), 'exit 99\n');
      const identity = {
        'cloudgate-backend':
          'APP_ENCRYPTION_SECRET=kept\nBETTER_AUTH_SECRET=kept\nDATABASE_URL=postgresql://cloudgate:pw@127.0.0.1:5432/cloudgate\n',
        'cloudgate-console':
          'NODE_ENV=production\nNEXT_PUBLIC_API_URL=http://198.51.100.7:4000\n',
        'cloudgate-secrets': 'PGPW=pw\nAPP_ENCRYPTION_SECRET=kept\n',
      };
      fs.mkdirSync(path.join(root, 'etc/default'));
      for (const [name, content] of Object.entries(identity)) {
        fs.writeFileSync(path.join(root, 'etc/default', name), content);
      }
      const checkoutBefore = opt().filter((entry) =>
        entry.startsWith('cloudgate/'),
      );

      const switched = install({ CLOUDGATE_PUBLIC_HOST: '' });

      expect(switched.stderr).toBe('');
      expect(switched.status).toBe(0);
      expect(called()).toContain(
        `curl https://${DOWNLOAD}/v0.10.0/cloudgate-0.10.0-linux-amd64.tar.gz\n`,
      );
      // The staged version's install, with the host the checkout's console had.
      expect(called()).toContain(
        `deploy/install.sh 0.10.0 from ${root}/opt/cloudgate.next host=198.51.100.7\n`,
      );
      expect(opt().filter((entry) => entry.startsWith('cloudgate/'))).toEqual(
        checkoutBefore,
      );
      for (const [name, content] of Object.entries(identity)) {
        expect(
          fs.readFileSync(path.join(root, 'etc/default', name), 'utf8'),
        ).toBe(content);
      }
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
    function previousHost(consoleEnv: string, backendEnv = ''): string {
      const source = fs.readFileSync(installer, 'utf8');
      const fn = source.match(/^previous_public_host\(\) \{\n[\s\S]*?\n\}\n/m);
      if (!fn) throw new Error('no previous_public_host in install.sh');
      const envFile = path.join(scratch, 'cloudgate-console');
      fs.writeFileSync(envFile, consoleEnv);
      const backendFile = path.join(scratch, 'cloudgate-backend');
      fs.writeFileSync(backendFile, backendEnv);
      const script = path.join(scratch, 'previous-host.sh');
      fs.writeFileSync(
        script,
        `set -eu\nCONSOLE_ENV_FILE='${envFile}'\nBACKEND_ENV_FILE='${backendFile}'\n${fn[0]}previous_public_host\n`,
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

    it('reads an IPv6 address without the brackets its URL carries', () => {
      expect(
        previousHost(
          'NODE_ENV=production\nPORT=3000\nCLOUDGATE_API_URL=http://[2001:db8::10]:4000\n',
        ),
      ).toBe('2001:db8::10');
    });

    // The Hosted instance's console is reached at https://<hostname>, which
    // names no address; the backend's env file keeps the one it was given.
    it('reads the Hosted instance’s from the backend’s CLOUDGATE_PUBLIC_HOST', () => {
      expect(
        previousHost(
          'NODE_ENV=production\nPORT=3000\nCLOUDGATE_API_URL=https://cloudgate.example.app\n',
          "NODE_ENV=production\nCLOUDGATE_PUBLIC_HOST='198.51.100.7'\n",
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
    /**
     * Runs place_version run from `from` for an install at `into`; prints
     * REPO_ROOT after. The clock is the one boundary: `date` says 2026-11-13.
     */
    function place(from: string, into: string) {
      const fn = source().match(/^place_version\(\) \{\n[\s\S]*?\n\}\n/m);
      if (!fn) throw new Error('no place_version in deploy/install.sh');
      const bin = path.join(scratch, 'bin');
      fs.writeFileSync(path.join(bin, 'date'), '#!/bin/sh\necho 2026-11-13\n', {
        mode: 0o755,
      });
      return spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; REPO_ROOT="$1"; INSTALL_DIR="$2"; ${fn[0]} place_version; echo "REPO_ROOT=$REPO_ROOT"`,
          'bash',
          from,
          into,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
    }

    /** A git checkout at `at`, as an install from before versions left it. */
    function checkoutAt(at: string) {
      fs.mkdirSync(path.join(at, '.git'), { recursive: true });
      fs.writeFileSync(path.join(at, '.git/HEAD'), 'ref: refs/heads/main\n');
      fs.mkdirSync(path.join(at, 'backend/node_modules'), { recursive: true });
      fs.mkdirSync(path.join(at, 'frontend/.next'), { recursive: true });
      fs.writeFileSync(
        path.join(at, 'frontend/.next/BUILD_ID'),
        'built here\n',
      );
    }

    it('moves a git checkout to /opt/cloudgate.checkout-<date>, keeps it, and says it can be deleted', () => {
      const into = path.join(root, 'opt/cloudgate');
      checkoutAt(into);
      versionTree('0.10.0', `${into}.next`);

      const placed = place(`${into}.next`, into);

      expect(placed.stderr).toBe('');
      expect(placed.status).toBe(0);
      expect(placed.stdout).toContain(`REPO_ROOT=${into}\n`);
      expect(fs.readFileSync(path.join(into, 'VERSION'), 'utf8')).toBe(
        '0.10.0\n',
      );
      expect(fs.existsSync(path.join(into, '.git'))).toBe(false);
      const aside = `${into}.checkout-2026-11-13`;
      expect(fs.readFileSync(path.join(aside, '.git/HEAD'), 'utf8')).toBe(
        'ref: refs/heads/main\n',
      );
      expect(
        fs.readFileSync(path.join(aside, 'frontend/.next/BUILD_ID'), 'utf8'),
      ).toBe('built here\n');
      expect(fs.readdirSync(path.join(root, 'opt')).sort()).toEqual([
        'cloudgate',
        'cloudgate.checkout-2026-11-13',
      ]);
      expect(placed.stdout).toContain(
        `Moved the git checkout that was at ${into} to ${aside}`,
      );
      expect(placed.stdout).toContain(`rm -rf ${aside}`);
    });

    it('keeps a checkout moved aside earlier the same day, moving the next one beside it', () => {
      const into = path.join(root, 'opt/cloudgate');
      const earlier = `${into}.checkout-2026-11-13`;
      checkoutAt(earlier);
      fs.writeFileSync(path.join(earlier, 'earlier'), '');
      checkoutAt(into);
      versionTree('0.10.0', `${into}.next`);

      const placed = place(`${into}.next`, into);

      expect(placed.status).toBe(0);
      expect(fs.existsSync(path.join(earlier, 'earlier'))).toBe(true);
      const aside = `${into}.checkout-2026-11-13.2`;
      expect(fs.existsSync(path.join(aside, '.git/HEAD'))).toBe(true);
      expect(fs.existsSync(path.join(aside, 'earlier'))).toBe(false);
      expect(fs.readdirSync(path.join(root, 'opt')).sort()).toEqual([
        'cloudgate',
        'cloudgate.checkout-2026-11-13',
        'cloudgate.checkout-2026-11-13.2',
      ]);
      expect(placed.stdout).toContain(`rm -rf ${aside}\n`);
    });

    it('puts the staged version in place of the installed one, keeping the old one at .previous for the units still running it', () => {
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
      // The running backend and console were started from 0.9.0 and still
      // read files from it until they restart, after the migrations.
      expect(
        fs.readFileSync(path.join(`${into}.previous`, 'VERSION'), 'utf8'),
      ).toBe('0.9.0\n');
      expect(
        fs.existsSync(path.join(`${into}.previous`, 'only-in-0.9.0')),
      ).toBe(true);
      expect(fs.readdirSync(path.join(root, 'opt')).sort()).toEqual([
        'cloudgate',
        'cloudgate.previous',
      ]);
    });

    it('replaces a .previous an earlier run left behind with the version it moves aside', () => {
      const into = path.join(root, 'opt/cloudgate');
      versionTree('0.8.0', `${into}.previous`);
      versionTree('0.9.0', into);
      versionTree('0.10.0', `${into}.next`);

      const placed = place(`${into}.next`, into);

      expect(placed.status).toBe(0);
      expect(
        fs.readFileSync(path.join(`${into}.previous`, 'VERSION'), 'utf8'),
      ).toBe('0.9.0\n');
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

  describe('drop_previous_version', () => {
    it('deletes the version place_version moved aside', () => {
      const fn = source().match(
        /^drop_previous_version\(\) \{\n[\s\S]*?\n\}\n/m,
      );
      if (!fn) throw new Error('no drop_previous_version in deploy/install.sh');
      const into = path.join(root, 'opt/cloudgate');
      versionTree('0.10.0', into);
      versionTree('0.9.0', `${into}.previous`);

      const dropped = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; INSTALL_DIR="$1"; ${fn[0]} drop_previous_version`,
          'bash',
          into,
        ],
        { encoding: 'utf8' },
      );

      expect(dropped.status).toBe(0);
      expect(fs.readdirSync(path.join(root, 'opt'))).toEqual(['cloudgate']);
    });
  });

  // A run that stops between the swap and the restarts (a migration that
  // fails, say) leaves the units on the version they started from, which
  // they still read files from: so it is deleted only once both have
  // restarted onto the new one.
  it('deletes the old version only after both units have restarted', () => {
    const lines = code();
    const placed = lines.indexOf('\nplace_version\n');
    const restarted = lines.indexOf('systemctl restart cloudgate-console\n');
    const dropped = lines.indexOf('\ndrop_previous_version\n');

    expect(placed).toBeGreaterThan(-1);
    expect(dropped).toBeGreaterThan(restarted);
    expect(restarted).toBeGreaterThan(placed);
    // place_version itself removes only a .previous left by an earlier run,
    // before it moves anything.
    const fn = lines.match(/^place_version\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
    expect(fn?.match(/rm -rf "\$INSTALL_DIR\.previous"/g)).toHaveLength(1);
  });

  /**
   * The upgrade safety net (ADR-0084): a dump of the database before a run
   * that changes the version, and the old version kept until the new one
   * answers its health check. Each function is cut out of the file as written
   * and run with its boundaries shimmed: `su` runs the command it is handed,
   * `pg_dump` prints a stand-in dump and records how it was called, and
   * `date` says 2026-11-14 12:00:00 UTC.
   */
  describe('dump_database', () => {
    const into = () => path.join(root, 'opt/cloudgate');
    const backups = () => path.join(root, 'var/backups/cloudgate');

    /**
     * `database` is Postgres's answer, before the install's guard creates
     * it, to whether a `cloudgate` database is there: the install asks once
     * and keeps the answer in `have_db`.
     */
    function dump(
      installing: string,
      options: {
        env?: Record<string, string>;
        pgDump?: string;
        database?: boolean;
      } = {},
    ) {
      const fn = source().match(/^dump_database\(\) \{\n[\s\S]*?\n\}\n/m);
      if (!fn) throw new Error('no dump_database in deploy/install.sh');
      const bin = path.join(scratch, 'bin');
      fs.writeFileSync(
        path.join(bin, 'su'),
        `#!/bin/sh\necho "su $1 $2" >> "${calls}"\nexec sh -c "$4"\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(bin, 'pg_dump'),
        options.pgDump ??
          `#!/bin/sh\necho "pg_dump $*" >> "${calls}"\necho "the cloudgate database"\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(bin, 'date'),
        '#!/bin/sh\necho 20261114T120000Z\n',
        { mode: 0o755 },
      );
      return spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; INSTALL_DIR="$1"; BACKUP_DIR="$2"; VERSION="$3"; have_db="$4"; ${fn[0]} dump_database || exit 1; echo "DATABASE_DUMP=$DATABASE_DUMP"`,
          'bash',
          into(),
          backups(),
          installing,
          options.database === false ? '' : '1',
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOSTED_MODE: '',
            ...options.env,
          },
        },
      );
    }

    function dumps(): string[] {
      return fs.existsSync(backups()) ? fs.readdirSync(backups()).sort() : [];
    }

    it('dumps the database to /var/backups/cloudgate/pre-<version>-<time>.dump, readable by root alone, when the version changes', () => {
      versionTree('0.9.0', into());

      const dumped = dump('0.10.0');

      expect(dumped.stderr).toBe('');
      expect(dumped.status).toBe(0);
      const file = path.join(backups(), 'pre-0.10.0-20261114T120000Z.dump');
      expect(dumped.stdout).toContain(`DATABASE_DUMP=${file}\n`);
      expect(fs.readFileSync(file, 'utf8')).toBe('the cloudgate database\n');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(backups()).mode & 0o777).toBe(0o700);
      expect(called()).toBe('su - postgres\npg_dump -Fc cloudgate\n');
      expect(dumped.stdout).toContain(file);
    });

    it('dumps the database before a git checkout is switched over to a version', () => {
      fs.mkdirSync(path.join(into(), '.git'), { recursive: true });

      const dumped = dump('0.10.0');

      expect(dumped.status).toBe(0);
      expect(dumps()).toEqual(['pre-0.10.0-20261114T120000Z.dump']);
    });

    it('takes no dump on a run of the version already installed', () => {
      versionTree('0.10.0', into());

      const dumped = dump('0.10.0');

      expect(dumped.status).toBe(0);
      expect(dumped.stdout).toContain('DATABASE_DUMP=\n');
      expect(dumps()).toEqual([]);
      expect(called()).toBe('');
    });

    it('takes no dump on a first install, which has no database to keep', () => {
      const dumped = dump('0.10.0', { database: false });

      expect(dumped.status).toBe(0);
      expect(dumped.stdout).toContain('DATABASE_DUMP=\n');
      expect(dumps()).toEqual([]);
      expect(called()).toBe('');
    });

    it('dumps the database on a reinstall after an uninstall, which kept the database and removed /opt/cloudgate', () => {
      const dumped = dump('0.10.0');

      expect(dumped.status).toBe(0);
      expect(dumps()).toEqual(['pre-0.10.0-20261114T120000Z.dump']);
      expect(called()).toBe('su - postgres\npg_dump -Fc cloudgate\n');
    });

    it('decides on the answer Postgres gave before the install created the database', () => {
      const lines = code();
      const asked = lines.indexOf(
        `have_db="$(su - postgres -c "psql -tAc \\"SELECT 1 FROM pg_database WHERE datname='cloudgate'\\"")"`,
      );
      const created = lines.indexOf('createdb -O cloudgate cloudgate');

      expect(asked).toBeGreaterThan(-1);
      expect(created).toBeGreaterThan(asked);
      expect(lines.indexOf('\ndump_database || exit 1\n')).toBeGreaterThan(
        created,
      );
      // Nothing between the question and the dump assigns it again.
      expect(lines.match(/\bhave_db=/g)).toHaveLength(1);
    });

    it('sweeps away a partial dump a killed run left behind', () => {
      versionTree('0.10.0', into());
      fs.mkdirSync(backups(), { recursive: true });
      fs.writeFileSync(
        path.join(backups(), 'pre-0.10.0-20261113T090000Z.dump.partial'),
        'half',
      );

      const dumped = dump('0.10.0');

      expect(dumped.status).toBe(0);
      expect(dumps()).toEqual([]);
    });

    it('skips the dump with CLOUDGATE_SKIP_BACKUP=1, and says so', () => {
      versionTree('0.9.0', into());

      const dumped = dump('0.10.0', { env: { CLOUDGATE_SKIP_BACKUP: '1' } });

      expect(dumped.status).toBe(0);
      expect(dumped.stdout).toContain('CLOUDGATE_SKIP_BACKUP=1');
      expect(dumped.stdout).toContain('DATABASE_DUMP=\n');
      expect(dumps()).toEqual([]);
      expect(called()).toBe('');
    });

    it('keeps the newest 3 dumps', () => {
      versionTree('0.9.0', into());
      fs.mkdirSync(backups(), { recursive: true });
      const older = [
        ['pre-0.7.0-20260901T090000Z.dump', '2026-09-01T09:00:00Z'],
        ['pre-0.8.0-20261001T090000Z.dump', '2026-10-01T09:00:00Z'],
        ['pre-0.9.0-20261101T090000Z.dump', '2026-11-01T09:00:00Z'],
      ];
      for (const [name, at] of older) {
        const file = path.join(backups(), name);
        fs.writeFileSync(file, '', { mode: 0o600 });
        fs.utimesSync(file, new Date(at), new Date(at));
      }
      fs.writeFileSync(path.join(backups(), 'mine.sql'), '');

      const dumped = dump('0.10.0');

      expect(dumped.status).toBe(0);
      expect(dumps()).toEqual([
        'mine.sql',
        'pre-0.10.0-20261114T120000Z.dump',
        'pre-0.8.0-20261001T090000Z.dump',
        'pre-0.9.0-20261101T090000Z.dump',
      ]);
    });

    it('fails, saying so and leaving no partial dump, when pg_dump fails', () => {
      versionTree('0.9.0', into());

      const dumped = dump('0.10.0', {
        pgDump:
          '#!/bin/sh\necho "half a dump"\necho "pg_dump: error: connection to server failed" >&2\nexit 1\n',
      });

      expect(dumped.status).toBe(1);
      expect(dumped.stderr).toContain('connection to server failed');
      expect(dumped.stderr).toContain('Nothing was changed');
      expect(dumped.stderr).toContain('CLOUDGATE_SKIP_BACKUP=1');
      expect(dumps()).toEqual([]);
    });

    it('runs before place_version, and a failed dump stops the run there', () => {
      const lines = code();
      const dumped = lines.indexOf('\ndump_database || exit 1\n');
      const placed = lines.indexOf('\nplace_version\n');

      expect(dumped).toBeGreaterThan(-1);
      expect(placed).toBeGreaterThan(dumped);
      // After Postgres is running and the cloudgate database exists.
      expect(dumped).toBeGreaterThan(
        lines.indexOf('systemctl enable --now postgresql\n'),
      );
    });

    it('takes no dump on the Hosted instance, whose updater backs up to B2 first', () => {
      versionTree('0.9.0', into());

      const dumped = dump('0.10.0', { env: { HOSTED_MODE: 'true' } });

      expect(dumped.status).toBe(0);
      expect(dumps()).toEqual([]);
      expect(called()).toBe('');
    });
  });

  describe('the health check before the old version goes', () => {
    it('deletes the old version only after the backend answers /settings/health', () => {
      const lines = code();
      const polled = lines.indexOf(
        'curl -fsS -o /dev/null "http://127.0.0.1:${API_PORT}/settings/health"',
      );
      const dropped = lines.indexOf('\ndrop_previous_version\n');

      expect(polled).toBeGreaterThan(-1);
      expect(dropped).toBeGreaterThan(polled);
      expect(lines.match(/\ndrop_previous_version\n/g)).toHaveLength(1);
      // The run ends non-zero, with the way back, before it gets there.
      const failed = lines.indexOf('  way_back >&2\n  exit 1\n');
      expect(failed).toBeGreaterThan(polled);
      expect(dropped).toBeGreaterThan(failed);
    });

    describe('way_back', () => {
      const into = () => path.join(root, 'opt/cloudgate');

      function wayBack(dumpFile: string) {
        const fn = source().match(/^way_back\(\) \{\n[\s\S]*?\n\}\n/m);
        if (!fn) throw new Error('no way_back in deploy/install.sh');
        return spawnSync(
          'bash',
          [
            '-c',
            `set -euo pipefail; API_PORT=4000; INSTALL_DIR="$1"; DATABASE_DUMP="$2"; ${fn[0]} way_back`,
            'bash',
            into(),
            dumpFile,
          ],
          { encoding: 'utf8' },
        );
      }

      /** The commands it prints to run as root, one per line, in order. */
      function steps(said: string): string[] {
        return said
          .split('\n')
          .filter((line) => line.startsWith('    '))
          .map((line) => line.trim());
      }

      /**
       * Runs the printed commands as root would, with Postgres's tools,
       * `su`, `systemctl` and `install` shimmed to record what they were
       * asked, and with what was redirected into each.
       */
      function goBack(commands: string[]) {
        const bin = path.join(scratch, 'bin');
        fs.writeFileSync(path.join(bin, 'su'), `#!/bin/sh\nexec sh -c "$4"\n`, {
          mode: 0o755,
        });
        for (const tool of ['dropdb', 'createdb']) {
          fs.writeFileSync(
            path.join(bin, tool),
            `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n`,
            { mode: 0o755 },
          );
        }
        fs.writeFileSync(
          path.join(bin, 'pg_restore'),
          `#!/bin/sh\necho "pg_restore $* < $(cat)" >> "${calls}"\n`,
          { mode: 0o755 },
        );
        fs.writeFileSync(
          path.join(bin, 'install'),
          `#!/bin/sh\necho "install $*" >> "${calls}"\n`,
          { mode: 0o755 },
        );
        return spawnSync('sh', ['-e', '-c', commands.join('\n')], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: `${bin}:${process.env.PATH}` },
        });
      }

      it('drops and recreates the database owned by cloudgate, restores the dump into it, then puts the old version back', () => {
        versionTree('0.10.0', into());
        versionTree('0.9.0', `${into()}.previous`);
        const file = path.join(scratch, 'pre-0.10.0-20261114T120000Z.dump');
        fs.writeFileSync(file, 'the dump');

        const said = wayBack(file);
        const back = goBack(steps(said.stdout));

        expect(said.status).toBe(0);
        expect(back.stderr).toBe('');
        expect(back.status).toBe(0);
        const units = `${into()}/deploy/systemd`;
        expect(called()).toBe(
          [
            'systemctl stop cloudgate-backend cloudgate-console',
            'dropdb --if-exists cloudgate',
            'createdb -O cloudgate cloudgate',
            'pg_restore --exit-on-error --single-transaction -d cloudgate < the dump',
            `install -m 0644 ${units}/cloudgate-backend.service ${units}/cloudgate-console.service /etc/systemd/system/`,
            'systemctl daemon-reload',
            'systemctl start cloudgate-backend cloudgate-console',
            '',
          ].join('\n'),
        );
        expect(fs.readFileSync(path.join(into(), 'VERSION'), 'utf8')).toBe(
          '0.9.0\n',
        );
        expect(fs.existsSync(`${into()}.previous`)).toBe(false);
      });

      it('names the dump, the old version, the backend’s journal, and what going back leaves as this run left it', () => {
        versionTree('0.10.0', into());
        versionTree('0.9.0', `${into()}.previous`);
        const file = '/var/backups/cloudgate/pre-0.10.0-20261114T120000Z.dump';

        const said = wayBack(file);

        expect(said.status).toBe(0);
        expect(said.stdout).toContain('journalctl -u cloudgate-backend');
        expect(said.stdout).toContain(
          `Cloudgate 0.9.0 is kept at ${into()}.previous`,
        );
        expect(said.stdout).toContain(file);
        expect(said.stdout).toContain('/usr/local/share/cloudgate/node');
        expect(said.stdout).toContain('Traefik');
        expect(said.stdout).toContain('/etc/default/cloudgate-*');
        expect(said.stdout).toMatch(/re-run.*removes .*\.previous/is);
        expect(said.stdout).not.toContain('pg_restore --clean');
        // The Hosted instance's backup units are the version's too, and stay.
        expect(said.stdout).not.toContain('cloudgate-*.service');
      });

      it('says the old version would run against a database the new one migrated, when no dump was taken', () => {
        versionTree('0.10.0', into());
        versionTree('0.9.0', `${into()}.previous`);

        const said = wayBack('');

        expect(said.status).toBe(0);
        expect(said.stdout).toContain('No dump of the database was taken');
        expect(said.stdout).toContain(
          'would run against a database Cloudgate 0.10.0 has migrated',
        );
        expect(steps(said.stdout).join('\n')).not.toMatch(
          /dropdb|createdb|pg_restore/,
        );
      });

      it('names only the journal when there is no old version to go back to', () => {
        versionTree('0.10.0', into());

        const said = wayBack('');

        expect(said.status).toBe(0);
        expect(said.stdout).toContain('journalctl -u cloudgate-backend');
        expect(said.stdout).not.toContain('.previous');
        expect(said.stdout).not.toContain('pg_restore');
      });
    });
  });

  /** What /opt/cloudgate holds that the run can replace, checked before anything changes. */
  describe('check_install_dir', () => {
    /** Runs check_install_dir run from `from` for an install at `into`. */
    function check(from: string, into: string) {
      const fn = source().match(/^check_install_dir\(\) \{\n[\s\S]*?\n\}\n/m);
      if (!fn) throw new Error('no check_install_dir in deploy/install.sh');
      return spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; REPO_ROOT="$1"; INSTALL_DIR="$2"; ${fn[0]} check_install_dir`,
          'bash',
          from,
          into,
        ],
        { encoding: 'utf8' },
      );
    }

    it('accepts a git checkout at /opt/cloudgate, which place_version moves aside', () => {
      const into = path.join(root, 'opt/cloudgate');
      fs.mkdirSync(path.join(into, '.git'), { recursive: true });
      versionTree('0.10.0', `${into}.next`);

      const checked = check(`${into}.next`, into);

      expect(checked.stderr).toBe('');
      expect(checked.status).toBe(0);
    });

    it('accepts an installed version and a first install', () => {
      const into = path.join(root, 'opt/cloudgate');
      versionTree('0.10.0', `${into}.next`);
      expect(check(`${into}.next`, into).status).toBe(0);

      versionTree('0.9.0', into);
      expect(check(`${into}.next`, into).status).toBe(0);
    });

    it('refuses an /opt/cloudgate that is neither a checkout nor a version, changing nothing', () => {
      const into = path.join(root, 'opt/cloudgate');
      fs.mkdirSync(into);
      fs.writeFileSync(path.join(into, 'notes'), '');
      versionTree('0.10.0', `${into}.next`);
      const before = opt();

      const refused = check(`${into}.next`, into);

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        `${into} exists but holds no Cloudgate version`,
      );
      expect(refused.stderr).toContain('Nothing was changed.');
      expect(opt()).toEqual(before);
    });

    it('runs before anything changes the box', () => {
      const lines = code();
      const checked = lines.indexOf('\ncheck_install_dir || exit 1\n');

      expect(checked).toBeGreaterThan(-1);
      for (const change of ['  hosted_save_inputs\n', '\nensure_packages ']) {
        expect(lines.indexOf(change)).toBeGreaterThan(checked);
      }
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

  describe('CLOUDGATE_PUBLIC_HOST', () => {
    it('refuses a URL in place of a host, before touching the box', () => {
      const bin = path.join(scratch, 'bin');
      fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 1000\n', {
        mode: 0o755,
      });

      const refused = spawnSync('bash', [script], {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: scratch,
          CLOUDGATE_PUBLIC_HOST: 'https://cloud.example.com',
        },
        encoding: 'utf8',
      });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        'CLOUDGATE_PUBLIC_HOST is the public IP address or hostname alone',
      );
      expect(refused.stderr).not.toContain('must run as root');
      expect(refused.stdout).not.toContain('==>');
    });

    /** The console and API origins the env files are written with, for `host`. */
    function origins(host: string): string {
      const lines = source().split('\n');
      const kept = lines.filter((line) =>
        /^(CONSOLE_ORIGIN|API_ORIGIN|CLOUDGATE_PUBLIC_HOST)=/.test(line),
      );
      const fn = source().match(/^url_host\(\) \{\n[\s\S]*?\n\}\n/m);
      return spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; CLOUDGATE_PUBLIC_HOST="$1"; CONSOLE_PORT=3000; API_PORT=4000
${fn?.[0] ?? ''}${kept.join('\n')}
echo "$CONSOLE_ORIGIN $API_ORIGIN"`,
          'bash',
          host,
        ],
        { encoding: 'utf8' },
      ).stdout.trim();
    }

    it('brackets an IPv6 address in the origins a browser is handed', () => {
      expect(origins('2001:db8::10')).toBe(
        'http://[2001:db8::10]:3000 http://[2001:db8::10]:4000',
      );
      expect(origins('[2001:db8::10]')).toBe(
        'http://[2001:db8::10]:3000 http://[2001:db8::10]:4000',
      );
    });

    it('writes an IPv4 address and a hostname as they are', () => {
      expect(origins('203.0.113.10')).toBe(
        'http://203.0.113.10:3000 http://203.0.113.10:4000',
      );
      expect(origins('cloud.example.com')).toBe(
        'http://cloud.example.com:3000 http://cloud.example.com:4000',
      );
    });
  });

  /**
   * The Traefik container step (ADR-0086), cut out of the file as written from
   * `run_traefik` to the end of the `if` that uses it, and run with `docker`
   * shimmed: it records each call, and `docker inspect` answers as a host whose
   * `cloudgate-traefik` runs `running` does, or as one with no such container.
   */
  describe('the Traefik container', () => {
    function traefik(running?: string) {
      const step = code().match(
        /\nrun_traefik\(\) \{\n[\s\S]*?\n\}\n[\s\S]*?\nfi\n/,
      );
      if (!step)
        throw new Error('no Traefik container step in deploy/install.sh');
      const bin = path.join(scratch, 'bin');
      fs.writeFileSync(
        path.join(bin, 'docker'),
        `#!/bin/sh
echo "docker $*" >> "${calls}"
if [ "$1" = inspect ]; then
  [ -n "$RUNNING" ] || exit 1
  [ "$2" = -f ] && echo "$RUNNING"
fi
exit 0
`,
        { mode: 0o755 },
      );
      const ran = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; log() { :; }; TRAEFIK_VERSION=3.6.7; CLOUDGATE_DIR=/etc/cloudgate; CONTAINER_LOG_MAX_SIZE=10m; CONTAINER_LOG_MAX_FILE=3\n${step[0]}`,
        ],
        {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            RUNNING: running ?? '',
          },
          encoding: 'utf8',
        },
      );
      const docker = called()
        .trim()
        .split('\n')
        .filter((line) => line && !line.startsWith('docker inspect'));
      return { ran, docker };
    }

    /** The one `docker run` every start of Traefik makes (deploy.md §6). */
    const RUN =
      'docker run -d --name cloudgate-traefik --restart always --network cloudgate-network' +
      ' --log-driver json-file --log-opt max-size=10m --log-opt max-file=3' +
      ' -v /etc/cloudgate/traefik/traefik.yml:/etc/traefik/traefik.yml' +
      ' -v /etc/cloudgate/traefik/dynamic:/etc/cloudgate/traefik/dynamic' +
      ' -v /var/run/docker.sock:/var/run/docker.sock' +
      ' -p 80:80 -p 443:443 -p 443:443/udp traefik:v3.6.7';

    it('pulls and starts Traefik at its version on a host with no container', () => {
      const { ran, docker } = traefik();

      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      expect(docker).toEqual(['docker pull -q traefik:v3.6.7', RUN]);
    });

    it('recreates a container on another version: pulls first, then removes and starts it, saying 80 and 443 drop', () => {
      const { ran, docker } = traefik('traefik:v3.5.0');

      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      expect(docker).toEqual([
        'docker pull -q traefik:v3.6.7',
        'docker rm -f cloudgate-traefik',
        RUN,
      ]);
      expect(ran.stdout).toContain('traefik:v3.5.0');
      expect(ran.stdout).toContain('traefik:v3.6.7');
      expect(ran.stdout).toMatch(/80 and 443 drop for a few seconds/);
    });

    it('leaves a container already at its version running, untouched', () => {
      const { ran, docker } = traefik('traefik:v3.6.7');

      expect(ran.status).toBe(0);
      // Nothing was pulled, removed or started.
      expect(docker).toEqual([]);
      expect(ran.stdout).toBe('');
    });

    it('holds the `docker run` for Traefik in one place', () => {
      expect(code().match(/\bdocker run\b/g)).toHaveLength(1);
    });
  });

  /**
   * The Firewall step, cut out of the file as written and run with ufw and
   * sshd shimmed: what it allows, and in what order relative to enabling ufw.
   */
  describe('the firewall', () => {
    function firewall(options: { sshd: string; sshConnection?: string }) {
      const step = code().match(
        /\nlog "Firewall"\n[\s\S]*?\nufw --force enable\n/,
      );
      if (!step) throw new Error('no Firewall step in deploy/install.sh');
      const bin = path.join(scratch, 'bin');
      fs.writeFileSync(
        path.join(bin, 'ufw'),
        `#!/bin/sh\necho "ufw $*" >> "${calls}"\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(bin, 'sshd'), `#!/bin/sh\n${options.sshd}\n`, {
        mode: 0o755,
      });
      const ran = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; log() { :; }; HOSTED_MODE=; CONSOLE_PORT=3000; API_PORT=4000\n${step[0]}`,
        ],
        {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            ...(options.sshConnection
              ? { SSH_CONNECTION: options.sshConnection }
              : {}),
          },
          encoding: 'utf8',
        },
      );
      return { ran, ufw: called().trim().split('\n') };
    }

    it('allows every port sshd listens on, and the one this run came in on, before it enables ufw', () => {
      const { ran, ufw } = firewall({
        sshd: '[ "$1" = -T ] && printf "port 2222\\nport 22\\naddressfamily any\\n"',
        sshConnection: '198.51.100.1 50122 203.0.113.10 2200',
      });

      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      const enabled = ufw.indexOf('ufw --force enable');
      for (const port of ['22', '2200', '2222']) {
        const allowed = ufw.indexOf(`ufw allow ${port}/tcp`);
        expect({ port, allowed: allowed > -1 }).toEqual({
          port,
          allowed: true,
        });
        expect(allowed).toBeLessThan(enabled);
      }
      expect(ufw).toContain('ufw allow OpenSSH');
    });

    it('still allows OpenSSH and enables ufw when sshd cannot say its ports', () => {
      const { ran, ufw } = firewall({ sshd: 'exit 255' });

      expect(ran.status).toBe(0);
      expect(ufw).toContain('ufw allow OpenSSH');
      expect(ufw[ufw.length - 1]).toBe('ufw --force enable');
    });
  });

  /**
   * The Node step, cut out of the file as written and run against a scratch
   * host: every `/usr/local` in it points under the scratch root, as
   * `INSTALL_ROOT` does for root install.sh. `curl` serves nodejs.org from the
   * scratch directory; `tar`, `sha256sum` and the rest are the real ones. The
   * Node it unpacks is a stand-in whose `bin/node` prints its version.
   */
  describe('Node in Cloudgate’s own folder', () => {
    const NODE_VERSION = 'v24.19.0';
    const OURS = 'usr/local/share/cloudgate/node';

    /** A file tree under the scratch root, as path → content. */
    function tree(under: string): Record<string, string> {
      const at = path.join(root, under);
      if (!fs.existsSync(at)) return {};
      return Object.fromEntries(
        fs
          .readdirSync(at, { recursive: true })
          .map(String)
          .filter((file) => fs.statSync(path.join(at, file)).isFile())
          .sort()
          .map((file) => [file, fs.readFileSync(path.join(at, file), 'utf8')]),
      );
    }

    function put(file: string, content: string, mode = 0o644) {
      const at = path.join(root, file);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, content, { mode });
    }

    /** A Node install's layout, at `into`, whose node says `version`. */
    function nodeLayout(into: string, version: string) {
      put(`${into}/bin/node`, `#!/bin/sh\necho ${version}\n`, 0o755);
      put(`${into}/lib/node_modules/npm/package.json`, `{"node":"${version}"}`);
      put(`${into}/include/node/node.h`, `/* ${version} */`);
    }

    /** nodejs.org's tarball for NODE_VERSION and its SHASUMS256.txt. */
    function serveNode() {
      const name = `node-${NODE_VERSION}-linux-x64`;
      const build = path.join(scratch, 'node-build');
      const top = path.join(build, name);
      fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
      fs.writeFileSync(
        path.join(top, 'bin/node'),
        `#!/bin/sh\necho ${NODE_VERSION}\n`,
        { mode: 0o755 },
      );
      fs.mkdirSync(path.join(top, 'lib/node_modules/npm'), { recursive: true });
      fs.writeFileSync(
        path.join(top, 'lib/node_modules/npm/package.json'),
        '{}',
      );
      fs.mkdirSync(path.join(top, 'include/node'), { recursive: true });
      fs.writeFileSync(path.join(top, 'include/node/node.h'), '');
      const tarball = path.join(scratch, `${name}.tar.xz`);
      const packed = spawnSync('tar', ['-cJf', tarball, '-C', build, name]);
      if (packed.status !== 0) throw new Error(String(packed.stderr));
      const bytes = fs.readFileSync(tarball);
      const sum = createHash('sha256').update(bytes).digest('hex');
      serve(`nodejs.org/dist/${NODE_VERSION}/${name}.tar.xz`, bytes);
      serve(
        `nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`,
        `${'0'.repeat(64)}  node-${NODE_VERSION}-linux-arm64.tar.xz\n${sum}  ${name}.tar.xz\n`,
      );
    }

    function nodeStep() {
      const step = source().match(/\n### -+ node ---\n[\s\S]*?(?=\n### -+ )/);
      if (!step) throw new Error('no node step in deploy/install.sh');
      const bin = path.join(scratch, 'bin');
      // `curl [flags] <url>`, saving the served file under its own name, as
      // -O does, or curl's own exit code for an HTTP error under -f.
      fs.writeFileSync(
        path.join(bin, 'curl'),
        `#!/bin/sh
url=''
for arg in "$@"; do case "$arg" in http*) url="$arg" ;; esac; done
echo "curl $url" >> "${calls}"
file="${served}/\${url#https://}"
[ -f "$file" ] || exit 22
cat "$file" > "\${url##*/}"
`,
        { mode: 0o755 },
      );
      const ran = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; log() { :; }; NODE_VERSION=${NODE_VERSION}\n${step[0].replaceAll('/usr/local', `${root}/usr/local`)}`,
        ],
        {
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: scratch },
          encoding: 'utf8',
        },
      );
      return ran;
    }

    it('unpacks Node into /usr/local/share/cloudgate/node', () => {
      serveNode();

      const ran = nodeStep();

      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      const node = spawnSync(path.join(root, OURS, 'bin/node'), ['--version'], {
        encoding: 'utf8',
      });
      expect(node.stdout.trim()).toBe(NODE_VERSION);
      expect(Object.keys(tree(OURS))).toEqual([
        'bin/node',
        'include/node/node.h',
        'lib/node_modules/npm/package.json',
      ]);
    });

    it('downloads nothing when the Node there is already the version', () => {
      serveNode();
      nodeLayout(OURS, NODE_VERSION);

      const ran = nodeStep();

      expect(ran.status).toBe(0);
      expect(called()).toBe('');
    });

    it('replaces an older Node in its folder whole, on an upgrade', () => {
      serveNode();
      nodeLayout(OURS, 'v22.11.0');
      put(`${OURS}/lib/node_modules/corepack/package.json`, '{}');

      const ran = nodeStep();

      expect(ran.status).toBe(0);
      expect(tree(OURS)['bin/node']).toBe(`#!/bin/sh\necho ${NODE_VERSION}\n`);
      expect(Object.keys(tree(OURS))).not.toContain(
        'lib/node_modules/corepack/package.json',
      );
    });

    it.each([
      ['a first install', false],
      ['an upgrade', true],
    ])(
      'writes and removes nothing in /usr/local/bin, lib or include, on %s',
      (_, upgrade) => {
        serveNode();
        // The operator's own Node, and what an older Cloudgate install unpacked.
        nodeLayout('usr/local', 'v20.18.0');
        put('usr/local/bin/their-script', '#!/bin/sh\n', 0o755);
        if (upgrade) nodeLayout(OURS, 'v22.11.0');
        const before = ['bin', 'lib', 'include'].map((dir) =>
          tree(`usr/local/${dir}`),
        );

        const ran = nodeStep();

        expect(ran.status).toBe(0);
        expect(
          ['bin', 'lib', 'include'].map((dir) => tree(`usr/local/${dir}`)),
        ).toEqual(before);
        expect(tree(OURS)['bin/node']).toBe(
          `#!/bin/sh\necho ${NODE_VERSION}\n`,
        );
      },
    );

    it('runs as_service_user’s node from Cloudgate’s folder, not one the operator keeps in /usr/local/bin', () => {
      const fn = source().match(/^as_service_user\(\) \{\n[\s\S]*?\n\}\n/m);
      if (!fn) throw new Error('no as_service_user in deploy/install.sh');
      nodeLayout('usr/local', 'v20.18.0');
      nodeLayout(OURS, NODE_VERSION);
      const bin = path.join(scratch, 'bin');
      fs.writeFileSync(
        path.join(bin, 'runuser'),
        '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n',
        { mode: 0o755 },
      );

      const ran = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; SERVICE_USER=cloudgate\n${fn[0].replaceAll('/usr/local', `${root}/usr/local`)}\nas_service_user sh -c 'node --version'`,
        ],
        { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' },
      );

      expect(ran.stderr).toBe('');
      expect(ran.stdout.trim()).toBe(NODE_VERSION);
    });
  });

  describe('ensure_packages', () => {
    it('waits while another apt holds its lock, then installs what is missing', () => {
      const fns = ['apt_get', 'ensure_packages']
        .map((name) =>
          source().match(
            new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'),
          ),
        )
        .map((match) => match?.[0] ?? '')
        .join('');
      const bin = path.join(scratch, 'bin');
      const tries = path.join(scratch, 'apt-tries');
      // apt on a VPS's first boot: cloud-init or unattended-upgrades holds the
      // lock for the first two tries.
      fs.writeFileSync(
        path.join(bin, 'apt-get'),
        `#!/bin/sh
echo "apt-get $*" >> "${calls}"
echo x >> "${tries}"
if [ "$(wc -l < "${tries}")" -le 2 ]; then
  echo "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 812 (apt-get)" >&2
  exit 100
fi
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(bin, 'dpkg-query'), '#!/bin/sh\nexit 1\n', {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 });

      const ran = spawnSync(
        'bash',
        ['-c', `set -euo pipefail; ${fns} ensure_packages jq rclone`],
        { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' },
      );

      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain('Installed: jq rclone');
      expect(called()).toMatch(/apt-get .*install -y -qq jq rclone/);
    });

    it('gives up on a failure that is not the lock, at once', () => {
      const fns = ['apt_get', 'ensure_packages']
        .map((name) =>
          source().match(
            new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'),
          ),
        )
        .map((match) => match?.[0] ?? '')
        .join('');
      const bin = path.join(scratch, 'bin');
      fs.writeFileSync(
        path.join(bin, 'apt-get'),
        `#!/bin/sh\necho "apt-get $*" >> "${calls}"\necho "E: Unable to locate package jq" >&2\nexit 100\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(bin, 'dpkg-query'), '#!/bin/sh\nexit 1\n', {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 });

      const ran = spawnSync(
        'bash',
        ['-c', `set -euo pipefail; ${fns} ensure_packages jq`],
        { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' },
      );

      expect(ran.status).not.toBe(0);
      expect(ran.stderr).toContain('Unable to locate package jq');
      expect(called().trim().split('\n')).toHaveLength(1);
    });
  });
});

/**
 * What root install.sh does before and around its downloads: the preflight
 * warnings and the tarball's progress bar. `curl` is wrapped so every call's
 * arguments are kept, and a probe of `https://<host>/` answers unless
 * UNREACHABLE names the host; anything else goes to the served shim above.
 */
describe('install.sh (before and while it downloads)', () => {
  const curlArgs = () => path.join(scratch, 'curl-args');

  beforeEach(() => {
    const bin = path.join(scratch, 'bin');
    fs.renameSync(path.join(bin, 'curl'), path.join(bin, 'curl-served'));
    fs.writeFileSync(
      path.join(bin, 'curl'),
      `#!/bin/sh
echo "$*" >> "${curlArgs()}"
for arg in "$@"; do
  case "$arg" in
    https://*/*/*) ;;
    https://*/)
      host="\${arg#https://}"
      host="\${host%/}"
      case " \${UNREACHABLE:-} " in *" $host "*) exit 28 ;; esac
      exit 0
      ;;
  esac
done
exec "${bin}/curl-served" "$@"
`,
      { mode: 0o755 },
    );
  });

  /** The arguments the run gave the curl that fetched `url`. */
  function argsFor(url: string): string {
    const lines = fs.existsSync(curlArgs())
      ? fs.readFileSync(curlArgs(), 'utf8').split('\n')
      : [];
    return lines.find((line) => line.endsWith(` ${url}`)) ?? '';
  }

  describe('the tarball download', () => {
    const tarball = `https://${DOWNLOAD}/v0.10.0/cloudgate-0.10.0-linux-amd64.tar.gz`;

    it('shows a progress bar when stderr is a terminal', () => {
      releases('v0.10.0');
      publish('0.10.0');
      const bin = path.join(scratch, 'bin');
      fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 0\n', {
        mode: 0o755,
      });

      // script(1) runs it on a terminal of its own.
      const onTerminal = spawnSync(
        'script',
        ['-qec', `sh ${installer}`, '/dev/null'],
        {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: scratch,
            CALLS: calls,
            INSTALL_ROOT: root,
            CLOUDGATE_PUBLIC_HOST: '203.0.113.10',
            CLOUDGATE_SKIP_PREFLIGHT: '1',
          },
          encoding: 'utf8',
        },
      );

      expect(onTerminal.status).toBe(0);
      expect(argsFor(tarball)).toContain('--progress-bar');
    });

    it('stays quiet when stderr is not a terminal', () => {
      releases('v0.10.0');
      publish('0.10.0');

      const piped = install();

      expect(piped.status).toBe(0);
      expect(piped.stderr).toBe('');
      expect(argsFor(tarball)).not.toContain('--progress-bar');
      expect(argsFor(tarball)).toMatch(/(^|\s)-[A-Za-z]*s[A-Za-z]*(\s|$)/);
    });
  });

  /**
   * The warnings before any download. `ss`, `df` and `docker` are shimmed,
   * /proc is under INSTALL_ROOT, and the host starts healthy: nothing on the
   * ports, 40 GB free, 8 GB of memory and every host answering.
   */
  describe('preflight', () => {
    // docs/deploy.md §1's Outbound row names them; each is probed.
    const HOSTS = [
      'get.docker.com',
      'nodejs.org',
      'registry.npmjs.org',
      'registry-1.docker.io',
      'api.github.com',
      'github.com',
      'release-assets.githubusercontent.com',
    ];

    function shim(tool: string, body: string) {
      fs.writeFileSync(
        path.join(scratch, 'bin', tool),
        `#!/bin/sh\n${body}\n`,
        {
          mode: 0o755,
        },
      );
    }

    /** `ss -Hltnp`'s lines, as Ubuntu 24.04's iproute2 prints them. */
    function listening(...lines: string[]) {
      fs.writeFileSync(path.join(scratch, 'ss-out'), lines.join('\n') + '\n');
    }

    /** What `df -Pk` says of /opt and of /usr/local: KiB free and the mount. */
    function disk(opt: [number, string], usrLocal: [number, string]) {
      const line = ([free, mount]: [number, string]) =>
        `/dev/sda1 99999999 1 ${free} 1% ${mount}`;
      shim(
        'df',
        `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
case "$*" in
  */opt) echo "${line(opt)}" ;;
  */usr/local) echo "${line(usrLocal)}" ;;
esac`,
      );
    }

    function memory(kB: number) {
      fs.writeFileSync(
        path.join(root, 'proc/meminfo'),
        `MemTotal:       ${kB} kB\nMemFree:         1000000 kB\n`,
      );
    }

    /** A process `pid` running in systemd unit `unit`, as /proc shows it. */
    function inUnit(pid: number, unit: string) {
      fs.mkdirSync(path.join(root, `proc/${pid}`), { recursive: true });
      fs.writeFileSync(
        path.join(root, `proc/${pid}/cgroup`),
        `0::/system.slice/${unit}\n`,
      );
    }

    beforeEach(() => {
      releases('v0.10.0');
      publish('0.10.0');
      fs.mkdirSync(path.join(root, 'proc'));
      shim('ss', `echo "ss $*" >> "${calls}"\ncat "${scratch}/ss-out"`);
      shim('docker', 'exit 0');
      listening();
      disk([40_000_000, '/'], [40_000_000, '/']);
      memory(8_000_000);
    });

    function checked(extra: Record<string, string> = {}) {
      return install({ CLOUDGATE_SKIP_PREFLIGHT: '', ...extra });
    }

    function handedOver(): boolean {
      return called().includes(
        `deploy/install.sh 0.10.0 from ${root}/opt/cloudgate.next`,
      );
    }

    it('warns about nothing on a host that is ready', () => {
      const ready = checked();

      expect(ready.status).toBe(0);
      expect(ready.stderr).toBe('');
      expect(handedOver()).toBe(true);
    });

    it('warns about a port another process holds, naming the process, and carries on', () => {
      listening(
        'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6),("nginx",pid=813,fd=6))',
        'LISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=812,fd=7))',
        'LISTEN 0 4096 127.0.0.1:4000 0.0.0.0:* users:(("python3",pid=990,fd=3))',
        'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))',
        'LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=701,fd=5))',
      );

      const busy = checked();

      expect(busy.status).toBe(0);
      expect(handedOver()).toBe(true);
      const warnings = busy.stderr
        .split('\n')
        .filter((line) => line.includes('port'));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(/port 80 .*nginx \(pid 812\)/);
      expect(warnings[1]).toMatch(/port 4000 .*python3 \(pid 990\)/);
      expect(busy.stderr).not.toMatch(/port (22|5432)/);
    });

    it('says nothing of the ports Cloudgate itself holds on a re-run', () => {
      inUnit(900, 'cloudgate-console.service');
      inUnit(901, 'cloudgate-backend.service');
      listening(
        'LISTEN 0 511 *:3000 *:* users:(("next-server (v1",pid=900,fd=20))',
        'LISTEN 0 511 *:4000 *:* users:(("node",pid=901,fd=21))',
        'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=950,fd=7))',
        'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("docker-proxy",pid=951,fd=7))',
      );
      // Cloudgate's Traefik is the container docker-proxy holds 80 and 443 for.
      shim('docker', `case "$*" in *cloudgate-traefik*) echo 3f2a9c1b ;; esac`);

      const rerun = checked();

      expect(rerun.status).toBe(0);
      expect(rerun.stderr).toBe('');
    });

    it('warns about docker-proxy on 80 when it is not Cloudgate’s Traefik', () => {
      listening(
        'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=950,fd=7))',
      );

      const other = checked();

      expect(other.status).toBe(0);
      expect(other.stderr).toMatch(/port 80 .*docker-proxy \(pid 950\)/);
    });

    it('warns when less than 15 GB is free where /opt and /usr/local live, naming each mount once', () => {
      // 12 GB on /, which holds both.
      disk([11_718_750, '/'], [11_718_750, '/']);

      const low = checked();

      expect(low.status).toBe(0);
      expect(handedOver()).toBe(true);
      const warnings = low.stderr
        .split('\n')
        .filter((line) => line.includes('free'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('12');
      expect(warnings[0]).toContain(' / ');
      expect(warnings[0]).toContain('/opt and /usr/local');
      expect(warnings[0]).toContain('15 GB');
    });

    it('warns about only the mount that is short when /opt and /usr/local are on two', () => {
      disk([40_000_000, '/opt'], [4_882_813, '/']);

      const split = checked();

      expect(split.status).toBe(0);
      const warnings = split.stderr
        .split('\n')
        .filter((line) => line.includes('free'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('/usr/local');
      expect(warnings[0]).not.toContain('/opt');
    });

    it('warns when MemTotal is under 4 GB', () => {
      memory(2_000_000);

      const small = checked();

      expect(small.status).toBe(0);
      expect(handedOver()).toBe(true);
      expect(small.stderr).toMatch(/memory.*4 GB/);
    });

    it('warns about each host that does not answer within 5 seconds, naming it', () => {
      const offline = checked({
        UNREACHABLE: 'nodejs.org release-assets.githubusercontent.com',
      });

      expect(offline.status).toBe(0);
      expect(handedOver()).toBe(true);
      const warnings = offline.stderr
        .split('\n')
        .filter((line) => line.includes('did not answer'));
      expect(warnings).toHaveLength(2);
      expect(warnings.join('\n')).toContain('nodejs.org');
      expect(warnings.join('\n')).toContain(
        'release-assets.githubusercontent.com',
      );
      for (const host of HOSTS) {
        expect({ host, probe: argsFor(`https://${host}/`) }).toEqual({
          host,
          probe: expect.stringContaining('--max-time 5') as string,
        });
      }
    });

    it('probes exactly the hosts docs/deploy.md §1 lists as outbound', () => {
      const docs = fs.readFileSync(
        path.join(repoRoot, 'docs/deploy.md'),
        'utf8',
      );
      const outbound = docs
        .split('\n')
        .find((line) => line.startsWith('| Outbound |'));
      const listed = [...(outbound ?? '').matchAll(/`([a-z0-9.-]+\.[a-z]+)`/g)]
        .map((match) => match[1])
        .sort();

      const offline = checked({ UNREACHABLE: listed.join(' ') });

      const warned = offline.stderr
        .split('\n')
        .filter((line) => line.includes('did not answer'))
        .map((line) => listed.find((host) => line.includes(` ${host} `)))
        .sort();
      expect(listed).toEqual([...HOSTS].sort());
      expect(warned).toEqual(listed);
    });

    it('carries on through every warning at once', () => {
      listening(
        'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("apache2",pid=640,fd=4))',
      );
      disk([1_000_000, '/'], [1_000_000, '/']);
      memory(1_000_000);

      const everything = checked({ UNREACHABLE: HOSTS.join(' ') });

      expect(everything.status).toBe(0);
      expect(handedOver()).toBe(true);
      expect(everything.stderr).toMatch(/port 443 .*apache2/);
      expect(everything.stderr).toContain('free on /');
      expect(everything.stderr).toContain('memory');
      expect(everything.stderr.match(/did not answer/g)).toHaveLength(
        HOSTS.length,
      );
      expect(everything.stderr).toContain('CLOUDGATE_SKIP_PREFLIGHT=1');
    });

    it('checks nothing and warns about nothing under CLOUDGATE_SKIP_PREFLIGHT=1', () => {
      listening(
        'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("apache2",pid=640,fd=4))',
      );
      disk([1_000_000, '/'], [1_000_000, '/']);
      memory(1_000_000);

      const skipped = checked({
        CLOUDGATE_SKIP_PREFLIGHT: '1',
        UNREACHABLE: HOSTS.join(' '),
      });

      expect(skipped.status).toBe(0);
      expect(skipped.stderr).toBe('');
      expect(handedOver()).toBe(true);
      expect(called()).not.toContain('ss ');
      for (const host of HOSTS) expect(argsFor(`https://${host}/`)).toBe('');
    });
  });
});

/**
 * The log every run of deploy/install.sh leaves: start_install_log cut out of
 * the file and run under bash with the log directory in scratch. The clock is
 * the one boundary: `date` says 2026-11-14 12:00:00.
 */
describe('deploy/install.sh (its log)', () => {
  const script = path.join(repoRoot, 'deploy/install.sh');
  const source = () => fs.readFileSync(script, 'utf8');
  const logs = () => path.join(scratch, 'var/log/cloudgate');
  const NEW_LOG = 'install-20261114-120000.log';

  /** Runs start_install_log, then `then`, as the rest of a run. */
  function logged(then: string) {
    const fns = ['start_install_log', 'install_log_exit']
      .map((name) => {
        const fn = source().match(
          new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'),
        );
        if (!fn) throw new Error(`no ${name} in deploy/install.sh`);
        return fn[0];
      })
      .join('');
    const bin = path.join(scratch, 'bin');
    fs.writeFileSync(
      path.join(bin, 'date'),
      '#!/bin/sh\n[ "$1" = +%Y%m%d-%H%M%S ] && echo 20261114-120000\n',
      { mode: 0o755 },
    );
    return spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail; INSTALL_LOG_DIR="$1"\n${fns}start_install_log\n${then}`,
        'bash',
        logs(),
      ],
      {
        env: { PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      },
    );
  }

  it('copies the run’s stdout and stderr to install-<YYYYmmdd-HHMMSS>.log, readable by root alone', () => {
    const ran = logged('echo "==> Docker"; echo "E: a failure" >&2');

    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('==> Docker');
    expect(ran.stderr).toContain('E: a failure');
    const log = path.join(logs(), NEW_LOG);
    expect(fs.readFileSync(log, 'utf8')).toContain('==> Docker\n');
    expect(fs.readFileSync(log, 'utf8')).toContain('E: a failure\n');
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
  });

  it('keeps the newest 10 logs, this run’s among them', () => {
    fs.mkdirSync(logs(), { recursive: true });
    for (let day = 1; day <= 12; day++) {
      const date = `202611${String(day).padStart(2, '0')}`;
      fs.writeFileSync(path.join(logs(), `install-${date}-090000.log`), '');
    }
    fs.writeFileSync(path.join(logs(), 'notes.txt'), 'mine');

    const ran = logged('true');

    expect(ran.status).toBe(0);
    expect(fs.readdirSync(logs()).sort()).toEqual([
      'install-20261104-090000.log',
      'install-20261105-090000.log',
      'install-20261106-090000.log',
      'install-20261107-090000.log',
      'install-20261108-090000.log',
      'install-20261109-090000.log',
      'install-20261110-090000.log',
      'install-20261111-090000.log',
      'install-20261112-090000.log',
      NEW_LOG,
      'notes.txt',
    ]);
  });

  it('names the log and the backend’s journal when the run fails', () => {
    const failed = logged('echo "==> Database migrations"; exit 3');

    expect(failed.status).toBe(3);
    expect(failed.stderr).toContain(path.join(logs(), NEW_LOG));
    expect(failed.stderr).toContain('journalctl -u cloudgate-backend -n 50');
  });

  it('names neither when the run succeeds', () => {
    const done = logged('echo "==> Done."');

    expect(done.status).toBe(0);
    expect(done.stderr).not.toContain('journalctl');
    expect(done.stderr).not.toContain(NEW_LOG);
  });

  it('starts logging once the run is root’s and before anything changes the box', () => {
    const lines = source()
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const root = lines.indexOf('[ "$(id -u)" -eq 0 ] ||');
    const started = lines.indexOf('\nstart_install_log\n');
    const packages = lines.indexOf('\nlog "Packages"\n');

    expect(root).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(root);
    expect(packages).toBeGreaterThan(started);
  });
});
