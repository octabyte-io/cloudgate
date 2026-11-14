import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every apt-get the install scripts run goes through their `apt_get`, which
 * waits out the lock cloud-init and unattended-upgrades hold on a VPS's first
 * boot. A bare `apt-get` there fails the install with "Could not get lock".
 *
 * The sites are every line of each script that runs `apt-get` (comments
 * left out); each must be inside that script's own `apt_get`, and each
 * script that declares `apt_get` must still call it.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const SCRIPTS = ['install.sh', 'deploy/install.sh'];

function code(file: string): string {
  return fs
    .readFileSync(path.join(repoRoot, file), 'utf8')
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}

describe('deploy/install.sh and install.sh, on every apt-get going through apt_get', () => {
  it.each(SCRIPTS)('is the only way %s runs apt-get', (file) => {
    const lines = code(file);
    const fn = lines.match(/^apt_get\(\) \{\n[\s\S]*?\n\}\n/m);
    expect({ file, declared: !!fn }).toEqual({ file, declared: true });

    const outside = lines
      .replace(fn?.[0] ?? '', '')
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => /(^|[\s;|&(])apt-get\s/.test(text));
    expect(outside).toEqual([]);
  });

  it.each(SCRIPTS)('is called by %s', (file) => {
    const lines = code(file);
    const fn = lines.match(/^apt_get\(\) \{\n[\s\S]*?\n\}\n/m)?.[0] ?? '';
    expect(lines.replace(fn, '')).toMatch(/(^|\s)apt_get (update|install)/m);
  });
});
