import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) =>
  readFileSync(join(__dirname, '..', '..', '..', path), 'utf8');

/** An assignment from install.sh, with any `${X:-default}` unwrapped. */
function assigned(script: string, name: string): string {
  const line = script
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (line === undefined) throw new Error(`install.sh assigns no ${name}`);
  const value = line.slice(name.length + 1).replace(/^"|"$/g, '');
  const fallback = /^\$\{\w+:-(.*)\}$/.exec(value);
  return fallback ? fallback[1] : value;
}

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
};

/**
 * The tunnel a Stack VM on AWS is reached through (ADR-0070): the platform
 * host's install carries the Session Manager plugin at one pinned, checked
 * version, where the backend is told to find it.
 */
describe('deploy/install.sh', () => {
  const installer = read('deploy/install.sh');

  it("pins the Session Manager plugin to a version and the sha256 of AWS's download, checked before it is installed", () => {
    expect(assigned(installer, 'SESSION_MANAGER_PLUGIN_VERSION')).toMatch(
      /^\d+\.\d+\.\d+\.\d+$/,
    );
    expect(assigned(installer, 'SESSION_MANAGER_PLUGIN_SHA256')).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(installer).toContain(
      'echo "${pin}  session-manager-plugin.deb" | sha256sum -c -',
    );
  });

  it("pins the arm64 Hosted instance's ubuntu_arm64 .deb beside the ubuntu_64bit one, each checked against its own sha256", () => {
    const arm64 = assigned(installer, 'SESSION_MANAGER_PLUGIN_ARM64_SHA256');
    expect(arm64).toMatch(/^[0-9a-f]{64}$/);
    expect(arm64).not.toBe(
      assigned(installer, 'SESSION_MANAGER_PLUGIN_SHA256'),
    );
    expect(installer).toContain(
      'amd64) build=ubuntu_64bit pin="$SESSION_MANAGER_PLUGIN_SHA256" ;;',
    );
    expect(installer).toContain(
      'arm64) build=ubuntu_arm64 pin="$SESSION_MANAGER_PLUGIN_ARM64_SHA256" ;;',
    );
    expect(installer).toContain(
      '/plugin/${SESSION_MANAGER_PLUGIN_VERSION}/${build}/session-manager-plugin.deb',
    );
  });

  it("pins a Session Manager plugin new enough to read the session's token from its environment", () => {
    expect(
      newer(assigned(installer, 'SESSION_MANAGER_PLUGIN_VERSION'), '1.2.536.0'),
    ).toBe(true);
  });

  it('installs the Session Manager plugin where the backend is told to run it', () => {
    const path = assigned(installer, 'SESSION_MANAGER_PLUGIN');
    expect(path).toMatch(/^\/usr\/local\/share\/cloudgate\//);
    expect(installer).toContain(
      'SESSION_MANAGER_PLUGIN=${SESSION_MANAGER_PLUGIN}',
    );
    expect(read('deploy/env/cloudgate-backend.example')).toContain(
      `SESSION_MANAGER_PLUGIN=${path}`,
    );
  });
});
