import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';

import { configDir } from './config-dir.js';
import { EXIT } from './exit-codes.js';
import { loginStore, osKeychain } from './logins.js';
import { terminalPrompter } from './prompt.js';
import { run } from './run.js';
import { fileUpdateStateStore } from './update-notice.js';

/**
 * The process around a {@link run}: the real streams, environment and `fetch`.
 *
 * Ctrl-C exits 130 (CLI spec). It stops this process only; a command whose
 * work goes on elsewhere (a Deployment) listens through `interrupts`, says so
 * itself and ends with 130. A second Ctrl-C, or one with no listener, exits
 * at once.
 */
const interruptListeners = new Set<() => void>();
let interruptedOnce = false;
process.on('SIGINT', () => {
  if (interruptListeners.size === 0 || interruptedOnce) {
    process.exitCode = EXIT.interrupted;
    process.exit(EXIT.interrupted);
  }
  interruptedOnce = true;
  for (const listener of [...interruptListeners]) listener();
});

const settings = configDir({
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
});

const code = await run({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  stderrIsTTY: process.stderr.isTTY === true,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fetch: globalThis.fetch,
  interrupts: {
    listen(listener) {
      interruptListeners.add(listener);
      return () => interruptListeners.delete(listener);
    },
  },
  now: () => new Date(),
  updateState: fileUpdateStateStore(settings),
  logins: loginStore({
    configDir: settings,
    env: process.env,
    keychain: osKeychain,
  }),
  prompter: terminalPrompter({ input: process.stdin, output: process.stderr }),
  readStdin: () => text(process.stdin),
});
// `exitCode` rather than `exit()`, so a pipe reading stdout gets every byte.
process.exitCode = code;
