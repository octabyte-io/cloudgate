import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  PACK_RELEASES,
  PACK_VERSION,
  packInstallation,
  packRunImagePull,
} from '../../src/builders/pack-install';
import { herokuStrategy } from '../../src/builders/strategies/heroku.strategy';
import { paketoStrategy } from '../../src/builders/strategies/paketo.strategy';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

const execFileAsync = promisify(execFile);

/**
 * Nothing installed `pack` — not the installer, not Server setup, not
 * the build — so every Heroku and Paketo deploy on a fresh install died with
 * `/bin/sh: 12: pack: not found`. Both programs now open with the same
 * on-demand install Railpack's does, so a remote build Server gets it too.
 */
describe('packInstallation', () => {
  it.each([
    ['heroku', herokuStrategy, 'Heroku'],
    ['paketo', paketoStrategy, 'Paketo'],
  ])(
    'the %s program installs pack before it runs it, when the Server has none',
    (_name, strategy, label) => {
      const { command } = strategy.getProgram({
        appName: 'api',
        buildAppDirectory: '/apps/api/code',
        buildNonce: 'nonce123456',
      });

      expect(command.startsWith(packInstallation(label, 'nonce123456'))).toBe(
        true,
      );
      expect(command.indexOf('command -v pack')).toBeLessThan(
        command.indexOf('pack build'),
      );
    },
  );

  it('downloads the pinned tarball from buildpacks/pack for each Linux arch and checks its sha256', () => {
    const snippet = packInstallation('Heroku', 'nonce123456');

    expect(PACK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(snippet).toContain('if ! command -v pack >/dev/null 2>&1; then');
    expect(snippet).toContain(
      `https://github.com/buildpacks/pack/releases/download/v${PACK_VERSION}/$cg_pack_asset`,
    );
    for (const release of Object.values(PACK_RELEASES)) {
      expect(release.asset).toMatch(
        new RegExp(`^pack-v${PACK_VERSION}-linux(-arm64)?\\.tgz$`),
      );
      expect(release.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(snippet).toContain(`cg_pack_asset=${release.asset}`);
      expect(snippet).toContain(`cg_pack_sha256=${release.sha256}`);
    }
    expect(snippet).toContain('sha256sum -c -');
    expect(snippet).toContain('tar -xzf');
    expect(snippet).toContain('-C /usr/local/bin pack');
  });

  // The snippet introduces no substitution of its own, so the per-strategy
  // injection tests keep asserting zero and still notice a first one.
  // The payload as the nonce: it arrives as one inert word, and the zero
  // substitutions counted are the snippet's own.
  it('introduces no command substitution and quotes the nonce', () => {
    expectQuotedInCommand(packInstallation('Heroku', SHELL_PAYLOAD));
  });

  /**
   * The failure branches, run for real — against stubs, so nothing is
   * downloaded and nothing is written to /usr/local/bin. The success branch is
   * proven in a throwaway Linux container (see the install report), not here: it
   * needs the network and root.
   */
  describe('run through sh', () => {
    let dir: string;
    let stubs: string;

    const stub = (name: string, body: string): void => {
      const file = path.join(stubs, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
      fs.chmodSync(file, 0o755);
    };

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-pack-install-'));
      stubs = path.join(dir, 'bin');
      fs.mkdirSync(stubs);
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Runs the snippet with a PATH that has no `pack` on it but the stubs. */
    const run = async (
      snippet: string,
    ): Promise<{ code: number; stdout: string }> => {
      try {
        const { stdout } = await execFileAsync(
          'sh',
          ['-c', `${snippet}\necho "after the install"`],
          { env: { PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin` } },
        );
        return { code: 0, stdout };
      } catch (err) {
        const e = err as { code: number; stdout: string };
        return { code: e.code, stdout: e.stdout };
      }
    };

    it('names pack, the builder and the platform when the Server is not Linux amd64 or arm64', async () => {
      stub('uname', 'case "$1" in -s) echo Linux ;; -m) echo riscv64 ;; esac');

      const { code, stdout } = await run(packInstallation('Paketo', 'n1'));

      expect(code).toBe(1);
      expect(stdout).toContain(
        `❌ Paketo build failed: it builds with pack, which is not installed on this build Server, and Cloudgate installs pack only on Linux amd64 or arm64. Install pack v${PACK_VERSION} on the Server (https://buildpacks.io/docs/for-platform-operators/how-to/integrate-ci/pack/), or pick another builder.`,
      );
      expect(stdout).not.toContain('after the install');
    });

    it('names pack, the builder and the step when the download fails, and leaves no file behind', async () => {
      stub('uname', 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac');
      stub(
        'curl',
        'echo "curl: (6) Could not resolve host: github.com" >&2; exit 6',
      );

      const { code, stdout } = await run(packInstallation('Heroku', 'n2'));

      expect(code).toBe(1);
      expect(stdout).toContain(
        `> Installing pack v${PACK_VERSION}, which Heroku builds run, please wait…`,
      );
      expect(stdout).toContain(
        `❌ Heroku build failed: it builds with pack, which is not installed on this build Server, and installing pack v${PACK_VERSION} failed — downloading it from github.com/buildpacks/pack, checking its sha256, or writing it to /usr/local/bin (the output above says which).`,
      );
      expect(fs.existsSync('/tmp/cg-pack-n2.tgz')).toBe(false);
    });

    it('refuses a download whose sha256 is not the pinned one', async () => {
      stub('uname', 'case "$1" in -s) echo Linux ;; -m) echo aarch64 ;; esac');
      // Writes whatever `-o` names, with the wrong bytes in it.
      stub(
        'curl',
        'while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo tampered > "$2"; }; shift; done',
      );
      // A stub over `shasum`, so the check is real whichever sha256sum the host has.
      stub(
        'sha256sum',
        'read -r want file; have=`shasum -a 256 "$file" | cut -d" " -f1`; [ "$want" = "$have" ]',
      );

      const { code, stdout } = await run(packInstallation('Heroku', 'n3'));

      expect(code).toBe(1);
      expect(stdout).toContain('installing pack v');
      expect(fs.existsSync('/tmp/cg-pack-n3.tgz')).toBe(false);
    });

    it('does nothing when pack is already on the PATH', async () => {
      stub('pack', 'exit 0');
      stub('curl', 'echo "curl ran" ; exit 1');

      const { code, stdout } = await run(packInstallation('Heroku', 'n4'));

      expect(code).toBe(0);
      expect(stdout).toBe('after the install\n');
    });
  });
});

/**
 * On a daemon with the containerd image store (docker 29.4, the GitHub
 * runner's), the second of two images that share a layer is kept without that
 * layer's blob, and `pack` exports by `docker save`-ing the run image: "image
 * with reference heroku/heroku:24 was found but does not provide the specified
 * platform". pack pulls the builder first, so the program pulls the run image
 * before pack does.
 */
describe('packRunImagePull', () => {
  it.each([
    ['heroku', herokuStrategy, 'heroku/builder:24'],
    ['paketo', paketoStrategy, 'paketobuildpacks/builder-jammy-full'],
  ])(
    'the %s program pulls its builder’s run image after the install and before pack build',
    (_name, strategy, builder) => {
      const { command } = strategy.getProgram({
        appName: 'api',
        buildAppDirectory: '/apps/api/code',
        buildNonce: 'nonce123456',
      });

      const pull = command.indexOf(packRunImagePull(builder));
      expect(pull).toBeGreaterThan(command.indexOf('command -v pack'));
      expect(pull).toBeLessThan(command.indexOf('pack build'));
    },
  );

  it('pulls the run image of a quoted builder word without expanding it', () => {
    expectQuotedInCommand(
      packRunImagePull(`heroku/builder:'${SHELL_PAYLOAD}'`),
    );
  });

  /**
   * Run for real against a stubbed `pack` and `docker`, so no builder is
   * inspected and no image is pulled.
   */
  describe('run through sh', () => {
    let dir: string;
    let stubs: string;

    const stub = (name: string, body: string): void => {
      const file = path.join(stubs, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
      fs.chmodSync(file, 0o755);
    };

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-pack-pull-'));
      stubs = path.join(dir, 'bin');
      fs.mkdirSync(stubs);
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    /**
     * Runs the snippet with the stubbed `pack` and `docker` first on the PATH,
     * then echoes where the program would go on to `pack build`.
     */
    const run = async (
      snippet: string,
    ): Promise<{ code: number; stdout: string }> => {
      try {
        const { stdout } = await execFileAsync(
          'sh',
          ['-c', `${snippet}\necho "after the pull"`],
          { env: { PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin` } },
        );
        return { code: 0, stdout };
      } catch (err) {
        const e = err as { code: number; stdout: string };
        return { code: e.code, stdout: e.stdout };
      }
    };

    it('pulls the run image the builder names before pack runs', async () => {
      stub(
        'pack',
        `[ "$1 $2 $3 $4 $5" = "builder inspect heroku/builder:24 --output json" ] || exit 9
cat <<'JSON'
{
  "builder_name": "heroku/builder:24",
  "remote_info": {
    "stack": {
      "id": "heroku-24"
    },
    "run_images": [
      {
        "name": "docker.io/heroku/heroku:24"
      },
      {
        "name": "public.ecr.aws/heroku/heroku:24"
      }
    ],
    "buildpacks": [
      {
        "id": "heroku/nodejs",
        "name": "Heroku Node.js"
      }
    ]
  }
}
JSON`,
      );
      stub('docker', `echo "docker $*" >> ${path.join(dir, 'calls')}`);

      const { code } = await run(packRunImagePull('heroku/builder:24'));

      expect(code).toBe(0);
      expect(fs.readFileSync(path.join(dir, 'calls'), 'utf8')).toBe(
        'docker pull docker.io/heroku/heroku:24\n',
      );
    });

    it('carries on to pack build when the builder cannot be read', async () => {
      stub('pack', 'echo "ERROR: no builder" >&2; exit 1');
      stub('docker', `echo "docker $*" >> ${path.join(dir, 'calls')}`);

      const { code, stdout } = await run(packRunImagePull('heroku/builder:24'));

      expect(code).toBe(0);
      expect(stdout).toContain('after the pull');
      expect(fs.existsSync(path.join(dir, 'calls'))).toBe(false);
    });
  });
});
