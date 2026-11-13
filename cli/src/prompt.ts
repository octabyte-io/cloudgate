import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';

import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';

/**
 * The questions a command may ask a person at a terminal. Only ever used when
 * `terminalMode().canAsk` says a question may be asked; a run that may not ask
 * refuses instead (`requireInputs`).
 *
 * Hand-written on `node:readline` rather than a prompt library: the published
 * package has no runtime dependencies (`cli/README.md`), and a numbered list
 * read back by number or name is all `link` needs.
 */
export interface Prompter {
  /** Asks to pick one of `choices`; answers its index. */
  choose(
    question: string,
    choices: readonly { label: string; note?: string }[],
  ): Promise<number>;
  /** Asks a yes/no question; anything but yes is no. */
  confirm(question: string): Promise<boolean>;
  /** Asks for a line of text, shown as it is typed; answers it trimmed. */
  text(question: string): Promise<string>;
  /** Asks for a secret, with nothing of it shown as it is typed. */
  secret(question: string): Promise<string>;
}

/**
 * A {@link Prompter} on a terminal's streams. Questions go to stderr, like
 * every other line that is not data, so `cloudgate link > out` still shows
 * them. An answer that is neither a listed number nor a listed name is asked
 * again; closing stdin (Ctrl-D) stops the run.
 */
export function terminalPrompter(streams: {
  input: Readable;
  output: Writable;
}): Prompter {
  async function ask(question: string, hidden = false): Promise<string> {
    // Hidden: the line editor echoes into a sink, so no keystroke reaches
    // the screen (or a scrollback); the question itself is written here.
    if (hidden) streams.output.write(question);
    const reader = createInterface({
      input: streams.input,
      output: hidden ? DISCARD() : streams.output,
      terminal: true,
    });
    const closed = new Promise<never>((_, reject) =>
      reader.once('close', () =>
        reject(new CliError('stopped before answering', EXIT.interrupted)),
      ),
    );
    try {
      return await Promise.race([
        reader.question(hidden ? '' : question),
        closed,
      ]);
    } finally {
      if (hidden) streams.output.write('\n');
      reader.removeAllListeners('close');
      reader.close();
    }
  }

  return {
    async choose(question, choices) {
      const width = String(choices.length).length;
      const lines = choices.map(
        (choice, index) =>
          `  ${String(index + 1).padStart(width)}) ${choice.label}${choice.note ? `   (${choice.note})` : ''}`,
      );
      streams.output.write(`? ${question}\n${lines.join('\n')}\n`);
      for (;;) {
        const answer = (await ask(`  Pick 1-${choices.length}: `)).trim();
        const index = pickedIndex(answer, choices);
        if (index !== undefined) return index;
      }
    },
    async confirm(question) {
      const answer = await ask(`? ${question} (y/N) `);
      return /^y(es)?$/i.test(answer.trim());
    },
    async text(question) {
      return (await ask(`? ${question} `)).trim();
    },
    secret(question) {
      return ask(`? ${question}`, true);
    },
  };
}

/** A stream that drops what is written to it. */
const DISCARD = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

/** The choice an answer names: its number, or its label ignoring case. */
export function pickedIndex(
  answer: string,
  choices: readonly { label: string }[],
): number | undefined {
  if (/^\d+$/.test(answer)) {
    const index = Number(answer) - 1;
    return index >= 0 && index < choices.length ? index : undefined;
  }
  const wanted = answer.toLowerCase();
  const index = choices.findIndex(
    (choice) => choice.label.toLowerCase() === wanted,
  );
  return index >= 0 ? index : undefined;
}
