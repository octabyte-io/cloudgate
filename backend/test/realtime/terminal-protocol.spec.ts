import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  readTerminalFrame,
} from '../../src/realtime/terminal-protocol';

/**
 * The one control frame the terminal gateways understand.
 *
 * Everything a browser sends is raw terminal input, so the only way a resize can
 * be told apart from something the operator typed is a reserved first byte. These
 * tests pin all three outcomes: a well-formed control frame is a resize, a
 * control frame asking for a window that is not a window is dropped rather than
 * honoured *or* typed, and everything else — including a frame that merely
 * *starts* with the reserved byte — reaches the shell untouched.
 */
describe('readTerminalFrame', () => {
  it('reads a resize out of a NUL-prefixed control frame', () => {
    expect(readTerminalFrame('\x00{"cols":120,"rows":40}')).toEqual({
      kind: 'resize',
      size: { cols: 120, rows: 40 },
    });
  });

  it('ignores keys it does not know', () => {
    expect(readTerminalFrame('\x00{"cols":100,"rows":30,"pixels":7}')).toEqual({
      kind: 'resize',
      size: { cols: 100, rows: 30 },
    });
  });

  it('accepts the ceiling itself', () => {
    expect(
      readTerminalFrame(
        `\x00{"cols":${MAX_TERMINAL_COLS},"rows":${MAX_TERMINAL_ROWS}}`,
      ),
    ).toEqual({
      kind: 'resize',
      size: { cols: MAX_TERMINAL_COLS, rows: MAX_TERMINAL_ROWS },
    });
  });

  describe('is terminal input', () => {
    // Each of these is something a user could plausibly send, and every one of
    // them has to end up in the shell rather than being swallowed as control.
    const inputs: [string, string][] = [
      ['the same JSON without the reserved byte', '{"cols":120,"rows":40}'],
      ['a bare NUL, which is what Ctrl-Space sends', '\x00'],
      ['a NUL followed by ordinary typing', '\x00hello'],
      ['a NUL followed by broken JSON', '\x00{"cols":120,'],
      ['a NUL followed by a JSON array', '\x00[120,40]'],
      ['a NUL followed by a JSON string', '\x00"resize"'],
      ['a NUL followed by JSON null', '\x00null'],
      ['ordinary typing', 'ls -la\r'],
      ['an escape sequence', '\x1b[A'],
      ['nothing at all', ''],
    ];

    it.each(inputs)('%s', (_label, frame) => {
      expect(readTerminalFrame(frame)).toEqual({ kind: 'input', data: frame });
    });

    it('a paste far too long to be a control frame', () => {
      // A paste is one frame and can be megabytes. Only the first byte is read
      // before the length is, so a giant paste that happens to open with NUL is
      // input without JSON.parse ever seeing it.
      const paste = `\x00{"cols":80,"rows":24}${' '.repeat(1024)}`;

      expect(readTerminalFrame(paste)).toEqual({ kind: 'input', data: paste });
    });
  });

  describe('drops a control frame whose window is not a window', () => {
    // cols/rows come off a socket a browser controls and are handed straight to
    // ssh2 and node-pty, so anything but a plausible positive integer is refused
    // rather than clamped — a client sending nonsense keeps its old window, and
    // gets no guess at what it meant. It is not typed into the shell either: it
    // was addressed to the protocol, however badly.
    const frames: [string, string][] = [
      ['zero columns', '\x00{"cols":0,"rows":24}'],
      ['zero rows', '\x00{"cols":80,"rows":0}'],
      ['negative columns', '\x00{"cols":-80,"rows":24}'],
      ['fractional columns', '\x00{"cols":80.5,"rows":24}'],
      [
        'columns past the ceiling',
        `\x00{"cols":${MAX_TERMINAL_COLS + 1},"rows":24}`,
      ],
      [
        'rows past the ceiling',
        `\x00{"cols":80,"rows":${MAX_TERMINAL_ROWS + 1}}`,
      ],
      ['a numeric string', '\x00{"cols":"80","rows":"24"}'],
      ['no rows at all', '\x00{"cols":80}'],
      ['an empty object', '\x00{}'],
      [
        'Infinity, which is what JSON does with 1e999',
        '\x00{"cols":1e999,"rows":24}',
      ],
    ];

    it.each(frames)('%s', (_label, frame) => {
      expect(readTerminalFrame(frame)).toEqual({ kind: 'unhonoured-control' });
    });
  });
});
