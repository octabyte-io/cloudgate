import { parseArgs } from 'node:util';
import type { ParseArgsOptionDescriptor } from 'node:util';

import type { Command, Interrupts } from './command.js';
import { COMMANDS } from './commands/index.js';
import { openWebSocket } from './deployment-log-stream.js';
import type { SocketOpener } from './deployment-log-stream.js';
import { reportError, usageError } from './errors.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';
import { overviewHelp } from './help.js';
import { noLoginStore } from './logins.js';
import type { LoginStore } from './logins.js';
import { Output } from './output.js';
import type { Prompter } from './prompt.js';
import { terminalMode } from './terminal.js';
import { startUpdateCheck } from './update-notice.js';
import type { UpdateStateStore } from './update-notice.js';
import { VERSION } from './version.js';

/**
 * Everything one run of `cloudgate` is given, so the whole CLI can be driven
 * without a process: `main.ts` fills it from `process`, the unit lane from a
 * test.
 */
export interface Invocation {
  argv: string[];
  env: Record<string, string | undefined>;
  /** The folder the run starts in: where a Folder link is looked for and made. */
  cwd: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch: typeof fetch;
  /** Node's own `WebSocket` unless given. */
  openSocket?: SocketOpener;
  /** Ctrl-C (`main.ts`); never, unless given. */
  interrupts?: Interrupts;
  now: () => Date;
  /**
   * Where the update notice remembers its last check (`main.ts`: a file in the
   * config folder). Without one there is no update notice.
   */
  updateState?: UpdateStateStore;
  /** Asks the person questions; used only when the run may ask. */
  prompter: Prompter;
  /**
   * Reads stdin to its end (`main.ts`: the process's). Only a command that
   * takes data on stdin calls it, and only when stdin is not a terminal;
   * without one stdin reads as empty.
   */
  readStdin?: () => Promise<string>;
  /**
   * The saved logins (`main.ts`: files in the config folder and the OS
   * keychain). Without one the run has no saved logins and cannot save one.
   */
  logins?: LoginStore;
  /** Waits; `setTimeout` unless a test passes its own. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The flags every command accepts (CLI spec). `--version` has no `-v`, and
 * `--json` is not here: it belongs to the commands that print data.
 */
const GLOBAL_OPTIONS: Record<string, ParseArgsOptionDescriptor> = {
  instance: { type: 'string' },
  // Accepted wherever `--instance` is, since every command that talks to an
  // Instance applies the address rules; listed in help by `login` alone, as
  // the accepted help text does.
  'allow-http': { type: 'boolean' },
  'no-input': { type: 'boolean' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

/** The command the positionals name, longest name first, and what is left. */
function findCommand(
  positionals: string[],
): { command: Command; rest: string[] } | undefined {
  const byLength = [...COMMANDS].sort(
    (a, b) => b.name.split(' ').length - a.name.split(' ').length,
  );
  for (const command of byLength) {
    const words = command.name.split(' ');
    if (words.every((word, index) => positionals[index] === word)) {
      return { command, rest: positionals.slice(words.length) };
    }
  }
  return undefined;
}

/**
 * Parses `argv` against the global flags plus `extra`, refusing (exit 2) an
 * unknown flag or a string flag given no value. Parsed leniently and checked
 * here, rather than with `strict: true`, so the refusal names the flag in this
 * CLI's words instead of Node's.
 */
function parse(
  argv: string[],
  extra: Record<string, ParseArgsOptionDescriptor>,
  usage: string,
) {
  const options = { ...GLOBAL_OPTIONS, ...extra };
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const known = options[token.name];
    if (!known) {
      throw usageError(`unknown flag ${token.rawName}`, `Run ${usage} --help.`);
    }
    if (known.type === 'string' && token.value === undefined) {
      throw usageError(
        `${token.rawName} needs a value`,
        `Run ${usage} --help.`,
      );
    }
    if (known.type === 'boolean' && token.value !== undefined) {
      throw usageError(
        `${token.rawName} takes no value`,
        `Run ${usage} --help.`,
      );
    }
  }
  return { values, positionals };
}

/**
 * One whole run: parses, dispatches, and turns every failure into its exit
 * code. The update notice, when one is due, comes last on stderr.
 */
export async function run(invocation: Invocation): Promise<ExitCode> {
  const updates = invocation.updateState
    ? startUpdateCheck({
        ...invocation,
        current: VERSION,
        store: invocation.updateState,
      })
    : undefined;
  let code: ExitCode;
  try {
    code = await dispatch(invocation);
  } catch (error) {
    code = reportError(error, invocation);
  }
  const notice = await updates?.finish();
  if (notice) invocation.stderr(notice);
  return code;
}

async function dispatch(invocation: Invocation): Promise<ExitCode> {
  const { argv } = invocation;
  // A first pass knowing every command's flags, only to find the command
  // words: a flag's value (`--instance x`) must not be read as one.
  const everyOption = Object.assign(
    {},
    ...COMMANDS.map((command) => command.options),
  ) as Record<string, ParseArgsOptionDescriptor>;
  const first = parseArgs({
    args: argv,
    options: { ...GLOBAL_OPTIONS, ...everyOption },
    strict: false,
    allowPositionals: true,
  });

  if (first.positionals.length === 0) {
    const { values } = parse(argv, {}, 'cloudgate');
    if (values.version) {
      invocation.stdout(`${VERSION}\n`);
      return EXIT.ok;
    }
    invocation.stdout(overviewHelp(COMMANDS));
    return EXIT.ok;
  }

  const found = findCommand(first.positionals);
  if (!found) {
    throw usageError(
      `unknown command "${first.positionals.join(' ')}"`,
      'Run cloudgate --help to see the commands.',
    );
  }
  const { command } = found;
  const usage = `cloudgate ${command.name}`;
  const { values, positionals } = parse(argv, command.options, usage);
  if (values.help) {
    invocation.stdout(command.help);
    return EXIT.ok;
  }
  if (values.version) {
    invocation.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  const rest = positionals.slice(command.name.split(' ').length);
  if (rest.length > command.maxPositionals) {
    throw usageError(
      `${usage} takes ${command.maxPositionals === 0 ? 'no arguments' : `at most ${command.maxPositionals}`}, not "${rest.join(' ')}"`,
      `Run ${usage} --help.`,
    );
  }

  const mode = terminalMode({
    env: invocation.env,
    stdinIsTTY: invocation.stdinIsTTY,
    stdoutIsTTY: invocation.stdoutIsTTY,
    stderrIsTTY: invocation.stderrIsTTY,
    noColor: values['no-color'] === true,
    noInput: values['no-input'] === true,
  });
  return command.run({
    env: invocation.env,
    cwd: invocation.cwd,
    prompter: invocation.prompter,
    out: new Output(invocation, mode),
    stdin: {
      isTTY: invocation.stdinIsTTY,
      read: invocation.readStdin ?? (() => Promise.resolve('')),
    },
    fetch: invocation.fetch,
    openSocket: invocation.openSocket ?? openWebSocket,
    interrupts: invocation.interrupts ?? { listen: () => () => {} },
    now: invocation.now,
    sleep:
      invocation.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    logins: invocation.logins ?? noLoginStore(),
    instanceFlag:
      typeof values.instance === 'string' ? values.instance : undefined,
    allowHttp: values['allow-http'] === true,
    values,
    positionals: rest,
  });
}
