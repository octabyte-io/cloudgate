import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { PtyChannelService } from '../../src/realtime/channels/pty-channel.service';
import { bridgeTerminalInput } from '../../src/realtime/terminal-protocol';
import type { WsClient } from '../../src/realtime/ws-client';

/**
 * The whole browser-facing path for a resize, over a real socket.
 *
 * Everything between a client's frame and the kernel is the real thing here: a
 * real `ws` server, the gateways' own `bridgeTerminalInput`, a real pty from
 * `PtyChannelService`, and a real `/bin/sh` answering `stty size`. Only the
 * emulator is missing, and all the emulator does is produce the frame this sends.
 *
 * The unit tests either side of this can both pass while the socket still types
 * the control frame into the shell — that failure is what the issue reported, and
 * this is the test that would have caught it.
 */

/** Same skip as `pty-spawn-helper.spec.ts`: no node-pty for this platform. */
function hasSpawnHelper(): boolean {
  if (process.platform === 'win32') return false;
  const root = dirname(dirname(require.resolve('node-pty')));
  return [
    join(root, 'build', 'Release', 'spawn-helper'),
    join(root, 'build', 'Debug', 'spawn-helper'),
    join(
      root,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    ),
  ].some((candidate) => existsSync(candidate));
}

const itWithPty = hasSpawnHelper() ? it : it.skip;

describe('a resize over a real terminal socket', () => {
  let http: Server;
  let wss: WebSocketServer;
  let port: number;

  beforeAll(async () => {
    http = createServer();
    wss = new WebSocketServer({ server: http });
    wss.on('connection', (socket) => {
      // An interactive shell at the size every session used to be stuck at.
      const channel = new PtyChannelService().spawn('/bin/sh', [], {
        cols: 80,
        rows: 24,
      });
      channel.onData((chunk) => socket.send(chunk));
      // A real `ws` socket already is a WsClient; the interface is that slice.
      bridgeTerminalInput(socket satisfies WsClient, channel);
      socket.on('close', () => channel.close());
    });
    await new Promise<void>((resolve) => http.listen(0, resolve));
    port = (http.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => http.close(resolve));
  });

  /** Opens a session, sends `frames` in order, and returns everything the shell
   *  said back. */
  async function session(frames: string[]): Promise<string> {
    const client = new WebSocket(`ws://127.0.0.1:${port}/terminal`);
    let output = '';
    client.on('message', (data) => {
      output += (data as Buffer).toString();
    });
    await new Promise((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });

    for (const frame of frames) {
      client.send(frame);
      // Each frame is a separate turn of the shell, the way typing is.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    client.close();
    return output;
  }

  itWithPty('changes the size the shell reports', async () => {
    const output = await session(['\x00{"cols":120,"rows":40}', 'stty size\n']);

    // `stty size` prints `rows cols`. 24 80 is the session this issue described.
    expect(output).toContain('40 120');
    expect(output).not.toContain('24 80');
  });

  itWithPty('never types the control frame into the shell', async () => {
    const output = await session(['\x00{"cols":120,"rows":40}', 'echo done\n']);

    // A shell that had been typed into would echo the JSON back at its prompt.
    expect(output).not.toContain('"cols"');
    expect(output).toContain('done');
  });

  itWithPty('resizes again mid-session', async () => {
    const output = await session([
      '\x00{"cols":120,"rows":40}',
      'stty size\n',
      '\x00{"cols":52,"rows":13}',
      'stty size\n',
    ]);

    expect(output).toContain('40 120');
    expect(output).toContain('13 52');
  });
});
