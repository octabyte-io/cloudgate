import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { IPty, IPtyForkOptions } from 'node-pty';
import type { StreamChannel } from './stream-channel';

/**
 * Local pseudo-terminals via node-pty. node-pty is a native module, so it is
 * required lazily at spawn time — importing it at module load would make every
 * consumer depend on the platform build.
 */
@Injectable()
export class PtyChannelService {
  spawn(
    file: string,
    args: string[],
    options: IPtyForkOptions = {},
  ): StreamChannel {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require('node-pty') as typeof import('node-pty');
    const proc: IPty = pty.spawn(file, args, options);
    const emitter = new EventEmitter();

    proc.onData((data) => emitter.emit('data', data));
    proc.onExit(({ exitCode }) => emitter.emit('close', exitCode));

    return {
      write: (data) => proc.write(data),
      // node-pty takes the window the way a terminal is spoken about, columns
      // first, and signals SIGWINCH to whatever is running inside it.
      resize: (cols, rows) => proc.resize(cols, rows),
      close: () => proc.kill(),
      onData: (listener) => void emitter.on('data', listener),
      // A pty merges stderr into the terminal stream; nothing to wire.
      onStderr: () => undefined,
      onClose: (listener) => void emitter.on('close', listener),
      onError: (listener) => void emitter.on('error', listener),
    };
  }
}
