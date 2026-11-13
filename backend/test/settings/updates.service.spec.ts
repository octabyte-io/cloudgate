import { UpdatesService } from '../../src/settings/updates.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * The update notice compares the running version with the latest Cloudgate
 * version on this repository's GitHub Releases (ADR-0082). GitHub's answer is
 * stubbed at `FETCH_CLIENT`.
 *
 * Two things this has to keep apart. The CLI is released from the same
 * repository as `cli-vX.Y.Z`, and none of those is a Cloudgate version. And a
 * check that did not complete is an error, never "up to date": the Docker Hub
 * check this replaced answered a missing repository with the same bytes as
 * "nothing newer", so every native install was told it was current.
 */
describe('UpdatesService.getUpdateData', () => {
  const remoteExec = {
    execAsync: jest.fn(),
    execFileAsync: jest.fn(),
  } as unknown as RemoteExecService;

  const githubResponse = (status: number, body: unknown): Promise<Response> =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response);

  /** A release as `GET /repos/{owner}/{repo}/releases` lists it. */
  const release = (tag_name: string) => ({
    tag_name,
    name: tag_name,
    draft: false,
    prerelease: false,
  });

  const releases = (...tags: string[]) =>
    jest.fn(() => githubResponse(200, tags.map(release)));

  const service = (fetchClient: jest.Mock) =>
    new UpdatesService(fetchClient, remoteExec);

  const UPGRADE_TO_040 =
    'curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo CLOUDGATE_VERSION=v0.4.0 sh';

  beforeEach(() => jest.clearAllMocks());

  it("asks GitHub for this repository's releases", async () => {
    const fetchClient = releases();

    await service(fetchClient).getUpdateData('0.3.0');

    expect(fetchClient).toHaveBeenCalledWith(
      'https://api.github.com/repos/octabyte-io/cloudgate/releases?per_page=100',
      expect.anything(),
    );
  });

  it('reports a newer Cloudgate version with the command that upgrades to it', async () => {
    const fetchClient = releases('v0.4.0', 'v0.3.0');

    const data = await service(fetchClient).getUpdateData('0.3.0');

    expect(data).toEqual({
      latestVersion: 'v0.4.0',
      updateAvailable: true,
      upgradeCommand: UPGRADE_TO_040,
      error: null,
    });
  });

  it('reports the running version as the latest, with no upgrade command', async () => {
    const fetchClient = releases('v0.3.0', 'v0.2.0');

    const data = await service(fetchClient).getUpdateData('0.3.0');

    expect(data).toEqual({
      latestVersion: 'v0.3.0',
      updateAvailable: false,
      upgradeCommand: null,
      error: null,
    });
  });

  it('answers a repository with no releases as a completed check with nothing to compare', async () => {
    const fetchClient = releases();

    const data = await service(fetchClient).getUpdateData('0.3.0');

    expect(data).toEqual({
      latestVersion: null,
      updateAvailable: false,
      upgradeCommand: null,
      error: null,
    });
  });

  it('picks the highest Cloudgate version whatever order GitHub lists them in', async () => {
    const fetchClient = releases('v0.3.0', 'v0.4.0', 'v0.3.1');

    const data = await service(fetchClient).getUpdateData('0.3.0');

    expect(data.latestVersion).toBe('v0.4.0');
    expect(data.upgradeCommand).toBe(UPGRADE_TO_040);
  });

  it('never counts a cli-v release as a Cloudgate version', async () => {
    const fetchClient = releases('cli-v9.0.0', 'v0.3.0', 'cli-v1.2.0');

    const data = await service(fetchClient).getUpdateData('0.3.0');

    expect(data).toEqual({
      latestVersion: 'v0.3.0',
      updateAvailable: false,
      upgradeCommand: null,
      error: null,
    });
  });

  it('answers a repository with only cli-v releases as having no Cloudgate version', async () => {
    const fetchClient = releases('cli-v0.2.0', 'cli-v0.1.0');

    const data = await service(fetchClient).getUpdateData('0.3.0');

    expect(data).toEqual({
      latestVersion: null,
      updateAvailable: false,
      upgradeCommand: null,
      error: null,
    });
  });

  it('reports an unreachable GitHub as an error rather than "up to date"', async () => {
    const fetchClient = jest.fn(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')),
    );

    const data = await service(fetchClient).getUpdateData('0.3.0');

    expect(data.updateAvailable).toBe(false);
    expect(data.latestVersion).toBeNull();
    expect(data.upgradeCommand).toBeNull();
    expect(data.error).toContain('api.github.com');
    expect(data.error).toContain('ENOTFOUND');
  });

  it('reports a failing GitHub API as an error rather than "up to date"', async () => {
    const fetchClient = jest.fn(() =>
      githubResponse(403, { message: 'API rate limit exceeded' }),
    );

    const data = await service(fetchClient).getUpdateData('0.3.0');

    expect(data.updateAvailable).toBe(false);
    expect(data.latestVersion).toBeNull();
    expect(data.upgradeCommand).toBeNull();
    expect(data.error).toContain('403');
  });

  it('reports a body that is not a list of releases as an error rather than "up to date"', async () => {
    const fetchClient = jest.fn(() =>
      githubResponse(200, { message: 'Not Found' }),
    );

    const data = await service(fetchClient).getUpdateData('0.3.0');

    expect(data.updateAvailable).toBe(false);
    expect(data.error).toEqual(expect.any(String));
  });

  it('never asks Docker Hub', async () => {
    const fetchClient = releases('v0.4.0');

    await service(fetchClient).getUpdateData('0.3.0');

    for (const [url] of fetchClient.mock.calls as unknown as [string][]) {
      expect(url).not.toContain('hub.docker.com');
    }
  });
});

describe('UpdatesService.updateServer', () => {
  const execFileAsync = jest.fn();
  const remoteExec = {
    execAsync: jest.fn(),
    execFileAsync,
  } as unknown as RemoteExecService;

  beforeEach(() => jest.clearAllMocks());

  it('refuses to run when the check itself failed', async () => {
    const fetchClient = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ message: 'unavailable' }),
      } as unknown as Response),
    );
    const service = new UpdatesService(fetchClient, remoteExec);

    await expect(service.updateServer('0.3.0')).rejects.toThrow(/503/);
    expect(execFileAsync).not.toHaveBeenCalled();
  });
});
