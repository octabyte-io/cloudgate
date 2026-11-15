import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DOCKER_VERSION } from '../../src/servers/server-setup';

/**
 * The platform host gets the Docker a Server does: `deploy/install.sh` and the
 * Server setup both run `get.docker.com` with `--version`, and each writes the
 * version down once, as `DOCKER_VERSION`. These tests are what keep the two
 * one pin, so a fresh install shows no Docker drift in the console.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const installer = () =>
  fs.readFileSync(path.join(repoRoot, 'deploy/install.sh'), 'utf8');

/** An assignment from install.sh, with any `${X:-default}` unwrapped. */
function installDefault(name: string): string {
  const line = installer().match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];
  if (line === undefined) throw new Error(`install.sh assigns no ${name}`);
  const fallback = line.match(/^"\$\{\w+:-(.*)\}"$/);
  return fallback ? fallback[1] : line;
}

describe('DOCKER_VERSION', () => {
  it('install.sh pins the Docker version the Server setup installs', () => {
    expect(installDefault('DOCKER_VERSION')).toBe(DOCKER_VERSION);
  });

  it('is an exact version, never a channel or a range', () => {
    expect(installDefault('DOCKER_VERSION')).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/**
 * The Docker step, cut out of the file as written and run with `curl`
 * serving a stand-in for get.docker.com's script that records its arguments,
 * and `systemctl` recording that it was called.
 */
describe('deploy/install.sh (the Docker step)', () => {
  let scratch: string;
  let calls: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-pin-'));
    calls = path.join(scratch, 'calls');
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'curl'),
      `#!/bin/sh
for arg in "$@"; do case "$arg" in http*) echo "curl $arg" >> "${calls}" ;; esac; done
echo 'echo "get.docker.com $*" >> "${calls}"'
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'systemctl'),
      `#!/bin/sh\necho "systemctl $*" >> "${calls}"\n`,
      { mode: 0o755 },
    );
    // The step's PATH is this directory alone, so a docker on the machine
    // running the test is never the one the step finds.
    fs.symlinkSync('/bin/sh', path.join(bin, 'sh'));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function dockerStep(dockerOnPath: boolean) {
    const step = installer().match(
      /\nlog "Docker"\n[\s\S]*?\nsystemctl enable --now docker\n/,
    );
    if (!step) throw new Error('no Docker step in deploy/install.sh');
    const bin = path.join(scratch, 'bin');
    if (dockerOnPath) {
      fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\n', {
        mode: 0o755,
      });
    }
    return spawnSync(
      '/bin/bash',
      [
        '-c',
        `set -euo pipefail; log() { :; }; DOCKER_VERSION=${installDefault('DOCKER_VERSION')}\n${step[0]}`,
      ],
      { env: { PATH: bin }, encoding: 'utf8' },
    );
  }

  const called = () =>
    fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';

  it('installs Docker with get.docker.com at the Server setup’s version', () => {
    const ran = dockerStep(false);

    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(called().split('\n')).toEqual([
      'curl https://get.docker.com',
      `get.docker.com --version ${DOCKER_VERSION}`,
      'systemctl enable --now docker',
      '',
    ]);
  });

  it('leaves a Docker already on the host as it is', () => {
    const ran = dockerStep(true);

    expect(ran.status).toBe(0);
    expect(called()).toBe('systemctl enable --now docker\n');
  });
});
