import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { quote } from 'shell-quote';
import { Client } from 'ssh2';
import { sshConnectConfig, sshFailure } from './host-key';
import type { ClientChannel } from 'ssh2';
import { ExecError } from './exec-error';
import { SERVER_KEY_PROVIDER } from './server-key.provider';
import type { ServerKeyProvider } from './server-key.provider';

const execAsyncBase = promisify(exec);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  /**
   * Aborting it stops the program: its whole process group is sent
   * SIGKILL and the call rejects at once with an {@link ExecError} saying it
   * was cancelled. See {@link RemoteExecService.execAsync}.
   */
  signal?: AbortSignal;
  /**
   * The most bytes stdout or stderr may reach before the program is killed
   * and the call rejects ({@link isMaxBufferExceeded}). Node's own `exec`
   * option, passed through; unset means Node's default (1 MiB). Ignored with
   * a `signal`.
   */
  maxBuffer?: number;
  /**
   * The program travels on the shell's stdin (`/bin/sh -s`) rather than as its
   * `-c` argument, so its size is not bounded by the 128 KiB Linux
   * allows one argument (MAX_ARG_STRLEN): past that a `-c` spawn fails E2BIG
   * before the first line runs. For a program that carries data, such as an
   * uploaded tree. A command inside it must not read stdin, which is the
   * rest of the program — {@link DEFAULT_REMOTE_ENV_SHELL} has the measurement.
   * `maxBuffer` is ignored with it, as with a `signal`.
   */
  programOnStdin?: boolean;
}

/** The code Node's `exec` gives an output that outgrew `maxBuffer`. */
const MAX_BUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * Whether an exec failed because its output outgrew `maxBuffer` — on the local
 * branch Node's own error, on the remote one the same error, raised by
 * {@link RemoteExecService.execAsyncRemote}.
 */
export function isMaxBufferExceeded(error: unknown): boolean {
  if (!(error instanceof ExecError)) return false;
  const original = error.originalError as { code?: unknown } | undefined;
  return original?.code === MAX_BUFFER_CODE;
}

/** The error Node's `exec` raises for an overgrown stream, made for ssh2. */
function maxBufferError(stream: 'stdout' | 'stderr'): Error {
  return Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), {
    code: MAX_BUFFER_CODE,
  });
}

export interface RemoteExecOptions {
  /**
   * Environment for the remote command. Secrets belong here rather than in the
   * command string: a command is the argv of the shell sshd starts, which any
   * other user on that host can read out of `ps`, while an environment is
   * readable only by its own process's owner.
   */
  env?: Record<string, string>;
  /**
   * The shell that reads the script an environment makes, the way the local
   * branch's `ExecOptions.shell` names one. Defaults to `sh`.
   *
   * Needed because without an environment the script *is* the SSH exec
   * request, which sshd runs under the account's login shell — bash on every
   * distro this deploys to — and the database backup script opens with
   * `set -eo pipefail`. Feeding that to `sh` loses pipefail wherever `/bin/sh`
   * is dash, so a caller that needs bash says so instead of inheriting
   * whichever shell the default happens to be.
   *
   * **"Silently" is what this docblock used to say, and it was measured and it
   * is not true** — which matters, because it was one of the two reasons
   * recorded for never-carry as unavailable, and a hazard is not weighed
   * correctly from a description of it. dash does not ignore the option: it
   * refuses it. `printf 'set -eo pipefail\necho reached\n' | dash -s` prints
   * `set: Illegal option -o pipefail`, exits **2**, and runs nothing after the
   * first line. So the failure this defends against is loud and total at line
   * one, not a pipeline quietly missing a guarantee — which is a *better*
   * failure to have, and the reason the substitution turned out safe for the
   * builds put through it. See {@link buildEnvScript}.
   */
  shell?: string;
  /**
   * Aborting it stops the program: the remote shell's session is
   * killed by its process group and the call rejects at once. See
   * {@link RemoteExecService.execAsyncRemote}.
   */
  signal?: AbortSignal;
  /**
   * The most bytes stdout or stderr may collect, as `ExecOptions.maxBuffer`
   * is for the local branch. Past it the connection is closed and the
   * call rejects with Node's own overflow error ({@link isMaxBufferExceeded}).
   * Unset means no cap, which is what every caller once had.
   */
  maxBuffer?: number;
  /**
   * The program is read by `sh -s` off the channel rather than sent as the
   * `exec` request, as a program with an `env` already is. sshd runs
   * the request as the login shell's `-c` argument, so a request over the 128
   * KiB Linux allows one argument (MAX_ARG_STRLEN) never starts. See
   * `ExecOptions.programOnStdin`, its local twin.
   */
  programOnStdin?: boolean;
}

/** POSIX single-quoting, so a value can hold any byte but a shell meaning. */
const shellQuote = (value: string): string =>
  `'${value.split("'").join(`'\\''`)}'`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A remote environment cannot travel as an SSH `env` channel request: OpenSSH
 * sets only the variables `AcceptEnv` names, and the sshd config every distro
 * ships names the locale and nothing else, so `RCLONE_S3_*` would be dropped
 * and the command would run without its credentials.
 *
 * So it travels as a script on stdin instead. The remote runs a bare `sh -s`
 * (or whatever `RemoteExecOptions.shell` names), which reads the assignments
 * and then the command itself from the channel: the process table shows
 * `sh -s`, nothing of the environment or the command reaches any argv, and no
 * shell history records it.
 *
 * **What that costs, measured, because every application build goes
 * through here and the failure is silent.** The program is now on the shell's
 * own stdin, so a command *inside* it that reads stdin consumes the rest of
 * the script. Under bash it really does: a script of `echo one`, `cat`,
 * `echo two` fed to `bash -s` runs `echo one`, hands `echo two` to `cat`, and
 * exits **0** having skipped the rest — a program that truncates and reports
 * success. Under dash it does not, because dash reads non-seekable input a
 * byte at a time; so the exposure follows `RemoteExecOptions.shell`, and the
 * `/bin/bash` the database backup and restore pass is the exposed one.
 *
 * Nothing in `src/` reads stdin inside one of these programs today — the
 * backup pipelines read from a pipe, not from the script — so this is latent
 * rather than live, and it is recorded here rather than fixed here because the
 * fix belongs to the *caller*, which is the only place that knows which part
 * of its program the redirect may bind: `DeploymentEngineService.deploy`
 * appends `< /dev/null` to the subshell it already wraps its steps in, which
 * leaves the outer shell reading the script. A blanket `{ … } < /dev/null`
 * around every caller's command would take away the one thing a future caller
 * might legitimately want to feed a program on stdin.
 */
const DEFAULT_REMOTE_ENV_SHELL = 'sh';

/**
 * The `export` lines a remote environment travels as, prepended to the command
 * the far shell then reads off the same channel.
 *
 * **This is the seam the registry login wanted and could not have, and the
 * build is the first caller to reach it from a deploy.**
 * `registries/registry.utils.ts`'s login builder — `safeDockerLoginCommand`
 * then, `dockerLoginCommand` now — recorded two hazards as the reason
 * never-carry was unavailable there: the shell substitution below, and the local
 * branch's replacing `env`. A later change put six builders and every
 * application build through both, so both were measured against the shipped code
 * rather than read off a docblock. **Neither is live.** What follows is the
 * measurement, because the next caller will weigh the same two — and the two
 * registry passwords and one image-pull credential are the callers that did, and
 * took this route.
 *
 * **1. The shell substitution — not applicable to a build program, and the
 * hazard was mis-described.** With an environment the SSH `exec` request stops
 * being the program and becomes `sh -s`, so a build that carries an operator
 * variable is read by `/bin/sh` where before it was read by the account's login
 * shell. `DeploymentEngineService.exec` passes no `shell`, deliberately, and
 * that is safe for three reasons and not for the absence of one:
 *
 * - The deploy program is POSIX and cannot stop being: composed for all seven
 *   build types (clone, patches, build, registry push) it passes `dash -n`, and
 *   run against argv-recording stubs under `bash -c` (the pre-#356 transport),
 *   `dash -s` and `bash -s` it produces byte-identical log output, byte-identical
 *   tool argv and the same exit code — on success and on a tool exiting 7, which
 *   all three report to the engine as 1. Every operator-controlled byte in that
 *   program is a `quote()`d word or a holder reference, so nothing
 *   an operator can write adds a bash construct to it; the grammar is
 *   tree-authored end to end.
 * - No build program contains `pipefail`, and the one program in the tree that
 *   does — the database dump and restore pipeline — already names `/bin/bash` on
 *   both sides for exactly this reason (`backups/backups.service.ts`).
 * - The substitution had, in any case, been mischaracterised as *silent*: see
 *   {@link RemoteExecOptions.shell}. dash refuses `set -o pipefail` outright and
 *   exits 2 at line one.
 *
 * The residual is a maintenance constraint rather than a defect, and it is why
 * this paragraph exists: the transport shell now depends on whether the operator
 * set a variable, so a bashism added to a clone, a patch or a builder later
 * breaks *only* the builds that carry an environment. `sh` is kept rather than
 * `shell: 'bash'` because `sh` is the shell guaranteed to be there — a minimal
 * host need not have bash at all — and because the local branch has always run
 * these same programs under it: `execAsync` is `promisify(exec)`, which spawns
 * `/bin/sh -c`, so every single-server install ran every builder under `sh` long
 * before the remote one did the same. `test/builders/build-env.spec.ts`
 * runs the shipped programs through that branch, which is the standing check.
 *
 * **2. The local branch's replacing `env` — handled, at the caller, by a
 * spread.** `ExecOptions.env` really does replace rather than extend, measured:
 * `exec('nixpacks build …', { env: { CG_BUILD_ENV_0: … } })` dies with
 * `/bin/sh: nixpacks: command not found` because `PATH` went with the rest of
 * the environment, while the same call with `{ ...process.env, ...env }` runs.
 * So `DeploymentEngineService.exec` spreads — `destinations/rclone-exec.ts` is
 * the precedent verbatim — and `test/deployment-engine/…` pins
 * `options.env.PATH` against `process.env.PATH` so a future caller that forgets
 * fails a test rather than a deploy. There is no counterpart on this branch:
 * these `export` lines are *prepended* to the command, so whatever environment
 * sshd hands the shell survives, and the substitution changes which shell reads
 * the script and nothing about what is in its environment.
 *
 * **3. The one cost that is real is stdin**, and it is the paragraph on
 * {@link DEFAULT_REMOTE_ENV_SHELL} rather than a third hazard here. One
 * refinement from the same measurement: a stdin-reading command consumes the
 * script text that *follows* it, so the truncation is reachable only when
 * something is still unread — bash parses a compound command whole, so a `cat`
 * inside a subshell that is the last thing in the script finds nothing left to
 * eat, which is the shape the deploy composes today. `< /dev/null` on that
 * subshell is what keeps this true of a program somebody appends a step to.
 */
const buildEnvScript = (
  env: Record<string, string>,
  command: string,
): string => {
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!ENV_NAME.test(name)) {
      throw new ExecError(`Invalid environment variable name: ${name}`, {
        command,
      });
    }
    return `export ${name}=${shellQuote(value)}\n`;
  });
  return `${assignments.join('')}${command}\n`;
};

/**
 * What a program stopped through its abort signal rejects with. The
 * message is fixed text: the program itself is on `command`, as for every other
 * failure, and a caller that asked for the stop knows why it happened.
 */
const cancelledError = (
  command: string,
  details: Omit<ConstructorParameters<typeof ExecError>[1], 'command'> = {},
): ExecError =>
  new ExecError('Command cancelled: it was stopped before it finished', {
    command,
    ...details,
  });

/**
 * The line a signalled remote program writes to stderr before anything else:
 * its process group, which is the shell sshd started for it. OpenSSH's
 * `do_exec_no_pty` calls `setsid()` in the child before it
 * execs the shell, so the shell leads a session of its own and everything the
 * program starts — a subshell, `git`, `git-remote-http`, a builder — shares its
 * group unless it leaves on purpose. One `kill -s KILL -- -<pgid>` on a second
 * channel therefore stops the whole program, where closing the channel alone
 * would not: without a pty nothing is hung up, and a build's output goes to its
 * log file rather than the channel, so it would never even see a broken pipe.
 */
const PGID_ANNOUNCEMENT = 'cg-pgid:';
/**
 * The group is read with `ps` rather than taken as `$$`: with an environment
 * the program is `sh -s` under the user's login shell, and `$$` is the group
 * only when that shell execs its one command instead of forking it — which
 * bash does and other login shells need not. Where `ps` is missing, `$$` is
 * still the right answer for the common case.
 */
const announcingPgid = (command: string): string =>
  `cg_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')"; printf '${PGID_ANNOUNCEMENT}%s\\n' "\${cg_pgid:-$$}" >&2; unset cg_pgid\n${command}`;

/** `RemoteExecService.execAsync` with an abort signal or with its program on
 * stdin: see its docblock. A free function rather than a private method, so
 * the service stays structurally typed for the doubles every e2e suite
 * substitutes for it. */
function execSpawned(
  command: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const { signal, programOnStdin } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError(command));
      return;
    }
    let stdout = '';
    let stderr = '';

    // `exec`'s own spelling of the same spawn — `/bin/sh -c <command>` —
    // plus `detached`, which is what gives the program a group to kill. With
    // `programOnStdin` it is `/bin/sh -s`, and the program is written to it.
    const child = spawn(
      options.shell ?? '/bin/sh',
      programOnStdin ? ['-s'] : ['-c', command],
      {
        cwd: options.cwd,
        env: options.env,
        detached: signal !== undefined,
        stdio: [programOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      },
    );
    if (programOnStdin) {
      // A shell that exits early (`set -e`) closes its stdin under the
      // write; the exit status is the answer, not the EPIPE.
      child.stdin?.on('error', () => {});
      child.stdin?.end(command);
    }

    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ESRCH: the group finished between the abort and the kill.
      }
      reject(cancelledError(command, { stdout, stderr }));
    };
    signal?.addEventListener('abort', stop, { once: true });

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', stop);
      reject(
        new ExecError(`Command execution failed: ${error.message}`, {
          command,
          stdout,
          stderr,
          originalError: error,
        }),
      );
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      // Word for word what `promisify(exec)` rejects with and the
      // unsignalled branch wraps, so a failed build reads the same whichever
      // form ran it.
      reject(
        new ExecError(
          `Command execution failed: Command failed: ${command}\n${stderr}`,
          {
            command,
            stdout,
            stderr,
            exitCode: code ?? undefined,
          },
        ),
      );
    });
  });
}

@Injectable()
export class RemoteExecService {
  constructor(
    @Optional()
    @Inject(SERVER_KEY_PROVIDER)
    private readonly serverKeyProvider?: ServerKeyProvider,
  ) {}

  /**
   * A shell program on the platform host.
   *
   * **With a `signal` it can be stopped**. `promisify(exec)` cannot do
   * that usefully: its own `signal` kills the `/bin/sh` it spawned and nothing
   * under it, so a build's `git clone` or `docker build` would go on running,
   * reparented to init, while the Deployment read cancelled. So a signalled
   * program is spawned **detached** — the shell leads a process group of its
   * own, which everything the program starts inherits — and an abort sends
   * SIGKILL to that whole group and rejects at once, without waiting for the
   * pipes to drain. Otherwise it behaves as the unsignalled form does: the same
   * shell, stdout and stderr collected, and the same {@link ExecError} message
   * and fields on a non-zero exit. Its stdin is `/dev/null` rather than an
   * unused pipe; the one caller composes `< /dev/null` into its program anyway.
   *
   * **With `programOnStdin` the program is read off stdin**: the same
   * spawn as `/bin/sh -s`, not detached unless there is also a `signal`, so a
   * program past the kernel's 128 KiB cap on one argument still runs.
   */
  async execAsync(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (options?.signal || options?.programOnStdin) {
      return execSpawned(command, options);
    }
    try {
      const result = await execAsyncBase(command, options);
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: 0,
      };
    } catch (error) {
      // No instanceof Error check: child_process errors come from Node's
      // realm and fail instanceof against a sandboxed Error global (jest).
      const execError = error as Error & {
        code?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      throw new ExecError(
        `Command execution failed: ${execError?.message ?? String(error)}`,
        {
          command,
          stdout: execError?.stdout?.toString() ?? '',
          stderr: execError?.stderr?.toString() ?? '',
          exitCode:
            typeof execError?.code === 'number' ? execError.code : undefined,
          originalError: execError,
        },
      );
    }
  }

  /**
   * A single command as argv on the platform host — the local twin of
   * {@link execRemote}, and the one branch that really is shell-free:
   * `child_process.execFile` takes argv and spawns the program itself, so no
   * `/bin/sh -c` ever sees the words. `execAsync` is `promisify(exec)` and
   * always spawns one, which is why a single command with an interpolated value
   * belongs here instead.
   *
   * `cwd`/`env` are here rather than in a second local method beside this one
   * (§1.4): the sites migrating to argv need them, and this method already owns
   * the argv shape. Their semantics are `ExecOptions`' — an `env` *replaces* the
   * environment rather than extending it, exactly as it does for `execAsync`,
   * so a caller that wants `PATH` passes `PATH`.
   */
  execFileAsync(
    command: string,
    args: string[],
    options: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const child = execFile(command, args, {
        cwd: options.cwd,
        env: options.env,
      });

      if (options.input && child.stdin) {
        child.stdin.write(options.input);
        child.stdin.end();
      }

      child.stdout?.on('data', (data: Buffer | string) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer | string) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr, exitCode: 0 });
        } else {
          reject(
            new ExecError(`Command failed with exit code ${code}`, {
              command,
              stdout,
              stderr,
              exitCode: code ?? undefined,
            }),
          );
        }
      });

      child.on('error', (error) => {
        reject(
          new ExecError(`Command execution error: ${error.message}`, {
            command,
            stdout,
            stderr,
            originalError: error,
          }),
        );
      });
    });
  }

  /**
   * A single command as argv on a Server: the caller names the program and its
   * arguments, and **this service — not the caller — does the joining**.
   *
   * **The argv is an API guarantee, not a shell-free wire.** It is joined here
   * with `shell-quote`'s `quote()` and handed to {@link execAsyncRemote}, which
   * sends it as one string, because there is no other shape to send: RFC 4254
   * §6.5's `exec` request carries a single length-prefixed `string command`,
   * which sshd hands to the account's login shell. `ssh2` writes exactly that —
   * `SSH_MSG_CHANNEL_REQUEST`, the request type `"exec"`, then one string
   * (`ssh2/lib/protocol/Protocol.js:1280-1288`) — and `@types/ssh2` has no array
   * overload to pass argv through. Swapping the library changes nothing:
   * node-ssh wraps ssh2, and the protocol is the constraint, not the
   * implementation. **The remote shell always parses this string. That question
   * is closed; do not re-open it as a transport bug.**
   *
   * So what this buys is not "the shell never parses a string this code
   * assembled". It is that the string it parses was quoted at *one* site with
   * one test, rather than at every call site from memory — which is the failure
   * that shipped twice, both times a file path spliced into a trivial `cat`.
   * `shell-quote`'s correctness stays load-bearing; the caller's discipline does
   * not.
   *
   * Do not "simplify" the join to `argv.join(' ')`. That is the exact bug this
   * method exists to make unreachable, and
   * `test/remote/remote-exec.service.spec.ts` pins the joining against it.
   *
   * The local twin is {@link execFileAsync}, which really is shell-free. That
   * asymmetry is inherent rather than an oversight: only the remote branch has a
   * shell it cannot remove.
   *
   * For a shell *program* — a pipeline, `&&`, a redirect, `set -e`, an inline
   * `$(…)` — there is no argv to pass: use {@link execAsyncRemote} with a string
   * and quote the interpolations at the builder (CODING_STANDARDS.md §2.9).
   */
  execRemote(
    serverId: string,
    argv: string[],
    onData?: (data: string) => void,
    options?: RemoteExecOptions,
  ): Promise<ExecResult> {
    return this.execAsyncRemote(serverId, quote(argv), onData, options);
  }

  async execAsyncRemote(
    serverId: string,
    command: string,
    onData?: (data: string) => void,
    options?: RemoteExecOptions,
  ): Promise<ExecResult> {
    if (!this.serverKeyProvider) {
      throw new ExecError(
        'No ServerKeyProvider registered; cannot resolve SSH connection details',
        { command, serverId },
      );
    }

    // With a signal the program first announces its process group, so an
    // abort has something to kill (see `PGID_ANNOUNCEMENT`). Only a signalled
    // program carries the line: every other caller's request is unchanged.
    const signal = options?.signal;
    if (signal?.aborted) throw cancelledError(command, { serverId });
    const program = signal ? announcingPgid(command) : command;

    // With an environment the command is fed to `sh -s` over the channel; with
    // none it is the request itself, exactly as every other caller sends it.
    // With `programOnStdin` it is fed the same way, with no assignments.
    const env = options?.env ?? {};
    const script =
      Object.keys(env).length > 0 || options?.programOnStdin
        ? buildEnvScript(env, program)
        : undefined;
    const request =
      script === undefined
        ? program
        : `${options?.shell ?? DEFAULT_REMOTE_ENV_SHELL} -s`;

    const connection = await this.serverKeyProvider.getConnection(serverId);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const conn = new Client();
      // A tunnel's session ends with the connection that ran inside it.
      conn.once('close', () => connection.sock?.destroy());

      // `pgid` is the session the program runs in, once it has said so;
      // `stopRequested` is an abort that came before it did. Either order ends
      // in one kill on a channel of its own, and then the connection closes.
      let pgid: number | undefined;
      let channelOpen = false;
      let stopRequested = false;
      let killSent = false;
      const killSession = () => {
        if (killSent || pgid === undefined) return;
        killSent = true;
        const giveUp = setTimeout(() => conn.end(), 10_000);
        giveUp.unref();
        conn.exec(
          `kill -s KILL -- -${pgid}`,
          (err: Error | undefined, killChannel: ClientChannel) => {
            if (err) {
              conn.end();
              return;
            }
            killChannel.on('close', () => conn.end()).resume();
          },
        );
      };
      const stop = () => {
        stopRequested = true;
        reject(cancelledError(command, { stdout, stderr, serverId }));
        if (pgid !== undefined) {
          killSession();
          return;
        }
        // No program running yet: ending the connection keeps one from
        // starting. One running but not yet announced is killed when its line
        // arrives (`takeAnnouncement`), and a program that never announces is
        // left to the connection closing.
        if (!channelOpen) conn.end();
        setTimeout(() => {
          if (!killSent) conn.end();
        }, 10_000).unref();
      };
      signal?.addEventListener('abort', stop, { once: true });
      const settled = () => signal?.removeEventListener('abort', stop);

      // Node's `exec` kills a program whose output outgrows
      // `maxBuffer`; ssh2 collects without limit, so the cap is ours: past it
      // the connection is closed and the call rejects with Node's own error.
      const maxBuffer = options?.maxBuffer ?? Number.POSITIVE_INFINITY;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let overflowed = false;
      const overflow = (stream: 'stdout' | 'stderr') => {
        overflowed = true;
        settled();
        reject(
          new ExecError(`Remote command ${stream} exceeded maxBuffer`, {
            command,
            stdout,
            stderr,
            serverId,
            originalError: maxBufferError(stream),
          }),
        );
        conn.end();
      };

      // The announcement is the first line of stderr and nothing else's
      // business: it is taken off before any chunk reaches `onData` (the
      // Deployment log) or the error. Until the first newline arrives the
      // chunks are held, since the line can be split across two.
      let announcementPending = signal !== undefined;
      let held = '';
      const takeAnnouncement = (chunk: string): string => {
        if (!announcementPending) return chunk;
        held += chunk;
        const newline = held.indexOf('\n');
        if (newline === -1) return '';
        announcementPending = false;
        const [first, rest] = [held.slice(0, newline), held.slice(newline + 1)];
        held = '';
        const pid = first.startsWith(PGID_ANNOUNCEMENT)
          ? Number(first.slice(PGID_ANNOUNCEMENT.length))
          : NaN;
        if (!Number.isInteger(pid) || pid <= 1) return `${first}\n${rest}`;
        pgid = pid;
        if (stopRequested) killSession();
        return rest;
      };

      conn
        .once('ready', () => {
          if (stopRequested) {
            conn.end();
            return;
          }
          conn.exec(
            request,
            (err: Error | undefined, stream: ClientChannel) => {
              if (err) {
                settled();
                onData?.(err.message);
                reject(
                  new ExecError(
                    `Remote command execution failed: ${err.message}`,
                    {
                      command,
                      serverId,
                      originalError: err,
                      connectionFailed: true,
                    },
                  ),
                );
                return;
              }
              channelOpen = true;
              stream
                .on('close', (code: number) => {
                  settled();
                  // A stopped program's connection ends after its kill.
                  if (!killSent) conn.end();
                  if (code === 0) {
                    resolve({ stdout, stderr, exitCode: 0 });
                  } else {
                    reject(
                      new ExecError(
                        `Remote command failed with exit code ${code}`,
                        { command, stdout, stderr, exitCode: code, serverId },
                      ),
                    );
                  }
                })
                .on('data', (data: Buffer | string) => {
                  if (overflowed) return;
                  const chunk = data.toString();
                  stdout += chunk;
                  onData?.(chunk);
                  stdoutBytes += Buffer.byteLength(chunk);
                  if (stdoutBytes > maxBuffer) overflow('stdout');
                })
                .stderr.on('data', (data: Buffer | string) => {
                  if (overflowed) return;
                  const chunk = takeAnnouncement(data.toString());
                  if (!chunk) return;
                  stderr += chunk;
                  onData?.(chunk);
                  stderrBytes += Buffer.byteLength(chunk);
                  if (stderrBytes > maxBuffer) overflow('stderr');
                });

              if (script !== undefined) stream.end(script);
            },
          );
        })
        .on('error', (err: Error & { level?: string }) => {
          settled();
          conn.end();
          // A refused host key is the domain's refusal, not a transport
          // failure: the Server answered, and it was the wrong machine.
          const refusal = sshFailure(connection, err);
          if (refusal !== err) {
            onData?.(refusal.message);
            reject(refusal);
            return;
          }
          if (err.level === 'client-authentication') {
            const message =
              `Authentication failed: the SSH key was not accepted by the server. ` +
              `Check that the server's SSH key matches one in ~/.ssh/authorized_keys on the host. ` +
              `(${err.message})`;
            onData?.(message);
            reject(
              new ExecError(message, {
                command,
                serverId,
                originalError: err,
                connectionFailed: true,
              }),
            );
          } else {
            const message = `SSH connection error: ${err.message}`;
            onData?.(message);
            reject(
              new ExecError(message, {
                command,
                serverId,
                originalError: err,
                connectionFailed: true,
              }),
            );
          }
        })
        .connect(sshConnectConfig(connection));
    });
  }
}
