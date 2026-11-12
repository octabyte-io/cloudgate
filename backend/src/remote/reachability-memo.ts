import { isConnectionFailure } from './exec-error';
import type { ExecError } from './exec-error';
import { RemoteExecService } from './remote-exec.service';
import type {
  ExecOptions,
  ExecResult,
  RemoteExecOptions,
} from './remote-exec.service';

/**
 * The exec layer as one Delete sees it: a Server it could not connect to once
 * is not dialled again for the rest of that Delete.
 *
 * **Why.** A Delete walks a dozen best-effort steps — the workload, the Traefik
 * config, the presence read, then the directory, the patch-repo clone, the
 * file mounts, the Trace store, the logs, the images — and each dialled SSH on
 * its own and spent its own connection attempt. Measured against a Server
 * whose SSH port refused at once, an unforced Delete answered its 409 after
 * 80 s and a forced one its 200 after ~200 s, against the console proxy's
 * 240 s; one more step, or a Server that drops packets rather than refusing,
 * and the operator gets a 5xx while the Delete carries on behind it.
 *
 * **What marks a Server: failing to connect, and nothing else.** The test is
 * {@link isConnectionFailure} — an `ExecError` that `RemoteExecService` marked
 * where the connection failed: the SSH client's `error` event (a refused or
 * timed-out connection, an unreachable host, a handshake or key that was not
 * accepted) or a channel the Server would not open. Not a missing exit code:
 * a program that outgrew `maxBuffer` or was killed by a signal has none
 * either, and both ran on a Server that answered. A command that exited
 * non-zero marks nothing, because the Server answered and the next step on it
 * may well succeed. A rejection that is not an `ExecError` marks nothing
 * either: it says nothing about the transport.
 *
 * **Every later call fails with the same error, without dialling**, so a step
 * aimed at a marked Server still throws, and a step that names what it leaves
 * still lands in the teardown report as an unreclaimed artifact. The presence
 * read reads it as `'unknown'`, which is the *could not reach Docker* 409
 * unforced — now without spending its own connection attempt.
 *
 * **The platform host is never marked.** Its commands are local processes, and
 * a local failure to spawn one says nothing about the next.
 *
 * **One per Delete, never shared.** A Delete constructs one and hands it to
 * every step in place of `RemoteExecService`; nothing keeps it afterwards, so
 * a Server that comes back is dialled normally by the next request. It is a
 * subclass so every helper that takes a `RemoteExecService` takes it unchanged,
 * and it overrides all four entry points so each reaches the wrapped service's
 * own — including `execRemote`, which the base class would otherwise route
 * through its own quoting.
 */
export class ReachabilityMemo extends RemoteExecService {
  private readonly unreachable = new Map<string, ExecError>();

  constructor(private readonly inner: RemoteExecService) {
    super();
  }

  /**
   * Runs `attempt` against `serverId` unless that Server is already marked,
   * and marks it if `attempt` fails to connect. For a call that reaches a
   * Server through another service's own `RemoteExecService` — the Traefik
   * writer's `removeConfig` — so it shares this Delete's memo.
   */
  async guard<T>(
    serverId: string | null | undefined,
    attempt: () => Promise<T>,
  ): Promise<T> {
    if (!serverId) return attempt();
    const known = this.unreachable.get(serverId);
    if (known) throw known;
    try {
      return await attempt();
    } catch (error) {
      if (isConnectionFailure(error)) this.unreachable.set(serverId, error);
      throw error;
    }
  }

  override execAsyncRemote(
    serverId: string,
    command: string,
    onData?: (data: string) => void,
    options?: RemoteExecOptions,
  ): Promise<ExecResult> {
    return this.guard(serverId, () =>
      this.inner.execAsyncRemote(serverId, command, onData, options),
    );
  }

  override execRemote(
    serverId: string,
    argv: string[],
    onData?: (data: string) => void,
    options?: RemoteExecOptions,
  ): Promise<ExecResult> {
    return this.guard(serverId, () =>
      this.inner.execRemote(serverId, argv, onData, options),
    );
  }

  override execAsync(
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return this.inner.execAsync(command, options);
  }

  override execFileAsync(
    command: string,
    args: string[],
    options?: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<ExecResult> {
    return this.inner.execFileAsync(command, args, options);
  }
}
