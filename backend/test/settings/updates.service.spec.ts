import { UpdatesService } from '../../src/settings/updates.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * The update check used to answer "nothing newer" whatever happened.
 *
 * Docker Hub's 404 body carries no `results`, so `allResults.concat(undefined)`
 * seeded the array with `undefined`, `data?.next` ended the loop, and
 * `.find(t => t.name === 'latest')` threw on that element — straight into a
 * `catch` that returned DEFAULT_UPDATE_DATA. "This repository does not exist"
 * and "you are up to date" were the same answer, and the console showed the
 * second one on a live native install.
 */
describe('UpdatesService.getUpdateData', () => {
  const remoteExec = {
    execAsync: jest.fn(),
    execFileAsync: jest.fn(),
  } as unknown as RemoteExecService;

  const hubResponse = (status: number, body: unknown): Promise<Response> =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response);

  const service = (fetchClient: jest.Mock) =>
    new UpdatesService(fetchClient, remoteExec);

  beforeEach(() => jest.clearAllMocks());

  it('reports a missing repository rather than "up to date"', async () => {
    const fetchClient = jest.fn(() =>
      hubResponse(404, { message: 'object not found', errinfo: {} }),
    );

    const data = await service(fetchClient).getUpdateData('0.0.1');

    expect(data.updateAvailable).toBe(false);
    expect(data.latestVersion).toBeNull();
    expect(data.error).toEqual(expect.any(String));
    expect(data.error).toContain('404');
    expect(data.error).toContain('cloudgate/cloudgate');
  });

  it('reports an unreachable Docker Hub rather than "up to date"', async () => {
    const fetchClient = jest.fn(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND hub.docker.com')),
    );

    const data = await service(fetchClient).getUpdateData('0.0.1');

    expect(data.updateAvailable).toBe(false);
    expect(data.error).toContain('hub.docker.com');
    expect(data.error).toContain('ENOTFOUND');
  });

  it('reports a body with no tag list rather than "up to date"', async () => {
    const fetchClient = jest.fn(() => hubResponse(200, { next: null }));

    const data = await service(fetchClient).getUpdateData('0.0.1');

    expect(data.updateAvailable).toBe(false);
    expect(data.error).toEqual(expect.any(String));
  });

  it('answers with error null when the check completes and nothing is newer', async () => {
    const fetchClient = jest.fn(() =>
      hubResponse(200, {
        next: null,
        results: [
          { digest: 'sha256:aaa', name: 'latest' },
          { digest: 'sha256:aaa', name: 'v0.0.1' },
        ],
      }),
    );

    const data = await service(fetchClient).getUpdateData('0.0.1');

    expect(data).toEqual({
      latestVersion: 'v0.0.1',
      updateAvailable: false,
      error: null,
    });
  });

  it('answers with error null when something newer is published', async () => {
    const fetchClient = jest.fn(() =>
      hubResponse(200, {
        next: null,
        results: [
          { digest: 'sha256:aaa', name: 'latest' },
          { digest: 'sha256:aaa', name: 'v9.0.0' },
        ],
      }),
    );

    const data = await service(fetchClient).getUpdateData('0.0.1');

    expect(data).toEqual({
      latestVersion: 'v9.0.0',
      updateAvailable: true,
      error: null,
    });
  });

  it('completing with nothing to compare is not an error', async () => {
    const fetchClient = jest.fn(() =>
      hubResponse(200, { next: null, results: [] }),
    );

    const data = await service(fetchClient).getUpdateData('0.0.1');

    expect(data).toEqual({
      latestVersion: null,
      updateAvailable: false,
      error: null,
    });
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
        status: 404,
        json: () => Promise.resolve({ message: 'object not found' }),
      } as unknown as Response),
    );
    const service = new UpdatesService(fetchClient, remoteExec);

    await expect(service.updateServer('0.0.1')).rejects.toThrow(/404/);
    expect(execFileAsync).not.toHaveBeenCalled();
  });
});
