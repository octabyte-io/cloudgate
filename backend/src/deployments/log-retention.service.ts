import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { notRetired } from '../bought-servers/retired-servers';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { logsDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { execOnServerStdout } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { server } from '../servers/server.schema';
import { logRetentionSweepCommand } from './log-retention';

/**
 * When the sweep runs.
 *
 * Daily, at a minute of its own: `LogCleanupService` rotates Traefik's access
 * log at `0 0 * * *` and `DockerCleanupService` prunes at `50 23 * * *`, and
 * this reaches **every Server** rather than one machine — so sharing a minute
 * with either would stack an unreachable Server's SSH connect timeouts on top
 * of another sweep's. Off-peak for the same reason every one of the three is.
 */
export const DEPLOYMENT_LOG_RETENTION_CRON = '20 4 * * *';

const RETENTION_JOB_NAME = 'deployment-log-retention';

/**
 * The cron that bounds every Server's deployment-log tree (ADR-0020).
 *
 * **Why a cron here rather than a step in a delete.** `log-retention.ts` states
 * the whole argument; the short of it is that a deployment log is stranded from
 * birth rather than by any cascade — nothing in the product had ever deleted
 * one — so the question is *how long is a log worth keeping* rather than *who
 * removes it when its row goes*, and a delete-time reclamation would make "how
 * far back can I look?" mean "as far back as your oldest surviving
 * Application".
 *
 * **On the cron surface that already rotates the access log, but not in it.**
 * `SchedulingService` is the registry every recurring job in the product goes
 * through, and this uses it exactly as `LogCleanupService`,
 * `DockerCleanupService`, `MonitoringService` and the three row-driven
 * schedulers do. It is a provider of `DeploymentsModule` rather than of
 * `SettingsModule` because the artifact is a Deployment's log and the path is
 * `DeploymentsService`'s to derive; `settings/` owns the *platform host's own*
 * Traefik files, which is a different tree with a different owner.
 *
 * **One instance-wide job, not one per Server.** `DockerCleanupService`
 * registers a job per Server because each carries its own
 * `enableDockerCleanup` flag and its own notification target. Retention has
 * neither: the window is a constant, the tree is the platform's own on every
 * machine, and there is nothing per-Server to configure — so a job per Server
 * would be N crons that always agree, and a Server added at runtime would need
 * one registered for it. This enumerates `server` when it fires instead, which
 * is also what makes a Server added since boot swept on the next run.
 *
 * **Every Server, across every organization, and that is not a tenancy
 * hole.** The sweep is not a read and returns nothing an organization owns: it
 * names `*.log` files under this platform's own logs root by age and deletes
 * them, on machines this instance provisioned. There is no caller and no
 * `PermissionCtx` — it is housekeeping on the platform's own tree, in the same
 * sense as `DockerCleanupService`'s boot re-registration over every `server`
 * row.
 *
 * **Best effort per machine, and a failure is journalled rather than thrown.**
 * An unreachable Server must not stop the rest of the sweep, and nothing is
 * waiting on the answer — `SchedulingService` already swallows and logs a
 * throw out of a tick, but that would lose every machine after the first
 * failure, which on a busy install is the whole point of the run.
 */
@Injectable()
export class DeploymentLogRetentionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeploymentLogRetentionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
    private readonly scheduling: SchedulingService,
  ) {}

  /**
   * Registers the job at boot, tolerant of an un-migrated database —
   * `DockerCleanupService.onApplicationBootstrap`'s shape. Nothing here reads
   * the database, so the `try` guards the registry rather than a query, but a
   * boot that cannot arm housekeeping must still be a boot that starts.
   */
  onApplicationBootstrap(): void {
    try {
      this.scheduling.register(
        RETENTION_JOB_NAME,
        DEPLOYMENT_LOG_RETENTION_CRON,
        null,
        () => this.sweep(),
      );
    } catch (error) {
      this.logger.error('Deployment-log retention could not be armed', error);
    }
  }

  /**
   * One pass: the platform host, then every Server, each asked once.
   *
   * The platform host first and unconditionally, because it holds the logs of
   * every Application with no Server of its own — the default single-box
   * install, where `logsDirectoryOn(null)` is this instance's own
   * `CLOUDGATE_DIRECTORY` tree rather than the `/etc/cloudgate` literal every
   * Server uses.
   *
   * Sequential rather than concurrent, on `tearDownCascadeChildren`'s reason:
   * fanning out would open an SSH connection to every Server at once, nightly,
   * for work that nothing is waiting on.
   */
  async sweep(): Promise<void> {
    // A Deleting or Deleted Bought Server is not reached (spec #1387).
    const servers = await this.db.query.server.findMany({
      columns: { serverId: true },
      where: notRetired(this.db, server.serverId),
    });
    for (const serverId of [null, ...servers.map((row) => row.serverId)] as (
      string | null
    )[]) {
      await this.sweepOne(serverId);
    }
  }

  /**
   * One machine's tree.
   *
   * The command prints what it reaped before deleting it, so the journal line
   * is a count rather than a claim — a run that says nothing reaped nothing,
   * which is what makes an unexpectedly large number visible.
   */
  private async sweepOne(serverId: string | null): Promise<void> {
    const root = logsDirectoryOn(serverId);
    const machine = serverId ?? 'the platform host';
    try {
      const stdout = await execOnServerStdout(
        this.remoteExec,
        serverId,
        logRetentionSweepCommand(root),
      );
      const reaped = stdout.split('\n').filter((line) => line.trim()).length;
      if (reaped > 0) {
        this.logger.log(
          `Reaped ${reaped} deployment log(s) past retention under ${root} on ${machine}`,
        );
      }
    } catch (error) {
      // Journalled, never thrown: an unreachable Server must not stop the
      // machines after it, and a log tree that outlives one night is not a
      // failure anyone can act on tonight.
      this.logger.warn(
        `Could not sweep deployment logs under ${root} on ${machine}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
