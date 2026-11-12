import type { ParseArgsOptionDescriptor } from 'node:util';

import type { SocketOpener } from './deployment-log-stream.js';
import type { DockerRun } from './docker.js';
import type { ExitCode } from './exit-codes.js';
import type { LoginStore } from './logins.js';
import type { Output } from './output.js';
import type { Prompter } from './prompt.js';

/** What every command is handed: the run's facts, already decided. */
export interface CommandContext {
  env: Record<string, string | undefined>;
  /** The folder the run starts in. */
  cwd: string;
  out: Output;
  /** Data piped in (`vars set KEY`); read it only when not a terminal. */
  stdin: { isTTY: boolean; read(): Promise<string> };
  /** Questions for the person; ask only when `out.mode.canAsk`. */
  prompter: Prompter;
  fetch: typeof fetch;
  /** Runs a `docker` command on this computer (`template try`). */
  docker: DockerRun;
  /** Opens a WebSocket (a Deployment log stream). */
  openSocket: SocketOpener;
  /** Ctrl-C, for a command whose work goes on elsewhere (see {@link Interrupts}). */
  interrupts: Interrupts;
  now: () => Date;
  /** Waits, between a login's polls and between asks of a Deployment. */
  sleep: (ms: number) => Promise<void>;
  /** This computer's saved logins and the current Instance. */
  logins: LoginStore;
  /** `--instance`, accepted on every command. */
  instanceFlag?: string;
  /** `--allow-http`: lifts `instanceAddress`'s plain-http refusal. */
  allowHttp: boolean;
  /** The command's own flags, parsed. */
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/**
 * One `cloudgate` command. The registry in `commands/index.ts` is the only list
 * of them: the overview help is built from it, so a later ticket adds a
 * command by adding an entry, and its line appears under its group.
 */
export interface Command {
  /** One or two words: `whoami`, `instance list`. */
  name: string;
  /** The overview's section, in the accepted help text's order. */
  group: 'LOG IN' | 'THIS FOLDER' | 'TEMPLATES';
  /** The overview line. */
  summary: string;
  /** `cloudgate <name> --help`, whole. */
  help: string;
  /** The command's own flags; the global ones are added by `run`. */
  options: Record<string, ParseArgsOptionDescriptor>;
  /** How many positionals it takes; more is wrong use. */
  maxPositionals: number;
  run(context: CommandContext): Promise<ExitCode>;
}

/**
 * Ctrl-C (CLI spec: exit 130). With no listener the process simply exits
 * 130 (`main.ts`). A command watching something that goes on without it — a
 * Deployment — listens, so it can say how to pick the watch up again before
 * it ends; a second Ctrl-C still exits at once.
 */
export interface Interrupts {
  /** Calls `listener` on Ctrl-C until the returned function is called. */
  listen(listener: () => void): () => void;
}
