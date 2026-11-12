import type Docker from 'dockerode';
import {
  containerExists,
  getContainerByName,
} from '../../src/docker/docker.utils';

// The docker daemon is a system boundary — the client is stubbed.
const inspect = jest.fn<Promise<unknown>, []>();
const listContainers = jest.fn<Promise<unknown[]>, [unknown]>();
const client = {
  getContainer: jest.fn(() => ({ inspect })),
  listContainers,
} as unknown as Docker;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('containerExists', () => {
  it('is true when inspect succeeds and false when it rejects', async () => {
    inspect.mockResolvedValueOnce({ Id: 'abc' });
    await expect(containerExists(client, 'traefik')).resolves.toBe(true);

    inspect.mockRejectedValueOnce(new Error('no such container'));
    await expect(containerExists(client, 'missing')).resolves.toBe(false);
  });
});

describe('getContainerByName', () => {
  it('returns the first container matching the name filter', async () => {
    const info = { Id: 'abc', Names: ['/my-app'] };
    listContainers.mockResolvedValueOnce([info]);

    await expect(getContainerByName(client, 'my-app')).resolves.toBe(info);
    expect(listContainers).toHaveBeenCalledWith({
      limit: 1,
      filters: { name: ['my-app'] },
    });
  });

  it('throws a clear error when no container matches', async () => {
    listContainers.mockResolvedValueOnce([]);

    await expect(getContainerByName(client, 'ghost')).rejects.toThrow(
      /no container found.*ghost/i,
    );
  });
});
