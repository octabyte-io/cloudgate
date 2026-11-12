import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { PermissionCtx } from '../rbac/permission.service';
import { ServersService } from './servers.service';

/** The two lines a client can key on. The setup script prints `✅` on lines of
 *  its own, so an outcome needs a prefix nothing else in the output uses. */
export const SETUP_FINISHED_LINE = '✅ Setup finished.';
export const SETUP_FAILED_PREFIX = '❌ Setup failed:';

/**
 * Chunks kept for a watcher that attaches late. A provisioning run emits a few
 * hundred lines; the cap is only here so a wedged run cannot grow without
 * bound, and dropping says so rather than silently shortening the log.
 */
const MAX_BUFFERED_CHUNKS = 5_000;

/** Someone following a run: a socket, as `/listen-server-setup` attaches one. */
export interface SetupRunWatcher {
  /** One chunk of output. */
  send(chunk: string): void;
  /** The run's last line, which says how it ended; the watcher is then dropped. */
  end(line: string, ok: boolean): void;
}

/** How a run ended, as it is stored on the Server too (`setupOk`, `setupMessage`). */
export interface SetupRunOutcome {
  ok: boolean;
  /** The failure in the run's own words; null when it finished. */
  message: string | null;
}

/** One provisioning run in flight, and everyone currently watching it. */
interface SetupRun {
  chunks: string[];
  dropped: number;
  watchers: Set<SetupRunWatcher>;
  ended: Promise<SetupRunOutcome>;
}

/**
 * The Setup runs in flight on this backend, one per Server: what
 * `/listen-server-setup` starts on a start-dial and attaches every other dial
 * to, and what starts a **Bought Server**'s first run by itself once its
 * machine answers (the amendment to ADR-0058).
 *
 * Kept out of the gateway for that second caller. Before, the gateway held
 * the only map of runs, so a run the backend started by itself would have
 * been invisible to it: the customer's watch-dial would have closed "not
 * running" on a run that was going, and a press of *Run setup* would have
 * provisioned the host a second time beside it. One map keeps both
 * invariants for both callers: one host provisions once at a time, and
 * anyone who opens the log attaches to the run in flight.
 *
 * **It decides nothing about who may start a run.** The gateway allows only
 * a start-dial (ADR-0058), and the Bought Server stages only the run Buy
 * pressed for; this only refuses to start a second run beside one in flight.
 *
 * In memory, so a backend restart ends every run: the run on the machine is
 * cut off with it, its outcome is never stored, and the Bought Server stages
 * read that from their own row (`setupStarts`).
 */
@Injectable()
export class ServerSetupRuns {
  private readonly logger = new Logger(ServerSetupRuns.name);

  /** Keyed by serverId: one host provisions once at a time. */
  private readonly runs = new Map<string, SetupRun>();

  /** Told each time a run ends, after it is off the map (`onRunEnded`). */
  private readonly endListeners = new Set<(serverId: string) => void>();

  // Forward: ServersService starts a Bought Server's deletion through the
  // stages, which start a first Setup run through this, so the three files
  // import each other.
  constructor(
    @Inject(forwardRef(() => ServersService))
    private readonly servers: ServersService,
  ) {}

  /** Whether a run on this Server is going now. */
  inFlight(serverId: string): boolean {
    return this.runs.has(serverId);
  }

  /**
   * Calls `listener` with the Server's id each time a run on it ends, either
   * way, once {@link inFlight} already says no and the outcome is stored on
   * the Server. For the get-started wizard's Apply (ADR-0073), which waits
   * for a Server to be set up and would otherwise only see it on its next
   * tick. A listener that throws is logged and never ends a run.
   */
  onRunEnded(listener: (serverId: string) => void): void {
    this.endListeners.add(listener);
  }

  /**
   * Starts a run on the Server unless one is in flight, and answers how the
   * run in flight (this one or the earlier) ends; it never rejects.
   * `started` says which. `ctx` is whose run it is: the Server is read in
   * that Organization, as `POST /servers/:id/setup` reads it.
   */
  start(
    serverId: string,
    ctx: PermissionCtx,
  ): { started: boolean; ended: Promise<SetupRunOutcome> } {
    const inFlight = this.runs.get(serverId);
    if (inFlight) return { started: false, ended: inFlight.ended };

    let settle!: (outcome: SetupRunOutcome) => void;
    const run: SetupRun = {
      chunks: [],
      dropped: 0,
      watchers: new Set(),
      ended: new Promise((resolve) => (settle = resolve)),
    };
    this.runs.set(serverId, run);
    void this.provision(serverId, ctx, run).then(settle);
    return { started: true, ended: run.ended };
  }

  /**
   * Puts a watcher on the run in flight: what it missed is replayed first,
   * then it follows. Answers how to take it off again, or null when no run
   * is in flight, and nothing is replayed.
   */
  watch(serverId: string, watcher: SetupRunWatcher): (() => void) | null {
    const run = this.runs.get(serverId);
    if (!run) return null;
    if (run.dropped > 0) {
      watcher.send(`… ${run.dropped} earlier lines are no longer buffered.\n`);
    }
    for (const chunk of run.chunks) watcher.send(chunk);
    run.watchers.add(watcher);
    return () => run.watchers.delete(watcher);
  }

  /** The run itself, detached from whoever started it or watches it. */
  private async provision(
    serverId: string,
    ctx: PermissionCtx,
    run: SetupRun,
  ): Promise<SetupRunOutcome> {
    try {
      await this.servers.setup(ctx, serverId, (chunk) => this.emit(run, chunk));
      this.finish(run, `\n${SETUP_FINISHED_LINE}\n`, true);
      return { ok: true, message: null };
    } catch (error) {
      const message =
        error instanceof Object && 'message' in error
          ? String((error as Error).message)
          : String(error);
      this.logger.error(`Setup failed on server ${serverId}: ${message}`);
      this.finish(run, `\n${SETUP_FAILED_PREFIX} ${message}\n`, false);
      return { ok: false, message };
    } finally {
      this.runs.delete(serverId);
      for (const listener of this.endListeners) {
        try {
          listener(serverId);
        } catch (error) {
          this.logger.error(
            `A listener on the end of setup on server ${serverId} failed: ${String(error)}`,
          );
        }
      }
    }
  }

  /** One chunk of output: buffered for late watchers, sent to present ones. */
  private emit(run: SetupRun, chunk: string): void {
    if (run.chunks.length >= MAX_BUFFERED_CHUNKS) {
      run.chunks.shift();
      run.dropped += 1;
    }
    run.chunks.push(chunk);
    for (const watcher of [...run.watchers]) watcher.send(chunk);
  }

  /** Say how the run ended to everyone watching it, then let them go. */
  private finish(run: SetupRun, line: string, ok: boolean): void {
    for (const watcher of [...run.watchers]) watcher.end(line, ok);
    run.watchers.clear();
  }
}
