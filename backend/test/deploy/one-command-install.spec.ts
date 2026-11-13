import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The repository's root `install.sh`, the one-command Self-hosted install,
 * driven as far as a test can take it off a real box.
 *
 * It is piped to `sh`, which is dash on Ubuntu, so it is run here under `sh`
 * and never bash. Every command that would change the host (`git`, `apt-get`,
 * `curl`) is shimmed to record that it was called and nothing more, so a run
 * that got further than it should leaves a line in `calls` instead of touching
 * this machine.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const installer = path.join(repoRoot, 'install.sh');

let scratch: string;
let calls: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'one-command-install-'));
  calls = path.join(scratch, 'calls');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['git', 'apt-get', 'curl']) {
    fs.writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n`,
      { mode: 0o755 },
    );
  }
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Runs `script` under sh with `id -u` answering `uid`. */
function run(script: string, uid: number) {
  const bin = path.join(scratch, 'bin');
  fs.writeFileSync(path.join(bin, 'id'), `#!/bin/sh\necho ${uid}\n`, {
    mode: 0o755,
  });
  return spawnSync('sh', [script], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: scratch },
    encoding: 'utf8',
  });
}

function called(): string {
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
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

  it('clones over HTTPS, never the SSH address a private repository needed', () => {
    const source = fs.readFileSync(installer, 'utf8');

    expect(source).toContain('https://github.com/octabyte-io/cloudgate.git');
    expect(source).not.toContain('git@github.com:');
  });
});
