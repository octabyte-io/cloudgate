import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * GPU setup rewrites `/etc/docker/daemon.json` and restarts Docker,
 * which stops every Service on that machine for a moment. Cloudgate never
 * runs it by itself — not on upgrade, not on deploy — only because an
 * operator confirmed it on the GPU support card, through
 * `POST /settings/gpu-setup`. So the one caller of `setupGpuSupport` in `src/`
 * is that route's handler, and a second one is a change this spec asks to be
 * argued for.
 */
const SRC = resolve(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('GpuService.setupGpuSupport', () => {
  it('runs GPU setup only from the route an operator calls', () => {
    const callers = sourceFiles(SRC)
      .filter((file) => /\.setupGpuSupport\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));

    expect(callers).toEqual(['settings/settings.controller.ts']);
  });
});
