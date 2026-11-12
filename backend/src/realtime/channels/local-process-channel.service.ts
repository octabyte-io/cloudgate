import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { StreamChannel } from './stream-channel';

/**
 * Local child processes without a pty (the deployment-logs handler's `tail`).
 * close() sends SIGTERM, then SIGKILL if the child is still alive a second
 * later.
 *
 * **This one has no `resize`, and that is not an omission.** A window size
 * is a property of a terminal, and `child_process.spawn` gives the child three
 * pipes and no terminal at all — there is no `TIOCSWINSZ` to set, `isatty(1)` is
 * false in the child, and no SIGWINCH can be delivered because nothing owns a
 * window to change. `tail -f` neither asks nor cares. The gateway that uses this
 * (`/listen-deployment`) is one-directional anyway, and `StreamChannel.resize` is
 * optional precisely so a transport without a window can say so by not having it.
 */
@Injectable()
export class LocalProcessChannelService {
  spawn(file: string, args: string[]): StreamChannel {
    const child = spawn(file, args);
    const emitter = new EventEmitter();

    child.stdout?.on('data', (data: Buffer | string) =>
      emitter.emit('data', data.toString()),
    );
    child.stderr?.on('data', (data: Buffer | string) =>
      emitter.emit('stderr', data.toString()),
    );
    child.on('close', (code) => emitter.emit('close', code ?? undefined));
    child.on('error', (err) => emitter.emit('error', err));

    return {
      write: (data) => void child.stdin?.write(data),
      close: () => {
        if (child.killed) return;
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1000);
        forceKill.unref();
      },
      onData: (listener) => void emitter.on('data', listener),
      onStderr: (listener) => void emitter.on('stderr', listener),
      onClose: (listener) => void emitter.on('close', listener),
      onError: (listener) => void emitter.on('error', listener),
    };
  }
}
