import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOCKER_VERSION } from '../../src/servers/server-setup';

/**
 * The platform host gets the Docker a Server does: `deploy/install.sh` and the
 * Server setup both run `get.docker.com` with `--version`. The version is
 * written down three times: `DOCKER_VERSION` in `deploy/install.sh`,
 * `DOCKER_VERSION` in `backend/src/servers/server-setup.ts`, and the console's
 * "Install Docker <version>" step in
 * `frontend/src/features/server/infrastructure/setup-steps.ts`. These tests
 * keep the three one pin, so a fresh platform host runs the Docker version its
 * Servers get, and the console names the version setup installs.
 *
 * What the Docker step does with the pin is driven in
 * `test/deploy/one-command-install.spec.ts`, beside the other steps of
 * `deploy/install.sh`.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const read = (file: string) =>
  fs.readFileSync(path.join(repoRoot, file), 'utf8');

/** An assignment from install.sh, with any `${X:-default}` unwrapped. */
function installDefault(name: string): string {
  const line = read('deploy/install.sh').match(
    new RegExp(`^${name}=(.*)$`, 'm'),
  )?.[1];
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

  it('the console’s setup steps name the Docker version the Server setup installs', () => {
    const titles = [
      ...read(
        'frontend/src/features/server/infrastructure/setup-steps.ts',
      ).matchAll(/title: "Install Docker (.*)"/g),
    ].map((title) => title[1]);

    expect(titles).toEqual([DOCKER_VERSION]);
  });
});
