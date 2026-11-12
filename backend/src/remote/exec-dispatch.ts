import type { ExecResult, RemoteExecService } from './remote-exec.service';

/**
 * The local-or-remote dispatch every module's ops helper does, in one place, for
 * both command shapes.
 *
 * The fork was already written five times — `docker-ops/server-access.ts`,
 * `docker-ops.service.ts`, `applications/application-ops.ts`,
 * `databases/common/database-ops.ts`, `common/service-cascade.ts` — as
 * `serverId ? execAsyncRemote : execAsync`. Argv doubles it to four arms, and
 * five copies of a four-arm fork is where they drift, so it lives here and the
 * five keep only their own vocabulary (which result field they project, and what
 * the commands mean).
 *
 * **Which shape to pass, and why the two are not interchangeable:**
 *
 * - **`string[]` — one program and its arguments.** Locally this is
 *   `execFileAsync`, genuinely shell-free: no `/bin/sh -c` sees the words.
 *   Remotely it is `execRemote`, which joins with `quote()` because the SSH
 *   transport has no argv to carry — see that method's own note, which cites the
 *   RFC. Either way the caller does not quote, and a value carrying `$(id)` is
 *   one inert word.
 * - **`string` — a shell *program*.** A pipeline, `&&`/`||`, a redirect,
 *   `set -e`, an inline `$(…)`. There is no argv for that, so it goes to
 *   `execAsync`/`execAsyncRemote` unchanged and **every interpolation in it is
 *   the builder's to `quote()`** (CODING_STANDARDS.md §2.9). The presence probes
 *   in `application-ops.ts` and `database-ops.ts` are the canonical examples:
 *   the `if ! docker version …; then echo unknown; elif …` program
 *   `common/workload-presence.ts`'s `presenceProbeCommand` builds for them *is*
 *   the contract, and it has to be a program because the three answers are
 *   separated by branches rather than by an exit code (H-95).
 *
 * Deliberately not a method on `RemoteExecService`: the service is the seam every
 * e2e test replaces with a double, and a dispatch living on it would have to be
 * re-implemented in each double. As a free function it is the real code in tests
 * too, calling whichever doubled method the branch picks.
 */
export function execOnServer(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
  command: string[],
): Promise<ExecResult>;
export function execOnServer(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
  command: string,
  options?: ShellProgramOptions,
): Promise<ExecResult>;
export function execOnServer(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
  command: string | string[],
): Promise<ExecResult>;
export function execOnServer(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
  command: string | string[],
  options: ShellProgramOptions = {},
): Promise<ExecResult> {
  if (Array.isArray(command)) {
    return serverId
      ? remoteExec.execRemote(serverId, command)
      : remoteExec.execFileAsync(command[0], command.slice(1));
  }
  const { maxBuffer, programOnStdin, signal } = options;
  const env =
    options.env && Object.keys(options.env).length > 0 ? options.env : null;
  if (maxBuffer === undefined && !programOnStdin && !env && !signal) {
    return serverId
      ? remoteExec.execAsyncRemote(serverId, command)
      : remoteExec.execAsync(command);
  }
  const named = {
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
    ...(programOnStdin ? { programOnStdin } : {}),
    ...(signal ? { signal } : {}),
  };
  // `ExecOptions.env` *replaces* the child's environment, so locally the
  // program's variables are laid over this process's own: a two-variable
  // environment would otherwise run with whatever `PATH` the shell falls back
  // to rather than the account's (`destinations/rclone-exec.ts`'s reason).
  return serverId
    ? remoteExec.execAsyncRemote(
        serverId,
        command,
        undefined,
        env ? { env, ...named } : named,
      )
    : remoteExec.execAsync(
        command,
        env ? { env: { ...process.env, ...env }, ...named } : named,
      );
}

/**
 * What a shell program's run may bound, on either machine. A caller that
 * names nothing is asked exactly as a two-argument exec is.
 */
export interface ShellProgramOptions {
  /**
   * The most bytes of output it may answer; past it the call rejects with an
   * `ExecError` that `isMaxBufferExceeded` recognizes. Stated for both
   * branches because the SSH branch has no cap of its own.
   */
  readonly maxBuffer?: number;
  /**
   * The program is read off the shell's stdin instead of being its `-c`
   * argument, on either machine: Linux caps one argument at 128 KiB
   * (MAX_ARG_STRLEN), and a program that carries data — an uploaded tree —
   * outgrows it. Nothing inside such a program may read stdin.
   */
  readonly programOnStdin?: boolean;
  /**
   * Variables the program reads instead of carrying them on its command
   * line, where any user on the machine could read them out of `ps`. Remotely
   * they make the program travel on `sh -s`'s stdin (see
   * `RemoteExecService.buildEnvScript`); locally they extend this process's
   * environment. An empty one is no environment, so the program keeps the
   * transport it had without one.
   */
  readonly env?: Record<string, string>;
  /**
   * Aborting it stops the program, on either machine, and the call rejects
   * at once (a Deployment's cancel).
   */
  readonly signal?: AbortSignal;
}

/**
 * `execOnServer`, projected to stdout — what every ops helper actually wants.
 *
 * `application-ops.ts`, `database-ops.ts` and `common/service-cascade.ts` each
 * kept this one-line projection privately. The dispatch itself stopped being
 * copied when `execOnServer` landed, but three copies of `(await …).stdout`
 * outlived the reason for them: the headers' argument is that an Application
 * must not depend on the databases module to be startable, and all three
 * already import *this* module, so the projection living here costs none of them
 * a dependency on another feature (§1.4).
 */
export async function execOnServerStdout(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
  command: string | string[],
): Promise<string> {
  return (await execOnServer(remoteExec, serverId, command)).stdout;
}
