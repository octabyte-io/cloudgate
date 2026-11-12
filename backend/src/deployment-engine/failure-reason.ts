import { elideEncodedPayloads } from '../common/logging/error-payloads';

/**
 * How many lines of the Deployment log a failure notification reads back — the
 * failing step's last words, which is what the console's Build output card
 * shows an operator first and the only part a phone notification can act on.
 */
export const FAILURE_TAIL_LINES = 12;

/**
 * The most a failure reason may carry, in UTF-16 code units, kept from the
 * *end*: a builder's last line is the one that says why, and the start of a
 * long tail is the progress that led up to it. Short enough for a chat preview
 * or an email's first screen; every channel still applies its own hard cap
 * (`capMessage`) on top.
 */
export const FAILURE_REASON_MAX = 1000;

// CSI sequences — the colour and cursor codes nixpacks, docker and git write
// when they think they own a terminal.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * A builder's output as a person would have read it on a terminal: colour
 * codes gone, each `\r`-overwritten progress line reduced to what it finally
 * said, blank lines dropped, and only the last {@link FAILURE_TAIL_LINES} kept
 * within {@link FAILURE_REASON_MAX}. Any credential a clone URL carried is
 * elided by the same mask `ExecError` applies (`elideEncodedPayloads`), since
 * this text leaves the platform for a customer-supplied webhook.
 *
 * Empty when there was nothing to say.
 */
export function summarizeBuildOutput(output: string): string {
  const lines = output
    .replace(ANSI_ESCAPE, '')
    .split('\n')
    .map((line) => {
      const overwrites = line.split('\r').filter((part) => part.trim());
      return (overwrites.at(-1) ?? '').trimEnd();
    })
    .filter((line) => line.trim());
  const tail = elideEncodedPayloads(
    lines.slice(-FAILURE_TAIL_LINES).join('\n'),
  );
  if (tail.length <= FAILURE_REASON_MAX) return tail;
  // Cut on a line boundary where there is one inside the budget, so the
  // reason opens on a whole line rather than halfway through a word.
  const cut = tail.slice(-(FAILURE_REASON_MAX - 1));
  const whole = cut.indexOf('\n');
  if (whole !== -1) return `…${cut.slice(whole)}`;
  // One line longer than the budget: never open on half a surrogate pair.
  return `…${/^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut}`;
}
