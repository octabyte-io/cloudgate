import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { quote } from 'shell-quote';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { CronRunMark } from '../cron-services/cron-run.types';
import { deploymentLogsDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import type { DeploymentParent } from '../deployment-engine/ports/deployment-recorder';
import { parentColumns } from '../deployment-engine/ports/deployment-recorder';
import { deployment } from '../deployments/deployment.schema';
import { RemoteExecService } from '../remote/remote-exec.service';

interface RunStartFields {
  /** Names the run's log directory under the run host's logs directory. */
  appName: string;
  /** Where the log file is initialized — the server that runs the backup. */
  serverId: string | null;
  title: string;
  description: string;
  /** First line written into the fresh log file. */
  initMessage: string;
  /**
   * When the run started, if not now: a Cron service's run is held to its
   * `timeout` from here, read on the Cron service clock.
   */
  startedAt?: Date;
}

/**
 * What a run is recorded with. A backup's, volume backup's or schedule's run
 * names its record and nothing more; a Cron service's run (ADR-0034)
 * hangs off the Cron service's `application` arm and **must** carry the
 * {@link CronRunMark} that says it is a run, since a row on that arm without
 * one is a Build deployment.
 */
export type BackupRunStartOptions = RunStartFields &
  (
    | {
        /** Which backup, volume backup or schedule the run belongs to. */
        parent: Exclude<RunRecordParent, { kind: 'application' }>;
        cronRun?: never;
      }
    | {
        /** The Cron service the run belongs to. */
        parent: Extract<RunRecordParent, { kind: 'application' }>;
        cronRun: CronRunMark;
      }
  );

/**
 * Which record this run hangs off — the three {@link DeploymentParent} arms
 * that are a *run* rather than a build (ADR-0017).
 *
 * **This was a second spelling of the same vocabulary and is now the same
 * one.** The field used to be `fk: { backupId } | { volumeBackupId } |
 * { scheduleId }`, spread straight into `.values()`. That was not a defect —
 * the arms were already exclusive, already internal, and no DTO reached it —
 * but it was the other half of the "one vocabulary": `DeploymentParent`
 * covers all five parents of a `deployment` row plus the parentless one, and a
 * sixth kind added there would have left this declaration untouched with
 * nothing linking the two. ADR-0017 recorded the adoption as worth doing and
 * out of that change's blast radius, `deployment-recorder.ts`' own docblock names
 * this service as the writer of the three run-record arms, and this is that
 * change.
 *
 * **`Extract` rather than the whole union, which is what makes this an
 * adoption and not a widening.** `create` on the port takes the two *buildable*
 * arms for its own reason — it names a log directory after a service's
 * `appName` — and this writer takes the complementary three. `application` and
 * `compose` are refused here because a build record is `DeploymentsService`'
 * to write, and `none` because this method's whole job is to record a run of
 * something. A sixth parent kind therefore has to be classified: it either
 * appears in this `Extract` or it does not, and `parentColumns` will not
 * compile until it is handled at all (`TS2366`).
 *
 * **Amended by ADR-0034: `application` is now here too**, for a run
 * of a Cron service, which hangs off the Cron service itself. So the
 * `application` arm is shared with the engine's `create`, and the two are
 * told apart by the row, not the column: a row this writes on it carries a
 * `cronRun` mark ({@link BackupRunStartOptions} will not compile without
 * one), and `create`'s input has no field to write one.
 *
 * **Importing the port here points no dependency backwards**, which is the one
 * thing that could have made this the wrong move. `deployment-recorder.ts`
 * imports nothing at all — deliberately, so every writer of a `deployment` row
 * can reach it (ADR-0017) — and this file already imports
 * `deployment-engine/deployment-engine.paths` for `deploymentLogsDirectoryOn`. The
 * alternative, deriving a local type from the port's kinds instead of using
 * it, would have kept a second name for the same thing and left
 * {@link parentColumns} unreachable, which is the half that actually enforces
 * exhaustiveness.
 */
export type RunRecordParent = Extract<
  DeploymentParent,
  { kind: 'backup' | 'volumeBackup' | 'schedule' | 'application' }
>;

/**
 * Shared by database backups, volume backups (Phase 36 extraction from
 * BackupsService), user schedules (Phase 37) and Cron services' runs
 * a run is recorded as a
 * deployment row that starts running and ends done or error, with its log
 * file initialized on the server that runs it. Volume-backup logs live under
 * the logs directory with every other run log, not in the tarball staging
 * directory.
 */
@Injectable()
export class BackupRunRecorderService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
  ) {}

  /**
   * Records the run and initializes its log file.
   *
   * **Every word carrying a value is `quote()`d, and that is the defence.**
   * The `mkdir -p` word and the redirect target were bare until the quoting fix was
   * reopened at the sibling sink in `docker/docker.utils.ts` (H-12) — the same
   * `mkdir -p ${…}; echo "…" >> ${…}` shape, in a string handed straight to
   * `RemoteExecService`, where a `;` in either word ends the command and what
   * follows is a second one the run host executes as itself.
   *
   * What made this one *not* exploitable was `appName`: every value that
   * reaches it is either `generateAppName`'s `backup-`/`volume-backup-`/
   * `schedule-` plus six characters of a lowercase alphabet, or a name held to
   * `APP_NAME_REGEX` at its mint (`db/columns.ts`'s `cleanAppName`) — checked,
   * and true today. It is also a charset three modules and a table away from
   * this word, which is exactly the shape that failed twice at
   * `getCreateFileCommand`: a charset is only right for the context it was
   * written for, and nothing here links the two. So the quoting is the defence
   * and the regex stands behind it, per `builders/build-strategy.ts`.
   *
   * `initMessage` is quoted for the same reason and not because it is
   * doubtful — its three callers pass literals. A word that happens to be
   * safe and a word that is *made* safe read identically at the next edit, and
   * that is how the previous two failures were introduced.
   *
   * `quote()` rather than the `"…"` H-12 used: that sink has
   * `assertShellSafePath` refusing `$` and a backtick in front of it, and this
   * one has nothing, so double quotes would leave a substitution live.
   */
  async start(
    options: BackupRunStartOptions,
  ): Promise<{ deploymentId: string; logPath: string }> {
    const deploymentId = nanoid();
    // The log is created on the server that runs the backup, so its root is
    // that host's tree — /etc/cloudgate on a Server, this instance's
    // CLOUDGATE_DIRECTORY when the backup runs here.
    // The one expression `reclaimDeploymentLogs` removes on delete.
    const directory = deploymentLogsDirectoryOn(
      options.serverId,
      options.appName,
    );
    const logPath = `${directory}/${deploymentId}.log`;
    const command = `mkdir -p ${quote([directory])}; echo ${quote([options.initMessage])} >> ${quote([logPath])};`;
    if (options.serverId) {
      await this.remoteExec.execAsyncRemote(options.serverId, command);
    } else {
      await this.remoteExec.execAsync(command);
    }

    const [created] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        // The one place a parent becomes columns, shared with
        // `DeploymentsService.create` (ADR-0017) rather than spread from a
        // shape of this file's own.
        ...parentColumns(options.parent),
        // What makes a row on the `application` arm a run (ADR-0034).
        cronRun: options.cronRun ?? null,
        title: options.title,
        description: options.description,
        status: 'running',
        logPath,
        startedAt: (options.startedAt ?? new Date()).toISOString(),
      })
      .returning();
    return { deploymentId: created.deploymentId, logPath: created.logPath };
  }

  async finish(deploymentId: string, status: 'done' | 'error'): Promise<void> {
    await this.db
      .update(deployment)
      .set({ status, finishedAt: new Date().toISOString() })
      .where(eq(deployment.deploymentId, deploymentId));
  }

  /**
   * {@link finish}, only while the run is still `running`, answering whether
   * this call settled it: the first settle wins, so a run already ended
   * another way (a timeout, a cancel) keeps that ending. A Cron
   * service's run cancelled, stopped by a Stop or ended by a Delete settles
   * `cancelled`.
   */
  async settle(
    deploymentId: string,
    status: 'done' | 'error' | 'cancelled',
  ): Promise<boolean> {
    const settled = await this.db
      .update(deployment)
      .set({ status, finishedAt: new Date().toISOString() })
      .where(
        and(
          eq(deployment.deploymentId, deploymentId),
          eq(deployment.status, 'running'),
        ),
      )
      .returning({ deploymentId: deployment.deploymentId });
    return settled.length > 0;
  }
}
