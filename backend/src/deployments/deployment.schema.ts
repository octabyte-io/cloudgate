import { relations, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  jsonb,
  pgEnum,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import { backup } from '../backups/backup.schema';
import { bucket } from '../buckets/bucket.schema';
import { compose } from '../compose/compose.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import type { CronRunMark, CronTask } from '../cron-services/cron-run.types';
import type { CloudRunJob } from '../deployment-queue/cloud-run-job.types';
import type { ImageHealthCheck } from '../cloud-accounts/aws/definitions/container-health-check';
import type { DeploymentJob } from '../deployment-queue/job-types';
import { isoTimestamp, nanoidPk } from '../db/columns';
import { environmentNetwork } from '../environments/environment-network.schema';
import { previewDeployment } from '../preview-deployments/preview-deployment.schema';
import { plan } from '../project-config/project-config.schema';
import { schedule } from '../scheduling/schedules/schedule.schema';
import { volumeBackup } from '../volume-backups/volume-backup.schema';

// Phase 23 scope (compose columns arrived with Phase 29, backup with 35,
// schedule with 37): preview deployment, rollback and server-setup columns
// arrive with their phases. 'pending' exists because a record is written from
// the moment a deploy is queued, not only once the engine starts building.

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'pending',
  'running',
  'done',
  'error',
  'cancelled',
  // A build recorded and waiting on a plan, not queued: a push changed
  // both its Application's code and its own config entry. Released into
  // `pending` and queued by the plan's Apply (new settings), its dismiss or a
  // newer plan no longer changing it (old ones), or "build now".
  'held',
]);

export type DeploymentStatus = (typeof deploymentStatusEnum.enumValues)[number];

/**
 * No deployment record hangs off two owners at once, as a database fact
 * (on the `patch` and `domain` precedent).
 *
 * **`<=` and not `=`, and it is the whole decision here.** The precedent is
 * `(application_id IS NULL) <> (compose_id IS NULL)` — XOR — on `patch` and
 * `domain`, and this was first called "the third table with the same
 * two-column pair". It is not: `deployment` has **five** nullable parent
 * columns, and the sweep in `test/coding-standards/parent-id-writes.spec.ts`
 * only reports two of them because `backup`, `volume_backup` and `schedule`
 * are not service tables and so are not in `SERVICE_TABLES`. That XOR on this
 * table would have refused **every backup, volume-backup and schedule run
 * record in the product**: `BackupRunRecorderService.start` inserts with
 * `...parentColumns(options.parent)`, and its parent is one of
 * `DeploymentParent`'s three run-record arms — `backup`, `volumeBackup` or
 * `schedule` (and an untagged union of the same three shapes before it)
 * — so both of the columns the XOR names are null on every row it writes.
 *
 * **A parentless row stays storable, deliberately.** It is the one shape a
 * strict `num_nonnulls(…) = 1` would newly refuse, and it is not an
 * unreachable orphan the way the precedent's was — `ownerOf` in `service-scope.ts`
 * ends in `NotFoundException('Deployment not found')` for exactly this row,
 * `DeploymentsService.readLogs` answers 404 through it, and
 * `test/deployments/run-history.e2e-spec.ts` pins the behaviour with a row it
 * inserts by hand. The argument for XOR was that the orphan was neither
 * producible nor handled; here it is handled by name and under test, so the
 * same argument yields the weaker constraint. Making it unstorable would have
 * deleted a test that guards a live defensive branch, and closed no defect.
 *
 * What it does refuse is the shape that has no reader: two owners on one
 * record. `ownedServiceId()` coalesces the five columns and `ownerOf` tests
 * them, and a row setting two of them is listed under one service, titled
 * after another, and cascade-deleted by whichever owner goes first.
 *
 * **This is a backstop rather than the statement of the rule.**
 * `DeploymentsService.create` took `applicationId?`/`composeId?` as
 * independent optionals and coalesced both through to the insert, so a third
 * caller passing both turned this constraint into a 500 naming it —
 * unstorable, but still a shape the type admitted. The engine-facing input is
 * now a discriminated union with one arm per parent kind
 * (`deployment-engine/ports/deployment-recorder.ts`), so no value carries two
 * parents and the failure no longer reaches Postgres. What the `CHECK` still
 * holds is everything the type is not in front of: a migration, a fixture, a
 * hand-run `UPDATE`, and any writer added later — which is exactly the half
 * `test/coding-standards/parent-id-writes.spec.ts` cannot see, and the reason
 * this stays. The parent union also settled the ordering the paragraph above used to note
 * a disagreement in: the read side's order (application, compose, schedule,
 * volume backup, backup) is the product's one precedence, `create` no longer
 * spells one at all, and `ownerOf`'s docblock and ADR-0017 carry the argument.
 */
/** What a Build deployment's row keeps of its job: the arm and the type. */
export type QueuedAs = Pick<DeploymentJob, 'applicationType' | 'type'>;

/**
 * What a cloud row keeps of its run: the job, less the row's own id, and of
 * a Service's deploy the image it ran.
 */
export type CloudRunShape = Omit<CloudRunJob, 'deploymentId'> & {
  /**
   * A put-back's: the tag of the live image it runs on, building and
   * pushing nothing. A deploy that builds runs its own Deployment's id.
   */
  liveImage?: string;
  /** The image's CPU, recorded once the deploy has inspected it. */
  architecture?: 'amd64' | 'arm64';
  /**
   * The image's `HEALTHCHECK` on ECS, recorded with its CPU, `null`
   * for none; absent on a deploy from before it was read, which ran none.
   */
  healthCheck?: ImageHealthCheck | null;
  /**
   * A `static-rollback`'s: the rollback point's folder it switches
   * the distribution back to, kept on the row so a run start-up queues
   * again switches to the same one.
   */
  rollbackFolder?: string;
  /**
   * A Cron service's deploy on ECS: the task definition revision it
   * registered and the Cron service's security group, which every run
   * started after it is a task of, until the next deploy.
   */
  cronTask?: CronTask;
  /**
   * A Google network run for a static site's `spa` change: the
   * site's Service id, whose Domains' cache the run clears at its end, so a
   * run start-up queues again clears the same ones.
   */
  clearsCacheFor?: string;
  /**
   * The sentence the row ends with when a Cloudgate restart cuts the run
   * off, recorded by a run once it begins a change that a cut-off leaves
   * half-made: a Google static site's copy into `live/` writes
   * "the live site may have files from both versions …". Absent, it is
   * `CUT_OFF_BY_RESTART`.
   */
  cutOff?: string;
  /**
   * Handed off by the build slot (`CloudRunsService.handOff`): the deploy's
   * build has already run, so the run goes on to its end even if its
   * Organization is frozen while it waits. Kept on the row so a run
   * start-up queues again is let through alike.
   */
  afterBuild?: true;
};

export const deploymentAtMostOneParent = check(
  'deployment_at_most_one_parent',
  sql`num_nonnulls("application_id", "compose_id", "backup_id", "volume_backup_id", "schedule_id", "environment_network_id", "postgres_id", "mysql_id", "bucket_id", "redis_id") <= 1`,
);

/**
 * A row naming a preview qualifies an Application's build, so it has an
 * Application. `deployment_preview_belongs_to_its_application` is
 * `MATCH SIMPLE` and checks nothing while `application_id` is null, which is
 * the half this states.
 */
export const deploymentPreviewQualifiesAnApplication = check(
  'deployment_preview_qualifies_an_application',
  sql`"preview_deployment_id" IS NULL OR "application_id" IS NOT NULL`,
);

/**
 * A run of a Cron service hangs off the Cron service itself, an Application
 * (ADR-0034 amending ADR-0017), so only a row with an Application can
 * be marked as one.
 */
/**
 * A row's "for Service" column (S14, ADR-0017 amended) names the Service a
 * network Cloud run changes the Domain of, so only an Environment network's
 * run carries one.
 */
export const deploymentForServiceOnANetworkRun = check(
  'deployment_for_service_on_a_network_run',
  sql`"for_service_id" IS NULL OR "environment_network_id" IS NOT NULL`,
);

export const deploymentCronRunHasAnApplication = check(
  'deployment_cron_run_has_an_application',
  sql`"cron_run" IS NULL OR "application_id" IS NOT NULL`,
);

export const deployment = pgTable(
  'deployment',
  {
    deploymentId: nanoidPk('deployment_id'),
    title: text('title').notNull(),
    description: text('description'),
    status: deploymentStatusEnum('status').notNull().default('pending'),
    /** Absolute path (on the build server) the build output is appended to. */
    logPath: text('log_path').notNull(),
    /** At most one of applicationId/composeId/backupId/volumeBackupId/
     * scheduleId is set — a deployment record belongs to the service whose
     * build (or backup/schedule run) it tracks. Held by
     * {@link deploymentAtMostOneParent}, whose docblock says why "at most" and
     * not "exactly". */
    applicationId: text('application_id').references(
      () => application.applicationId,
      { onDelete: 'cascade' },
    ),
    composeId: text('compose_id').references(() => compose.composeId, {
      onDelete: 'cascade',
    }),
    backupId: text('backup_id').references(() => backup.backupId, {
      onDelete: 'cascade',
    }),
    volumeBackupId: text('volume_backup_id').references(
      () => volumeBackup.volumeBackupId,
      { onDelete: 'cascade' },
    ),
    scheduleId: text('schedule_id').references(() => schedule.scheduleId, {
      onDelete: 'cascade',
    }),
    /**
     * The Environment network whose Cloud run this records (ADR-0017
     * extended): its create, by the Apply that makes it, and later its
     * removal. The run logs on the platform host, where `tofu` runs.
     * Cascades like every parent: the network's row goes only once its AWS
     * resources have (ADR-0038).
     */
    environmentNetworkId: text('environment_network_id').references(
      () => environmentNetwork.environmentNetworkId,
      { onDelete: 'cascade' },
    ),
    /**
     * The postgres on RDS whose Cloud run this records (ADR-0017
     * extended): its create by an Apply, and later its changes and Delete.
     * A database has no build, so this is its only kind of row. The run
     * logs on the platform host, where `tofu` runs.
     */
    postgresId: text('postgres_id').references(() => postgres.postgresId, {
      onDelete: 'cascade',
    }),
    /**
     * The mysql on RDS whose Cloud run this records (ADR-0017
     * extended as for a postgres on RDS): its create and changes by an
     * Apply, and its Delete.
     */
    mysqlId: text('mysql_id').references(() => mysql.mysqlId, {
      onDelete: 'cascade',
    }),
    /**
     * The bucket on AWS whose Cloud run this records (ADR-0017
     * extended), as {@link postgresId} is a postgres on RDS's: its create by
     * an Apply, and the Apply of a CORS change or a Drift put back. A bucket
     * builds nothing; the run logs on the platform host.
     */
    bucketId: text('bucket_id').references(() => bucket.bucketId, {
      onDelete: 'cascade',
    }),
    /**
     * The redis on ElastiCache whose Cloud run this records (ADR-0017
     * extended as for a postgres on RDS): its create by an Apply.
     */
    redisId: text('redis_id').references(() => redis.redisId, {
      onDelete: 'cascade',
    }),
    /**
     * The Preview deployment this build built, when it built one.
     * It **qualifies** an `application`-parented row and is not a
     * sixth parent: the row stays in its Application's history under
     * {@link deploymentAtMostOneParent}'s five columns, and ADR-0017 is
     * unamended. `ON DELETE SET NULL`, because the history outlives the
     * running copy: a torn-down preview's builds read as any other
     * build of the parent.
     *
     * Set only beside that preview's own parent, and the database holds that
     * rather than the writers: the composite key
     * `deployment_preview_belongs_to_its_application` refuses a preview of
     * another Application, and {@link deploymentPreviewQualifiesAnApplication}
     * refuses a row with no Application.
     */
    previewDeploymentId: text('preview_deployment_id').references(
      () => previewDeployment.previewDeploymentId,
      { onDelete: 'set null' },
    ),
    /**
     * The plan a build was held for (US51): set when a push records the
     * build `held`, moved to a newer plan that still changes the Application,
     * and **kept once the build is released**, so the plan goes on naming the
     * builds it governed. Not a parent (ADR-0017): the row stays in its
     * Application's history. `set null` with the plan.
     */
    heldByPlanId: text('held_by_plan_id').references(() => plan.planId, {
      onDelete: 'set null',
    }),
    /**
     * The plan a cloud Service's deploy stopped on (spec
     * "Auto-apply rule"): a deploy no Apply queued that met more than a new
     * image ends `error`, and its whole plan becomes the Environment's open
     * plan, named here so the Deployment links to it ("Review the open plan
     * →") and the plan back to the Deployment. Not a parent (ADR-0017); `set
     * null` with the plan.
     */
    reviewPlanId: text('review_plan_id').references(() => plan.planId, {
      onDelete: 'set null',
    }),
    /**
     * **For Service** (spec S14): the Service whose Domain
     * an Environment network's Cloud run adds, changes or removes on Google
     * Cloud, where every Domain is a rule on the network. The run's parent
     * stays the network (ADR-0017, amended); this only lists it on the
     * Service too. Not a parent; `set null` with the Service, whose Delete
     * leaves the network's history as it is.
     */
    forServiceId: text('for_service_id').references(
      () => application.applicationId,
      { onDelete: 'set null' },
    ),
    /**
     * Set on a row recording a **Cloud run**: the run's shape, from the
     * moment it is submitted to the Cloud run pool. It is what makes a row a
     * cloud row for start-up — `pending` is queued again from it, `running` is
     * settled `error` — and for Cancel and Stop the run. Not a parent
     * (ADR-0017); null on every build and scheduled run.
     */
    cloudRun: jsonb('cloud_run').$type<CloudRunShape>(),
    /**
     * Set on a **Run record** of a Cron service (ADR-0034): the row's
     * parent is the Cron service's `application` arm, as its Build
     * deployments' is, and this is what says it is a run and not a build —
     * its Swarm job, the image it started from and who started it. Written
     * only by the run recorder; the engine's `create` never writes it. Not a
     * parent (ADR-0017); null on every build.
     */
    cronRun: jsonb('cron_run').$type<CronRunMark>(),
    /**
     * Set on a Cron service's Build deployment once it succeeds
     * (ADR-0034): the image its runs start from, pinned to this build — a tag
     * of its own, or the registry's digest — so a later build that fails
     * after moving `:latest`, or an image source's tag moving upstream, never
     * changes what a run starts from. Null on every other row, and on a Cron
     * service's builds from before the column, whose runs start from the
     * Service's image name.
     */
    cronImage: text('cron_image'),
    /**
     * The job a **Build deployment** was queued as: its arm and its
     * `type`, written by the trigger that records the build. It is what proves
     * to start-up that a `pending` row is a build and which one, so it is
     * queued again as exactly that. Nothing else on the row can: the preview
     * link is `set null` with its preview, which would read a preview's build
     * as a production one; a cloud row is `pending` under its Service before
     * its `cloud_run` is set; and the title is whatever the caller chose, so it
     * cannot say a redeploy is one. Changed only when a deploy joins a queued
     * redeploy and upgrades it (`joinQueuedBuild`). Null on every other row,
     * and on builds recorded before the column, which start-up settles rather
     * than guesses at. Not a parent (ADR-0017).
     */
    queuedAs: jsonb('queued_as').$type<QueuedAs>(),
    createdAt: isoTimestamp('created_at'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (table) => [
    deploymentAtMostOneParent,
    deploymentPreviewQualifiesAnApplication,
    deploymentCronRunHasAnApplication,
    deploymentForServiceOnANetworkRun,
    // No action of its own, and said so (§2.6): a preview's delete is
    // answered by the one-column key's SET NULL above, after which this pair
    // is half null and `MATCH SIMPLE` has nothing left to check. Its one job
    // is refusing a write; a SET NULL here would null `application_id` too,
    // and a cascade would delete the parent's build history with the preview
    // (0077 explains the order the two keys are created in).
    foreignKey({
      name: 'deployment_preview_belongs_to_its_application',
      columns: [table.previewDeploymentId, table.applicationId],
      foreignColumns: [
        previewDeployment.previewDeploymentId,
        previewDeployment.applicationId,
      ],
    }).onDelete('no action'),
  ],
);

export const deploymentRelations = relations(deployment, ({ one }) => ({
  application: one(application, {
    fields: [deployment.applicationId],
    references: [application.applicationId],
  }),
  compose: one(compose, {
    fields: [deployment.composeId],
    references: [compose.composeId],
  }),
  backup: one(backup, {
    fields: [deployment.backupId],
    references: [backup.backupId],
  }),
  volumeBackup: one(volumeBackup, {
    fields: [deployment.volumeBackupId],
    references: [volumeBackup.volumeBackupId],
  }),
  schedule: one(schedule, {
    fields: [deployment.scheduleId],
    references: [schedule.scheduleId],
  }),
  environmentNetwork: one(environmentNetwork, {
    fields: [deployment.environmentNetworkId],
    references: [environmentNetwork.environmentNetworkId],
  }),
  postgres: one(postgres, {
    fields: [deployment.postgresId],
    references: [postgres.postgresId],
  }),
  bucket: one(bucket, {
    fields: [deployment.bucketId],
    references: [bucket.bucketId],
  }),
  mysql: one(mysql, {
    fields: [deployment.mysqlId],
    references: [mysql.mysqlId],
  }),
  redis: one(redis, {
    fields: [deployment.redisId],
    references: [redis.redisId],
  }),
}));

export type Deployment = typeof deployment.$inferSelect;
