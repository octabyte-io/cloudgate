import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { replaceOwnerOnlyFileCommand } from '../../src/common/files/owner-only';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import {
  gatewayRouteConfigPath,
  legacyGatewayRouteConfigPath,
  removeGatewayRouteStep,
  writeGatewayRoute,
} from '../../src/gateway/gateway-route';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { dynamicTraefikDirectory } from '../../src/traefik/traefik-writer.service';

/**
 * Where an AI model's gateway-only router lands: at the top of
 * `dynamic/`, the one level `traefik:v3.6.7`'s file provider watches, so the
 * write is itself what reloads Traefik. A file in `dynamic/ai-gateway/` was
 * loaded only when something else raised a reload, and a Server an earlier
 * version deployed to still has one, which a deploy or a Delete removes.
 */

const FACET = { runtime: 'ollama', upstreamSecret: 'the-upstream-secret' };

/** The one query `writeGatewayRoute` makes, answering with {@link FACET}. */
const dbWithFacet = (): DrizzleDB => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([FACET]),
  };
  return { select: () => chain } as unknown as DrizzleDB;
};

const remoteExecSpy = () => {
  const execAsyncRemote = jest.fn(() =>
    Promise.resolve({ stdout: '', stderr: '' }),
  );
  const execRemote = jest.fn(() => Promise.resolve({ stdout: '', stderr: '' }));
  return {
    execAsyncRemote,
    execRemote,
    remoteExec: {
      execAsyncRemote,
      execRemote,
    } as unknown as RemoteExecService,
  };
};

const TARGET = { applicationId: 'app-1', appName: 'llm' };

describe('gatewayRouteConfigPath', () => {
  it('is a file at the top of the watched dynamic directory, named outside APP_NAME_REGEX', () => {
    const file = gatewayRouteConfigPath('llm', 'server-1');

    expect(file).toBe('/etc/cloudgate/traefik/dynamic/ai-gateway+llm.yml');
    expect(dirname(file)).toBe(dynamicTraefikDirectory('server-1'));
  });

  it('is not where an earlier version wrote it, in dynamic/ai-gateway/', () => {
    expect(legacyGatewayRouteConfigPath('llm', 'server-1')).toBe(
      '/etc/cloudgate/traefik/dynamic/ai-gateway/llm.yml',
    );
  });
});

describe('writeGatewayRoute on a Server', () => {
  it('removes the legacy file and its emptied directory before the new file is renamed into place', async () => {
    const { remoteExec, execAsyncRemote } = remoteExecSpy();

    await writeGatewayRoute(dbWithFacet(), remoteExec, {
      ...TARGET,
      serverId: 'server-1',
    });

    const [[serverId, command]] = execAsyncRemote.mock.calls as unknown as [
      [string, string],
    ];
    expect(serverId).toBe('server-1');
    const removed = command.indexOf(
      'rm -f /etc/cloudgate/traefik/dynamic/ai-gateway/llm.yml',
    );
    const rmdir = command.indexOf(
      'rmdir /etc/cloudgate/traefik/dynamic/ai-gateway 2>/dev/null || true',
    );
    const renamed = command.indexOf(
      'mv -f "$tmp" /etc/cloudgate/traefik/dynamic/ai-gateway+llm.yml',
    );
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(rmdir).toBeGreaterThan(removed);
    expect(renamed).toBeGreaterThan(rmdir);
    expect(command).not.toContain(FACET.upstreamSecret);
  });
});

describe('writeGatewayRoute on this host', () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cg983-'));
    previous = process.env.CLOUDGATE_DIRECTORY;
    process.env.CLOUDGATE_DIRECTORY = root;
    mkdirSync(dynamicTraefikDirectory(null), { recursive: true, mode: 0o755 });
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const write = () =>
    writeGatewayRoute(dbWithFacet(), remoteExecSpy().remoteExec, {
      ...TARGET,
      serverId: null,
    });

  it('writes the router 0600 at the top of dynamic/, which keeps its own mode, and leaves no temporary file', async () => {
    await write();

    const file = gatewayRouteConfigPath('llm', null);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(FACET.upstreamSecret);
    expect(statSync(dynamicTraefikDirectory(null)).mode & 0o777).toBe(0o755);
    expect(readdirSync(dynamicTraefikDirectory(null))).toEqual([
      'ai-gateway+llm.yml',
    ]);
  });

  it("moves an earlier version's file out of dynamic/ai-gateway/, and the directory once empty", async () => {
    const legacy = legacyGatewayRouteConfigPath('llm', null);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, 'old');

    await write();

    expect(existsSync(dirname(legacy))).toBe(false);
    expect(existsSync(gatewayRouteConfigPath('llm', null))).toBe(true);
  });

  it("leaves dynamic/ai-gateway/ in place while it still holds another AI model's file", async () => {
    const other = legacyGatewayRouteConfigPath('other', null);
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, 'other');

    await write();

    expect(readFileSync(other, 'utf8')).toBe('other');
  });

  it('a Delete removes the router and an earlier version’s file both', async () => {
    const legacy = legacyGatewayRouteConfigPath('llm', null);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, 'old');
    await write();

    await removeGatewayRouteStep(remoteExecSpy().remoteExec, null, 'llm').run();

    expect(existsSync(gatewayRouteConfigPath('llm', null))).toBe(false);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe('removeGatewayRouteStep on a Server', () => {
  it('removes both paths in one rm and reports the current one', async () => {
    const { remoteExec, execRemote } = remoteExecSpy();
    const step = removeGatewayRouteStep(remoteExec, 'server-1', 'llm');

    await step.run();

    expect(execRemote).toHaveBeenCalledWith('server-1', [
      'rm',
      '-f',
      '/etc/cloudgate/traefik/dynamic/ai-gateway+llm.yml',
      '/etc/cloudgate/traefik/dynamic/ai-gateway/llm.yml',
    ]);
    expect(step.leftBehindOnFailure).toMatchObject({
      path: '/etc/cloudgate/traefik/dynamic/ai-gateway+llm.yml',
    });
  });
});

describe('replaceOwnerOnlyFileCommand, run by a real shell', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cg983-sh-'));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('replaces a file an earlier write left 0644 with the new content at 0600, and no sibling', () => {
    const file = join(directory, 'ai-gateway+llm.yml');
    writeFileSync(file, 'old', { mode: 0o644 });

    execFileSync('sh', ['-c', replaceOwnerOnlyFileCommand(file, 'new: 1\n')]);

    expect(readFileSync(file, 'utf8')).toBe('new: 1\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['ai-gateway+llm.yml']);
  });
});
