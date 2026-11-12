import type Docker from 'dockerode';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type {
  ServerConnection,
  ServerKeyProvider,
} from '../../src/remote/server-key.provider';
import { unverifiedHostKey } from '../../src/remote/host-key';

// The docker daemon is a system boundary — dockerode is mocked. The mock
// records constructor options so tests can assert how the SSH client is built.
const dockerodeCtorArgs: Record<string, unknown>[] = [];
jest.mock('dockerode', () =>
  jest.fn().mockImplementation((options: Record<string, unknown>) => {
    dockerodeCtorArgs.push(options);
    return { __mockRemoteDocker: true, options };
  }),
);

const CONNECTION: ServerConnection = {
  host: '203.0.113.10',
  port: 2222,
  username: 'deploy',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n',
  hostKey: unverifiedHostKey(),
};

const getConnection = jest.fn<Promise<ServerConnection>, [string]>();
const keyProvider: ServerKeyProvider = { getConnection };
const localDocker = { __localDocker: true } as unknown as Docker;

describe('RemoteDockerFactory.getRemoteDocker', () => {
  let factory: RemoteDockerFactory;

  beforeEach(() => {
    jest.clearAllMocks();
    dockerodeCtorArgs.length = 0;
    getConnection.mockResolvedValue(CONNECTION);
    factory = new RemoteDockerFactory(localDocker, keyProvider);
  });

  it('returns the local client when no serverId is given', async () => {
    await expect(factory.getRemoteDocker()).resolves.toBe(localDocker);
    await expect(factory.getRemoteDocker(null)).resolves.toBe(localDocker);
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('builds a dockerode-over-SSH client from the resolved server connection', async () => {
    const remote = await factory.getRemoteDocker('server-1');

    expect(getConnection).toHaveBeenCalledWith('server-1');
    expect(remote).not.toBe(localDocker);
    expect(dockerodeCtorArgs).toHaveLength(1);
    expect(dockerodeCtorArgs[0]).toMatchObject({
      protocol: 'ssh',
      host: CONNECTION.host,
      port: CONNECTION.port,
      username: CONNECTION.username,
      sshOptions: {
        privateKey: CONNECTION.privateKey,
        hostVerifier: CONNECTION.hostKey.verifier,
      },
    });
  });
});
