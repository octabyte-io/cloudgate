import { EventEmitter } from 'node:events';
import { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import { unverifiedHostKey } from '../../src/remote/host-key';

/**
 * The SSH branch of the terminal window.
 *
 * ssh2 is the boundary here and it is mocked, deliberately and only here: what
 * these tests pin is the request Cloudgate makes of it — the pty size a channel
 * is *opened* with, and the `setWindow` a later resize turns into. The pty branch
 * of the same behaviour is proven end to end against a real terminal in
 * `pty-spawn-helper.spec.ts`; there is no equivalent for SSH without a server to
 * dial, so the contract with the library is what is checked.
 */

/** The ClientChannel ssh2 hands the caller: a duplex stream with a window. */
class FakeStream extends EventEmitter {
  readonly stderr = new EventEmitter();
  write = jest.fn();
  end = jest.fn();
  setWindow = jest.fn();
}

/** ssh2's Client, as much of it as SshChannelService touches. */
class FakeClient extends EventEmitter {
  static last: FakeClient | undefined;
  readonly stream = new FakeStream();
  shell = jest.fn(
    (_window: unknown, cb: (err: undefined, s: FakeStream) => void) =>
      cb(undefined, this.stream),
  );
  exec = jest.fn(
    (
      _command: string,
      _options: unknown,
      cb: (err: undefined, s: FakeStream) => void,
    ) => cb(undefined, this.stream),
  );
  end = jest.fn();
  connect = jest.fn(() => {
    // ssh2 dials asynchronously; 'ready' is what runs the caller's wire-up.
    setImmediate(() => this.emit('ready'));
    return this;
  });

  constructor() {
    super();
    FakeClient.last = this;
  }
}

// The name has to start with "mock" for jest's hoisted factory to be allowed to
// reach it; the class itself is only constructed once a test dials.
const mockNewClient = () => new FakeClient();
jest.mock('ssh2', () => ({ Client: jest.fn(() => mockNewClient()) }));

const connection = {
  host: '203.0.113.10',
  port: 22,
  username: 'root',
  privateKey: 'PRIVATE_KEY',
  hostKey: unverifiedHostKey(),
};

const open = (options: Record<string, unknown>) =>
  new SshChannelService().open({ connection }, options);

describe('SshChannelService window', () => {
  beforeEach(() => {
    FakeClient.last = undefined;
  });

  it('opens an interactive shell at the size it was asked for', async () => {
    await open({ cols: 132, rows: 43 });

    expect(FakeClient.last?.shell).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 132, rows: 43 }),
      expect.any(Function),
    );
  });

  it('opens a shell at 80 x 24 when the caller names no size', async () => {
    // ssh2's own default, stated rather than inherited — the session's size is
    // never an accident of the library's.
    await open({});

    expect(FakeClient.last?.shell).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 80, rows: 24 }),
      expect.any(Function),
    );
  });

  it('carries the size in the pty a command execs into', async () => {
    await open({
      command: 'docker exec -it -w / web-app sh',
      pty: true,
      cols: 120,
      rows: 40,
    });

    expect(FakeClient.last?.exec).toHaveBeenCalledWith(
      'docker exec -it -w / web-app sh',
      { pty: { cols: 120, rows: 40 } },
      expect.any(Function),
    );
  });

  it('leaves a command without a pty alone', async () => {
    await open({ command: 'tail -f /var/log/syslog' });

    expect(FakeClient.last?.exec).toHaveBeenCalledWith(
      'tail -f /var/log/syslog',
      { pty: false },
      expect.any(Function),
    );
  });

  it('resizes the open channel, rows first, the way ssh2 counts them', async () => {
    const channel = await open({ cols: 80, rows: 24 });

    channel.resize?.(120, 40);

    // setWindow(rows, cols, height, width) — the pixel dimensions are unknown to
    // a browser grid and 0 is ssh2's "no information".
    expect(FakeClient.last?.stream.setWindow).toHaveBeenCalledWith(
      40,
      120,
      0,
      0,
    );
  });
});

/**
 * A command that answers at once (a stopped container's last lines, an
 * in-process SSH server) can send its output and its close in the same
 * read as the channel's opening, before the caller's `await` has resumed
 * to listen. Those were emitted to no one: the socket showed nothing and
 * never ended (found by `compose-stack-vm.e2e-spec.ts`'s log follower).
 */
describe('SshChannelService, output before anyone listens', () => {
  it('hands output, stderr and the close to listeners added after they came, in order', async () => {
    const client = new FakeClient();
    client.exec.mockImplementation(
      (
        _command: string,
        _options: unknown,
        cb: (err: undefined, s: FakeStream) => void,
      ) => {
        cb(undefined, client.stream);
        client.stream.emit('data', Buffer.from('first\n'));
        client.stream.stderr.emit('data', Buffer.from('warned\n'));
        client.stream.emit('data', Buffer.from('second\n'));
        client.stream.emit('close', 0);
      },
    );
    const { Client } = jest.requireMock<{ Client: jest.Mock }>('ssh2');
    Client.mockImplementationOnce(() => client);

    const channel = await open({ command: 'docker logs c1' });
    const heard: string[] = [];
    channel.onData((data) => heard.push(`data:${data}`));
    channel.onStderr((data) => heard.push(`stderr:${data}`));
    channel.onClose((code) => heard.push(`close:${String(code)}`));

    expect(heard).toEqual([
      'data:first\n',
      'data:second\n',
      'stderr:warned\n',
      'close:0',
    ]);
  });

  it('hands later output straight to the listener', async () => {
    const channel = await open({ command: 'docker logs c1' });
    const heard: string[] = [];
    channel.onData((data) => heard.push(data));

    FakeClient.last?.stream.emit('data', Buffer.from('live\n'));

    expect(heard).toEqual(['live\n']);
  });
});
