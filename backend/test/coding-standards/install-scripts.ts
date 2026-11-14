import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const repoRoot = path.resolve(__dirname, '../../..');

/**
 * Every tracked shell script that is part of installing or upgrading
 * Cloudgate: the one-command install at the root and each script in
 * `deploy/` itself, read from git so that a script added there is counted
 * without anyone listing it. `deploy/builder-image/` is the builder image's,
 * run inside a build container, never on the platform host.
 */
export function installScripts(): string[] {
  return execFileSync('git', ['ls-files', '--', 'install.sh', 'deploy/*.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file === 'install.sh' || /^deploy\/[^/]+\.sh$/.test(file))
    .sort();
}

/** `file`'s lines, with each comment line blanked so line numbers hold. */
export function code(file: string): string {
  return fs
    .readFileSync(path.join(repoRoot, file), 'utf8')
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}
