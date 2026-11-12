import { createServer, request as httpRequest } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Server as TcpServer } from 'node:net';
import { SshForwardService } from '../../src/remote/ssh-forward.service';
import type { ServerConnection } from '../../src/remote/server-key.provider';
import { startSshForwardServer } from '../utils/ssh-forward-server';
import type { SshForwardServer } from '../utils/ssh-forward-server';

jest.setTimeout(30_000);

/**
 * The SSH `forwardOut` channel (ADR-0028): the one way the backend opens
 * a stream to a port on a remote Server. Driven against a real SSH server in
 * this process (`test/utils/ssh-forward-server.ts`), which dials the requested
 * port here the way sshd dials it on its own machine — so what is asserted is
 * what a real `direct-tcpip` channel carries, not what a mock of ssh2 says.
 */
describe('SshForwardService', () => {
  let sshd: SshForwardServer;
  let echo: TcpServer;
  let echoPort: number;
  let web: HttpServer;
  let webPort: number;
  /** A port nothing listens on. */
  let deadPort: number;

  let getConnection: jest.Mock<Promise<ServerConnection>, [string]>;
  let service: SshForwardService;

  beforeAll(async () => {
    echo = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    echoPort = (echo.address() as AddressInfo).port;

    web = createServer((req, res) => {
      if (req.url === '/silent') return; // never answers
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`);
      });
    });
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
    webPort = (web.address() as AddressInfo).port;

    const dead = createTcpServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    deadPort = (dead.address() as AddressInfo).port;
    await new Promise((resolve) => dead.close(resolve));
  });

  afterAll(async () => {
    web.closeAllConnections();
    await new Promise((resolve) => web.close(resolve));
    await new Promise((resolve) => echo.close(resolve));
  });

  beforeEach(async () => {
    sshd = await startSshForwardServer();
    getConnection = jest
      .fn<Promise<ServerConnection>, [string]>()
      .mockResolvedValue(sshd.connection);
    service = new SshForwardService({ getConnection });
    // Short, so a test can watch an unused connection end.
    service.idleCloseMs = 50;
  });

  afterEach(async () => {
    service.closeAll();
    await sshd.close();
  });

  /** Echoes `text` through a channel and answers what came back. */
  async function echoThrough(
    forwarded: { socket: NodeJS.ReadWriteStream },
    text: string,
  ): Promise<string> {
    const echoed = new Promise<string>((resolve) => {
      let heard = '';
      const onData = (chunk: Buffer) => {
        heard += chunk.toString();
        if (heard.length >= text.length) {
          forwarded.socket.removeListener('data', onData);
          resolve(heard);
        }
      };
      forwarded.socket.on('data', onData);
    });
    forwarded.socket.write(text);
    return echoed;
  }

  it('opens a channel to the port on the Server, carries bytes both ways, and ends the connection once it is idle', async () => {
    const forwarded = await service.open('server-1', {
      host: '127.0.0.1',
      port: echoPort,
    });

    expect(getConnection).toHaveBeenCalledWith('server-1');
    expect(sshd.forwards).toEqual([
      { destIP: '127.0.0.1', destPort: echoPort },
    ]);

    const echoed = new Promise<string>((resolve) => {
      let heard = '';
      forwarded.socket.on('data', (chunk: Buffer) => {
        heard += chunk.toString();
        if (heard.length >= 11) resolve(heard);
      });
    });
    forwarded.socket.write('hello there');
    await expect(echoed).resolves.toBe('hello there');

    forwarded.close();
    forwarded.close(); // twice is harmless
    await sshd.allClosed();
    expect(sshd.connections).toEqual([{ closed: true }]);
  });

  it('serves an HTTP request as the socket of `http.request`, idle timer included', async () => {
    const forwarded = await service.open('server-1', {
      host: '127.0.0.1',
      port: webPort,
    });
    const answer = await new Promise<{ status?: number; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            createConnection: forwarded.createConnection,
            method: 'POST',
            path: '/api/v3/services?x=1',
            timeout: 5_000,
          },
          (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk.toString()));
            res.on('end', () => resolve({ status: res.statusCode, body }));
          },
        );
        req.on('error', reject);
        req.end('{"a":1}');
      },
    );
    expect(answer).toEqual({
      status: 200,
      body: 'POST /api/v3/services?x=1 {"a":1}',
    });
    forwarded.close();
    await sshd.allClosed();
  });

  it('says so when the far side stays silent past the request timeout', async () => {
    const forwarded = await service.open('server-1', {
      host: '127.0.0.1',
      port: webPort,
    });
    const outcome = await new Promise<string>((resolve) => {
      const req = httpRequest({
        createConnection: forwarded.createConnection,
        path: '/silent',
        timeout: 200,
      });
      req.on('timeout', () => {
        req.destroy();
        resolve('timeout');
      });
      req.on('response', () => resolve('response'));
      req.on('error', () => undefined);
      req.end();
    });
    expect(outcome).toBe('timeout');
    forwarded.close();
    await sshd.allClosed();
  });

  it('ends the connection when the far end closes the channel', async () => {
    const forwarded = await service.open('server-1', {
      host: '127.0.0.1',
      port: webPort,
    });
    const ended = new Promise<void>((resolve) =>
      forwarded.socket.on('close', () => resolve()),
    );
    // HTTP/1.0 without keep-alive: the server closes after answering.
    forwarded.socket.write('GET / HTTP/1.0\r\n\r\n');
    forwarded.socket.resume();
    await ended;
    await sshd.allClosed();
  });

  it('refuses when the Server cannot be reached, and leaves nothing open', async () => {
    getConnection.mockResolvedValue({ ...sshd.connection, port: deadPort });

    await expect(
      service.open('server-1', { host: '127.0.0.1', port: echoPort }),
    ).rejects.toThrow(/SSH connection error/);
    expect(sshd.connections).toEqual([]);
  });

  it('refuses a key the Server does not accept, and closes the connection it made', async () => {
    getConnection.mockResolvedValue({
      ...sshd.connection,
      privateKey: sshd.wrongKey,
    });

    await expect(
      service.open('server-1', { host: '127.0.0.1', port: echoPort }),
    ).rejects.toThrow(/Authentication failed/);
    await sshd.allClosed();
    expect(sshd.connections).toHaveLength(1);
  });

  it('refuses a forward the Server will not open, and closes the connection it made', async () => {
    sshd.forwardAnswer = 'reject';

    await expect(
      service.open('server-1', { host: '127.0.0.1', port: echoPort }),
    ).rejects.toThrow(/refused the forward/);
    expect(sshd.forwards).toHaveLength(1);
    await sshd.allClosed();
    expect(sshd.connections).toEqual([{ closed: true }]);
  });

  it('refuses without a key provider and dials nothing', async () => {
    await expect(
      new SshForwardService().open('server-1', {
        host: '127.0.0.1',
        port: echoPort,
      }),
    ).rejects.toThrow(/ServerKeyProvider/);
    expect(sshd.connections).toEqual([]);
  });

  describe('the connection pool', () => {
    const target = () => ({ host: '127.0.0.1', port: echoPort });

    it('shares one handshake among many concurrent first requests, past sshd’s default MaxStartups of 10', async () => {
      const opened = await Promise.all(
        Array.from({ length: 15 }, () => service.open('server-1', target())),
      );

      expect(sshd.connections).toHaveLength(1);
      expect(sshd.forwards).toHaveLength(15);
      expect(getConnection).toHaveBeenCalledTimes(15);
      const echoed = await Promise.all(
        opened.map((forwarded, i) => echoThrough(forwarded, `request ${i}`)),
      );
      expect(echoed).toEqual(opened.map((_, i) => `request ${i}`));

      opened.forEach((forwarded) => forwarded.close());
      await sshd.allClosed();
      expect(sshd.connections).toEqual([{ closed: true }]);
    });

    it('reuses the connection for a later request while it is held or idle, and ends it only once idle', async () => {
      service.idleCloseMs = 60_000;
      const first = await service.open('server-1', target());
      first.close();
      const second = await service.open('server-1', target());
      await expect(echoThrough(second, 'again')).resolves.toBe('again');

      expect(sshd.connections).toEqual([{ closed: false }]);
      expect(sshd.forwards).toHaveLength(2);

      service.idleCloseMs = 50;
      second.close();
      await sshd.allClosed();
    });

    it('runs a command over the same connection as the channels, and answers its output and exit code', async () => {
      sshd.execAnswer = (command) =>
        command.startsWith('docker port')
          ? { stdout: '127.0.0.1:49153\n', code: 0 }
          : { stderr: 'Error: No such container\n', code: 1 };

      const [port, missing, forwarded] = await Promise.all([
        service.exec('server-1', [
          'docker',
          'port',
          'cloudgate-trace-store-application-web',
          '16686',
        ]),
        service.exec('server-1', ['docker', 'inspect', 'it is not there']),
        service.open('server-1', target()),
      ]);

      expect(port).toEqual({
        stdout: '127.0.0.1:49153\n',
        stderr: '',
        code: 0,
      });
      expect(missing).toEqual({
        stdout: '',
        stderr: 'Error: No such container\n',
        code: 1,
      });
      // Each word quoted for the Server's shell.
      expect(sshd.execs).toEqual([
        'docker port cloudgate-trace-store-application-web 16686',
        "docker inspect 'it is not there'",
      ]);
      expect(sshd.connections).toHaveLength(1);

      forwarded.close();
      await sshd.allClosed();
    });

    it('reads multi-byte characters back as themselves', async () => {
      // "é" is 0xC3 0xA9; the double writes it as one chunk, so this pins the
      // whole-buffer decode by the output it produces rather than by packets.
      sshd.execAnswer = () => ({ stdout: '/café?q=ü\n', code: 0 });

      await expect(
        service.exec('server-1', ['tail', '-c', '10', 'access.log']),
      ).resolves.toEqual({ stdout: '/café?q=ü\n', stderr: '', code: 0 });
    });

    it('stops a command whose signal aborts, and keeps the connection for the next one', async () => {
      service.idleCloseMs = 60_000;
      sshd.execAnswer = (command) =>
        command.startsWith('tail')
          ? { stdout: 'partial', code: 0, hang: true }
          : { stdout: '42\n', code: 0 };
      const controller = new AbortController();

      const read = service.exec(
        'server-1',
        ['tail', '-c', '16', 'access.log'],
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 50);

      await expect(read).rejects.toThrow(
        'The command was stopped before it finished',
      );
      await expect(
        service.exec('server-1', ['wc', '-c', 'access.log']),
      ).resolves.toEqual({ stdout: '42\n', stderr: '', code: 0 });
      expect(sshd.connections).toHaveLength(1);
    });

    it('refuses to start a command whose signal already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        service.exec('server-1', ['wc', '-c', 'access.log'], {
          signal: controller.signal,
        }),
      ).rejects.toThrow('The command was stopped before it finished');
      expect(sshd.execs).toEqual([]);
    });

    it('evicts a connection that dies under an open channel, and dials again for the next request', async () => {
      service.idleCloseMs = 60_000;
      const doomed = await service.open('server-1', target());
      const cut = new Promise<void>((resolve) =>
        doomed.socket.once('close', () => resolve()),
      );
      doomed.socket.on('error', () => undefined);

      sshd.dropConnections();
      await cut;
      await sshd.allClosed();

      const next = await service.open('server-1', target());
      await expect(echoThrough(next, 'redialled')).resolves.toBe('redialled');
      expect(sshd.connections).toEqual([{ closed: true }, { closed: false }]);
      next.close();
    });

    it('dials the Server again when its key or address changes, and ends the old connection once nothing holds it', async () => {
      service.idleCloseMs = 60_000;
      const other = await startSshForwardServer();
      try {
        const held = await service.open('server-1', target());

        // The Server's row now names another host and key.
        getConnection.mockResolvedValue(other.connection);
        const moved = await service.open('server-1', target());
        await expect(echoThrough(moved, 'moved')).resolves.toBe('moved');
        expect(other.connections).toEqual([{ closed: false }]);
        // The old connection still carries the channel opened on it.
        expect(sshd.connections).toEqual([{ closed: false }]);
        await expect(echoThrough(held, 'still here')).resolves.toBe(
          'still here',
        );

        held.close();
        await sshd.allClosed();
        moved.close();
      } finally {
        service.closeAll();
        await other.allClosed();
        await other.close();
      }
    });

    it('keeps no connection for a Server that no longer resolves, as a deleted one does not', async () => {
      service.idleCloseMs = 60_000;
      (await service.open('server-1', target())).close();
      expect(sshd.connections).toEqual([{ closed: false }]);

      getConnection.mockRejectedValue(new Error('Server not found'));
      await expect(service.open('server-1', target())).rejects.toThrow(
        /connection details could not be read: Server not found/,
      );
      await sshd.allClosed();
    });

    it('ends every connection and every channel on them when the app shuts down', async () => {
      service.idleCloseMs = 60_000;
      const open = await service.open('server-1', target());
      const cut = new Promise<void>((resolve) =>
        open.socket.once('close', () => resolve()),
      );
      open.socket.on('error', () => undefined);

      service.onModuleDestroy();

      await cut;
      await sshd.allClosed();
    });
  });
});
