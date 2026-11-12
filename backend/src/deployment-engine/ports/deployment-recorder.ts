/**
 * Port for deployment records. The real implementation arrives with the
 * deployments table in Phase 23; the engine only needs a row to exist and its
 * logPath to pipe build output into.
 */
export const DEPLOYMENT_RECORDER = Symbol('DEPLOYMENT_RECORDER');

/**
 * Every parent column `deployment` carries — the ten nullable foreign keys
 * `deployment_at_most_one_parent` counts (`deployments/deployment.schema.ts`),
 * in the order the read side resolves them (ADR-0017).
 */
export type DeploymentParentColumnName =
  | 'applicationId'
  | 'composeId'
  | 'scheduleId'
  | 'volumeBackupId'
  | 'backupId'
  | 'environmentNetworkId'
  | 'postgresId'
  | 'mysqlId'
  | 'bucketId'
  | 'redisId';

/**
 * One arm of {@link DeploymentParent}: the kind, the single id column that
 * kind sets, and every *other* parent column pinned to `never`.
 *
 * **The `never` half is what makes two parents unrepresentable** rather than
 * merely unwritable-as-a-literal. TypeScript's excess-property check fires on
 * an object literal written at the call and not on a variable assigned into
 * the parameter, so the tag alone would still admit
 * `{ kind: 'application', applicationId, composeId }` from any caller that
 * assembled it one statement earlier. Both halves are type-checked as source
 * by `test/deployments/deployment-parent.spec.ts` rather than asserted in
 * prose here.
 */
type ParentArm<
  Kind extends string,
  Column extends DeploymentParentColumnName,
> = { kind: Kind } & { [Name in Column]: string } & {
  [Name in Exclude<DeploymentParentColumnName, Column>]?: never;
};

/**
 * Which parent a `deployment` row hangs off — the writer's own statement of
 * which kind of record it is writing, rather than five nullable columns a
 * reader has to rank (ADR-0017).
 *
 * **All five parents, plus the parentless row.** It is established that
 * `deployment` is not the third table with `patch`'s `applicationId`/
 * `composeId` pair: it has five nullable parents, and the sweep in
 * `test/coding-standards/parent-id-writes.spec.ts` reports only two because
 * `backup`, `volume_backup` and `schedule` are not service tables. The three
 * run-record arms are what `BackupRunRecorderService.start` writes: it takes
 * `RunRecordParent` — this union `Extract`ed down to those three — and goes through
 * {@link parentColumns} like the build writer does, where it
 * used to carry its own untagged `fk: { backupId } | { volumeBackupId } |
 * { scheduleId }`. `none` is deliberate rather than an orphan: `ownerOf`
 * answers `NotFoundException` for a
 * parentless row, `DeploymentsService.readLogs` answers 404 through it, and
 * `test/deployments/run-history.e2e-spec.ts` pins that with a row it inserts
 * by hand — which is exactly why the table's constraint counts
 * `num_nonnulls(…) <= 1` instead of stating an XOR. A union covering only the
 * two kinds this port's `create` accepts would have made that fourth shape
 * nameless, which is how the second spelling gets invented.
 *
 * **The vocabulary lives in the port, not beside the table**, for the reason
 * the port exists: `deployments/` implements it, so a type it owned would
 * point the dependency backwards and put the engine behind the module it was
 * separated from. This file imports nothing at all, and both writers of a
 * `deployment` row can reach it.
 *
 * The `CHECK` on the table stays, and is now a backstop rather than the
 * statement of the rule: it holds a migration, a fixture and a hand-run
 * `UPDATE`, none of which this type is in front of.
 */
export type DeploymentParent =
  | ParentArm<'application', 'applicationId'>
  | ParentArm<'compose', 'composeId'>
  | ParentArm<'schedule', 'scheduleId'>
  | ParentArm<'volumeBackup', 'volumeBackupId'>
  | ParentArm<'backup', 'backupId'>
  /**
   * The Environment network's own Cloud run (ADR-0017 extended): its
   * create by an Apply, and its removal. Written by the Apply's
   * network run, never by the engine, and ranked last by the read side.
   */
  | ParentArm<'environmentNetwork', 'environmentNetworkId'>
  /**
   * A postgres on RDS's own Cloud run (ADR-0017 extended): its create
   * by an Apply. A database builds nothing, so this is the only row it has;
   * written by its Cloud run, never by the engine.
   */
  | ParentArm<'postgres', 'postgresId'>
  /**
   * A mysql on RDS's own Cloud run (ADR-0017 extended as for a
   * postgres on RDS): written by its Cloud run, never by the engine.
   */
  | ParentArm<'mysql', 'mysqlId'>
  /**
   * A bucket on AWS's own Cloud run (ADR-0017 extended), as a
   * postgres on RDS's: written by its Cloud run, never by the engine.
   */
  | ParentArm<'bucket', 'bucketId'>
  /**
   * A redis on ElastiCache's own Cloud run (ADR-0017 extended as for
   * a postgres on RDS): its create by an Apply, written by its Cloud run.
   */
  | ParentArm<'redis', 'redisId'>
  | ParentArm<'none', never>;

/** The eleven parent kinds a `deployment` row can be written under. */
export type DeploymentParentKind = DeploymentParent['kind'];

/**
 * The two arms that record a **build**: the only kinds `create` can honour,
 * because it names a log directory after the owning service's `appName` and
 * claims a pending record within that service's own scope. A run record has
 * its log initialized by `BackupRunRecorderService.start` instead, and the
 * parentless row is written by nothing.
 */
export type BuildableDeploymentParent = Extract<
  DeploymentParent,
  { kind: 'application' | 'compose' }
>;

/** One row's parent columns: exactly one set, or none. */
type WithoutKind<Parent> = Parent extends unknown
  ? Omit<Parent, 'kind'>
  : never;

export type DeploymentParentColumns = WithoutKind<DeploymentParent>;

/**
 * The parent as the columns that store it — the one place a
 * {@link DeploymentParent} becomes a `deployment` row's foreign keys.
 *
 * Exhaustive by construction: `strictNullChecks` plus the declared return type
 * means a missing arm is `TS2366` (*lacks ending return statement*) rather
 * than a silent `undefined` spread into `.values()`, so a sixth parent kind
 * cannot be added to the union without being written here.
 */
export function parentColumns(
  parent: DeploymentParent,
): DeploymentParentColumns {
  switch (parent.kind) {
    case 'application':
      return { applicationId: parent.applicationId };
    case 'compose':
      return { composeId: parent.composeId };
    case 'schedule':
      return { scheduleId: parent.scheduleId };
    case 'volumeBackup':
      return { volumeBackupId: parent.volumeBackupId };
    case 'backup':
      return { backupId: parent.backupId };
    case 'environmentNetwork':
      return { environmentNetworkId: parent.environmentNetworkId };
    case 'postgres':
      return { postgresId: parent.postgresId };
    case 'mysql':
      return { mysqlId: parent.mysqlId };
    case 'bucket':
      return { bucketId: parent.bucketId };
    case 'redis':
      return { redisId: parent.redisId };
    case 'none':
      return {};
  }
}

/**
 * What the engine hands {@link DeploymentRecorder.create}: the service built,
 * named by kind, plus the record's own title and description.
 *
 * This used to be `applicationId?: string | null` and
 * `composeId?: string | null` — two independent optionals, with "exactly one
 * of them" stated in a comment and enforced only by the two callers happening
 * to branch before calling. A third caller passing both wrote a two-parented
 * row until the table was constrained, and a 500 naming
 * `deployment_at_most_one_parent` after it. Neither is the right surface: as a
 * discriminated union the call does not compile, and `create` reads the parent
 * off the discriminant instead of coalescing two nullable fields — so it no
 * longer spells a precedence between them at all (ADR-0017).
 */
export type CreateDeploymentInput = BuildableDeploymentParent & {
  title: string;
  description: string;
  /**
   * The `pending` row the build's job names — its trigger inserted it
   * and enqueued the job with its id. With it, `create` claims exactly that
   * row, or answers `null` when it is no longer `pending`. Without it (a
   * Preview deployment, which has no row of its own) a fresh `running` row is
   * recorded.
   */
  deploymentId?: string;
};

export interface DeploymentRecord {
  deploymentId: string;
  /** Absolute path (on the build server) the build output is appended to. */
  logPath: string;
  /**
   * Aborted when the Deployment is cancelled while it runs. The engine
   * hands it to every shell step of the build, so an abort kills whatever step
   * is running; the record is already `cancelled` by then, and the engine
   * must not write a status over it.
   */
  cancelled: AbortSignal;
}

export interface DeploymentRecorder {
  /**
   * The record a starting build writes to — or `null` when the row its job
   * named was settled (cancelled, or dropped with the queue) between the
   * dequeue and this claim, and the engine must not build at all: building it
   * would run what an operator took back.
   */
  create(input: CreateDeploymentInput): Promise<DeploymentRecord | null>;
  updateStatus(deploymentId: string, status: 'done' | 'error'): Promise<void>;
  /**
   * The build's shell steps are over: from here a cancel is refused
   * rather than delivered, because what follows — releasing the image as a
   * Swarm service and waiting for it to converge — is not something a kill can
   * stop part-way. Synchronous on purpose: the engine calls it and then reads
   * {@link DeploymentRecord.cancelled} with nothing in between, so a cancel
   * lands either before both or after both.
   */
  closeCancelWindow(deploymentId: string): void;
}
