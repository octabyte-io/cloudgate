import { PassThrough } from 'node:stream';

import { isConnectionFailure } from '../../src/remote/exec-error';
import type { ServerKeyProvider } from '../../src/remote/server-key.provider';
import {
  stackOfRemoteId,
  stackVmRemoteId,
  withStackVms,
} from '../../src/remote/stack-vm-remote';
import type { StackVmConnector } from '../../src/remote/stack-vm-remote';

/**
 * The one place the remote-execution layer turns an id into an SSH
 * connection: a Server's id goes to the Servers' own provider, a Stack VM's
 * only to its tunnel (ADR-0070), so no SSH client can dial a Stack VM by
 * address.
 */
describe('withStackVms', () => {
  const serverConnection = {
    host: '203.0.113.7',
    port: 22,
    username: 'root',
    privateKey: 'server-key',
  };
  const getConnection = jest.fn().mockResolvedValue(serverConnection);
  const servers: ServerKeyProvider = { getConnection };
  const sock = new PassThrough();
  const connect = jest.fn();
  const stackVms: StackVmConnector = { connect };
  connect.mockResolvedValue({
    host: 'i-0abc',
    port: 22,
    username: 'root',
    privateKey: 'stack-key',
    sock,
  });

  beforeEach(() => jest.clearAllMocks());

  it("answers a Server's id with the Server's own connection", async () => {
    const connection = await withStackVms(servers, stackVms).getConnection(
      'server-1',
    );

    expect(connection).toBe(serverConnection);
    expect(connect).not.toHaveBeenCalled();
  });

  it("answers a Stack VM's id with a connection over its tunnel, never asking the Servers", async () => {
    const connection = await withStackVms(servers, stackVms).getConnection(
      stackVmRemoteId('stack-1'),
    );

    expect(connect).toHaveBeenCalledWith('stack-1');
    expect(connection.sock).toBe(sock);
    expect(getConnection).not.toHaveBeenCalled();
  });

  it("refuses a Stack VM's id when there is no tunnel, rather than dialling it", async () => {
    await expect(
      withStackVms(servers, null).getConnection(stackVmRemoteId('stack-1')),
    ).rejects.toThrow('cannot be reached');
    expect(getConnection).not.toHaveBeenCalled();
  });

  it("tells a Stack VM's id from a Server's", () => {
    expect(stackOfRemoteId(stackVmRemoteId('abc_-1'))).toBe('abc_-1');
    expect(stackOfRemoteId('V1StGXR8_Z5jdHi6B-myT')).toBeNull();
    expect(stackOfRemoteId(null)).toBeNull();
  });
});

describe('withStackVms, when a tunnel will not open', () => {
  it('fails as an SSH connection that will not open, so a Delete dials it once', async () => {
    const stackVms = {
      connect: jest.fn().mockRejectedValue(new Error('TargetNotConnected')),
    };
    const servers = { getConnection: jest.fn() };

    const failing = withStackVms(servers, stackVms).getConnection(
      stackVmRemoteId('stack-1'),
    );

    await expect(failing).rejects.toThrow(
      'Could not reach the Stack VM: TargetNotConnected',
    );
    expect(isConnectionFailure(await failing.catch((e: unknown) => e))).toBe(
      true,
    );
  });
});
