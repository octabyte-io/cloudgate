import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { terminalPrompter } from '../src/prompt.js';

/** A prompter on in-memory streams, and everything it wrote. */
function onStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => (written += chunk.toString('utf8')));
  return {
    prompter: terminalPrompter({ input, output }),
    type: (line: string) => setImmediate(() => input.write(`${line}\r`)),
    written: () => written,
  };
}

const CHOICES = [{ label: 'One app' }, { label: 'The whole Project' }];

describe('terminalPrompter', () => {
  it('picks the default choice on an empty answer, showing which it is', async () => {
    const terminal = onStreams();
    const picked = terminal.prompter.choose('Which?', CHOICES, { default: 0 });
    terminal.type('');

    expect(await picked).toBe(0);
    expect(terminal.written()).toContain('  Pick 1-2 [1]: ');
  });

  it('picks the choice an answer names over the default', async () => {
    const terminal = onStreams();
    const picked = terminal.prompter.choose('Which?', CHOICES, { default: 0 });
    terminal.type('2');

    expect(await picked).toBe(1);
  });

  it('asks again on an empty answer when there is no default', async () => {
    const terminal = onStreams();
    const picked = terminal.prompter.choose('Which?', CHOICES);
    terminal.type('');
    setTimeout(() => terminal.type('the whole project'), 20);

    expect(await picked).toBe(1);
    expect(terminal.written().match(/Pick 1-2: /g)).toHaveLength(2);
  });
});
