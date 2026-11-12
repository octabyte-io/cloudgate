import { demuxDockerLogs } from '../../src/cron-services/docker-log-frames';

function frame(stream: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe('demuxDockerLogs', () => {
  it('joins stdout and stderr frames in order, without their headers', () => {
    const raw = Buffer.concat([
      frame(1, 'starting\n'),
      frame(2, 'warning: slow\n'),
      frame(1, 'done ✓\n'),
    ]);

    expect(demuxDockerLogs(raw)).toBe('starting\nwarning: slow\ndone ✓\n');
  });

  it('answers an unframed (TTY) answer as it is', () => {
    expect(demuxDockerLogs(Buffer.from('plain output\n'))).toBe(
      'plain output\n',
    );
  });

  it('answers nothing for no output', () => {
    expect(demuxDockerLogs(Buffer.alloc(0))).toBe('');
  });

  it('keeps what a cut-off last frame holds', () => {
    const whole = frame(1, 'complete line\n');
    expect(demuxDockerLogs(whole.subarray(0, whole.length - 5))).toBe(
      'complete ',
    );
  });
});
