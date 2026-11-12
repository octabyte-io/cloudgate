import { FrozenOrganizations } from '../../cloud/billing/frozen-organizations.service';
import type { WorkPlace } from '../../common/work-place';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getComposeContainerCommand,
  getServiceContainerCommand,
} from '../../backups/commands';
import { BackupRunRecorderService } from '../../backups/run-recorder.service';
import {
  isCloudService,
  refuseCloudServiceHostWork,
} from '../../common/cloud-service-host-work';
import { checkServerAccess } from '../../common/owned-server';
import { findParentService } from '../../common/service-parent';
import type { ServiceParent } from '../../common/service-parent';
import {
  reclaimDeploymentLogs,
  withUnreclaimedArtifacts,
} from '../../common/teardown-steps';
import type { UnreclaimedArtifact } from '../../common/teardown-steps';
import { generateAppName } from '../../db/columns';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { PermissionCtx } from '../../rbac/permission.service';
import { PermissionService } from '../../rbac/permission.service';
import { RemoteExecService } from '../../remote/remote-exec.service';
import { SchedulingService } from '../scheduling.service';
import { schedule } from './schedule.schema';
import type { Schedule, ScheduleType } from './schedule.schema';
import {
  buildScheduleCommandScript,
  buildScheduleScriptRunCommand,
  buildScriptMaterializationCommand,
  buildScriptRemovalCommand,
} from './schedule-commands';
import type { ScheduleRunProgram } from './schedule-commands';
import {
  INERT_COMMAND_REFUSAL,
  INERT_SCRIPT_REFUSAL,
  scheduleRunsACommand,
  scheduleRunsAScript,
} from './dto/schedule.dto';
import type {
  CreateScheduleDto,
  ListSchedulesDto,
  UpdateScheduleDto,
} from './dto/schedule.dto';

type PermissionVerb = 'read' | 'create' | 'update' | 'delete';

/** What the access check resolved about the schedule's target — the parent
 * serverId decides where scripts materialize and commands run. */
interface ScheduleTarget {
  /** The server the schedule's work happens on (null = the local host). */
  serverId: string | null;
  parent: ServiceParent | null;
}

/**
 * User-defined cron jobs. Container schedules (application/compose) are
 * permission- and row-access-scoped like every service-attached resource;
 * `server` schedules are owner/admin-only, `cloudgate-server` schedules take
 * instance authority, and both materialize their script.sh on the target host
 * at create/update.
 */
/**
 * Whose a Schedule's run is: the Service it runs in, the Server it runs on,
 * or the Organization a platform-host script belongs to.
 */
function placeOf(row: Schedule): WorkPlace | null {
  const serviceId = row.applicationId ?? row.composeId;
  if (serviceId) return { serviceId };
  if (row.serverId) return { serverId: row.serverId };
  return row.organizationId ? { organizationId: row.organizationId } : null;
}

@Injectable()
export class SchedulesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly scheduling: SchedulingService,
    private readonly runRecorder: BackupRunRecorderService,
    private readonly frozen: FrozenOrganizations,
  ) {}

  /** At boot: re-register the cron job of every enabled schedule. */
  async onApplicationBootstrap(): Promise<void> {
    await this.initializeJobs();
  }

  async initializeJobs(): Promise<void> {
    // This never fails the boot — it logs and moves on.
    try {
      const rows = await this.db
        .select()
        .from(schedule)
        .where(eq(schedule.enabled, true));
      for (const row of rows) {
        // Per row, not per loop: a row whose cronExpression the scheduler
        // cannot parse throws synchronously out of registerJob, and with the
        // try around the whole loop that cost every row after it its cron.
        // Rows written before the DTO validation landed (or by hand) can
        // still carry one.
        try {
          this.registerJob(row);
        } catch (error) {
          this.logger.error(
            `Failed to register schedule ${row.scheduleId}`,
            error,
          );
        }
      }
    } catch (error) {
      this.logger.error('Failed to initialize schedules', error);
    }
  }

  /** The schedule runs by row id on its cron, in its
   * timezone (UTC when unset). */
  private registerJob(row: Schedule): void {
    this.scheduling.register(
      row.scheduleId,
      row.cronExpression,
      row.timezone ?? 'UTC',
      () => this.runScheduled(row.scheduleId),
    );
  }

  /** Keeps the cron job in sync with the row after create/update/remove. */
  private syncJob(row: Schedule): void {
    if (row.enabled) {
      this.registerJob(row);
    } else {
      this.scheduling.unregister(row.scheduleId);
    }
  }

  async create(ctx: PermissionCtx, data: CreateScheduleDto): Promise<Schedule> {
    const scheduleType = data.scheduleType ?? 'application';
    const target = await this.checkAccess(
      ctx,
      scheduleType,
      data.serviceId ?? null,
      'create',
    );

    const { serviceId, ...rest } = data;
    // The row is written last, so a target that cannot take the script leaves
    // nothing behind for the console or the cron to act on. scheduleId
    // and appName are minted here rather than left to the column defaults
    // because the script names both and has to be on disk before the row
    // exists — BackupRunRecorderService.start does the same for a run's log
    // file. The $defaultFn's on both columns stay as the safety net for any
    // other writer.
    const values = {
      ...rest,
      scheduleId: nanoid(),
      appName: generateAppName('schedule'),
      // The `''` the `notNull` column needs, minted here for the reason
      // `scheduleId` and `appName` are: it has to exist by the time the row is
      // written and it must **not** exist any earlier. It was a `.default('')`
      // on the DTO once, which manufactured it in front of the
      // validation and so made the inert-command refusal unstatable — a guard
      // cannot tell a client's value from zod's. Behind the refusal it is just
      // a column's resting value.
      command: rest.command ?? '',
      scheduleType,
      ...(scheduleType === 'application' && { applicationId: serviceId }),
      ...(scheduleType === 'compose' && { composeId: serviceId }),
      ...(scheduleType === 'server' && { serverId: serviceId }),
      ...(scheduleType === 'cloudgate-server' && {
        organizationId: ctx.session.activeOrganizationId,
      }),
    };
    await this.materializeScript(values, target);

    const [created] = await this.db.insert(schedule).values(values).returning();
    this.syncJob(created);
    return created;
  }

  /** One schedule, behind the read check on its target. */
  async findOne(ctx: PermissionCtx, scheduleId: string): Promise<Schedule> {
    const row = await this.findRow(scheduleId);
    await this.checkRowAccess(ctx, row, 'read');
    return row;
  }

  /** One target's schedules, oldest first (asc createdAt). */
  async list(ctx: PermissionCtx, query: ListSchedulesDto): Promise<Schedule[]> {
    await this.checkAccess(
      ctx,
      query.scheduleType,
      query.serviceId ?? null,
      'read',
    );

    const where = {
      application: () =>
        eq(schedule.applicationId, this.requireServiceId(query.serviceId)),
      compose: () =>
        eq(schedule.composeId, this.requireServiceId(query.serviceId)),
      server: () =>
        eq(schedule.serverId, this.requireServiceId(query.serviceId)),
      'cloudgate-server': () =>
        eq(schedule.organizationId, ctx.session.activeOrganizationId),
    }[query.scheduleType]();

    return this.db
      .select()
      .from(schedule)
      .where(where)
      .orderBy(asc(schedule.createdAt));
  }

  async update(
    ctx: PermissionCtx,
    scheduleId: string,
    data: UpdateScheduleDto,
  ): Promise<Schedule> {
    const current = await this.findRow(scheduleId);
    const target = await this.checkRowAccess(ctx, current, 'update');
    this.refuseInertScript(current.scheduleType, data.script);
    this.refuseInertCommand(current.scheduleType, data.command);

    // Same ordering as create: materialize the row the update *would*
    // produce, and only then store it. A target that refuses the write leaves
    // the stored script and the on-disk script both untouched and agreeing —
    // where before, a failed write had already destroyed the working script.sh
    // while the row went on advertising one for the next cron tick to run.
    const merged = { ...current, ...data };
    await this.materializeScript(merged, target);

    const [updated] = await this.db
      .update(schedule)
      .set(data)
      .where(eq(schedule.scheduleId, current.scheduleId))
      .returning();
    this.syncJob(updated);
    return updated;
  }

  /**
   * The update half of the inert-script rule, which the DTO cannot state.
   *
   * `createScheduleSchema` is a discriminated union on `scheduleType` and
   * refuses this at the field. `updateScheduleSchema` carries no
   * `scheduleType` at all — a schedule cannot be re-pointed at another target
   * (the backups precedent, recorded at that schema) — so on this path the type
   * is a fact about the *row* and the request has no discriminant to union on.
   * The rule lives here rather than being dropped, because otherwise `PATCH`
   * would remain the way to put a body into the column that `POST` now refuses.
   * The sentence is {@link INERT_SCRIPT_REFUSAL}'s and is not restated (§2.4).
   *
   * **`null` is admitted, and that is the point of the `!= null`.** Clearing an
   * inert script is the remediation for a row that already holds one — a row
   * created before this rule shipped, which gets no backfill — and nothing in a
   * guard may refuse the write that fixes what it is refusing
   * (`DomainsService.assertParentRowsRoutable`'s own rule). A `.partial()` body
   * that omits `script` entirely is untouched for the same reason: it is not
   * asking for one.
   */
  private refuseInertScript(
    scheduleType: ScheduleType,
    script: string | null | undefined,
  ): void {
    if (script == null) return;
    if (scheduleRunsAScript(scheduleType)) return;
    throw new BadRequestException(INERT_SCRIPT_REFUSAL);
  }

  /**
   * {@link refuseInertScript}'s mirror, and here for the identical reason:
   * `updateScheduleSchema` carries no `scheduleType`, so this is the
   * one branch the DTO structurally cannot decide, and left unguarded `PATCH`
   * would stay the way into the state `POST` now refuses. The sentence is
   * {@link INERT_COMMAND_REFUSAL}'s and is not restated (§2.4).
   *
   * **The falsy check is the rule, not a shortcut.** An omitted `command` is
   * not asking for one, and `''` is the write that *clears* an inert command a
   * row already holds — the remediation for a row created before this rule
   * shipped, which gets no backfill, and nothing in a guard may refuse the
   * write that fixes what it is refusing (`DomainsService`'s own rule, applied
   * here). `''` is also what the `notNull` column holds for these two types in
   * the first place, so refusing it would refuse a no-op.
   */
  private refuseInertCommand(
    scheduleType: ScheduleType,
    command: string | null | undefined,
  ): void {
    if (!command) return;
    if (scheduleRunsACommand(scheduleType)) return;
    throw new BadRequestException(INERT_COMMAND_REFUSAL);
  }

  /** Drop the script directory on the schedule's
   * server (harmless for container schedules), its run logs, then the row. */
  async remove(
    ctx: PermissionCtx,
    scheduleId: string,
  ): Promise<Schedule & { unreclaimedArtifacts?: UnreclaimedArtifact[] }> {
    const current = await this.findRow(scheduleId);
    const target = await this.checkRowAccess(ctx, current, 'delete');

    // One `target.serverId` decides the root and the machine, so the removal
    // cannot name a directory on one host and be sent to another. A Service
    // in a Cloud account has no machine of Cloudgate's, and its
    // `serverId: null` would name the platform host.
    if (!(target.parent && isCloudService(target.parent))) {
      await this.exec(
        target.serverId,
        buildScriptRemovalCommand(current.appName, target.serverId),
      );
    }
    // And the run logs, on the same machine {@link run} wrote them to:
    // the run Deployments cascade with the row, so no screen could open them
    // afterwards. Best effort — one the machine would not give up is named.
    const unreclaimedArtifacts = await reclaimDeploymentLogs(this.remoteExec, [
      { appName: current.appName, serverId: target.serverId },
    ]);

    const [removed] = await this.db
      .delete(schedule)
      .where(eq(schedule.scheduleId, current.scheduleId))
      .returning();
    this.scheduling.unregister(current.scheduleId);
    return withUnreclaimedArtifacts(removed, unreclaimedArtifacts);
  }

  /** Run a schedule now — gated like create. */
  async runManual(ctx: PermissionCtx, scheduleId: string): Promise<void> {
    const row = await this.findRow(scheduleId);
    const target = await this.checkRowAccess(ctx, row, 'create');
    await this.run(row, target);
  }

  /**
   * The cron callback: a cron-fired run executes with no user session, so the
   * target resolves without org scoping (it was org-checked when the row was
   * created).
   */
  async runScheduled(scheduleId: string): Promise<void> {
    const row = await this.findRow(scheduleId);
    // A Frozen Organization's Schedules do not run (ADR-0052): the
    // tick is skipped, recording nothing, and the next one asks again.
    const place = placeOf(row);
    if (place && (await this.frozen.isFrozenAt(place))) return;
    await this.run(row, await this.resolveTarget(row));
  }

  /**
   * Record the run as a deployment, then docker-exec the command in the
   * target container (application/compose) or run the materialized script.sh
   * on the target host (server/cloudgate-server). No PID is captured: a pid
   * column and kill button would need streaming execution.
   */
  private async run(row: Schedule, target: ScheduleTarget): Promise<void> {
    const run = await this.runRecorder.start({
      appName: row.appName,
      serverId: target.serverId,
      title: 'Schedule',
      description: 'Schedule',
      initMessage: 'Initializing schedule run',
      parent: { kind: 'schedule', scheduleId: row.scheduleId },
    });
    try {
      const { program, env } = this.buildRunScript(row, target, run.logPath);
      await this.exec(target.serverId, program, env);
      await this.runRecorder.finish(run.deploymentId, 'done');
    } catch (error) {
      await this.runRecorder.finish(run.deploymentId, 'error');
      throw error;
    }
  }

  /**
   * The program a run executes, and the environment its values travel in.
   *
   * A pair rather than a string: a container run's `command` is
   * operator-authored program text that can hold a credential, so it reaches
   * the host in `RemoteExecOptions.env` and the program only references a
   * holder — see `buildScheduleCommandScript`. A script run has nothing to keep
   * off its command line (`script.sh` is already a file on the host) and passes
   * an empty environment, which leaves that branch on the transport it has
   * always used.
   */
  private buildRunScript(
    row: Schedule,
    target: ScheduleTarget,
    logPath: string,
  ): ScheduleRunProgram {
    // The classification, asked rather than re-spelled. This site and
    // the two below wrote the pair out because they also need the *narrowed*
    // type — `getComposeContainerCommand` forks on `'compose'`,
    // `findParentService` takes it — which is why the one classification did
    // not reach them; `scheduleRunsACommand` is a type guard so that it can.
    if (scheduleRunsACommand(row.scheduleType)) {
      const parent = target.parent;
      if (!parent) throw new NotFoundException('Service not found');
      const containerSearch =
        row.scheduleType === 'compose'
          ? getComposeContainerCommand(
              parent.appName,
              row.serviceName ?? '',
              parent.composeType,
            )
          : getServiceContainerCommand(parent.appName);
      return buildScheduleCommandScript({
        containerSearch,
        shellType: row.shellType,
        command: row.command,
        logPath,
      });
    }
    return {
      program: buildScheduleScriptRunCommand(
        row.appName,
        logPath,
        target.serverId,
      ),
      env: {},
    };
  }

  /** The ctx-free target resolution scheduled runs use. */
  private async resolveTarget(row: Schedule): Promise<ScheduleTarget> {
    if (scheduleRunsACommand(row.scheduleType)) {
      const parent = await findParentService(
        this.db,
        null,
        this.requireServiceId(row.applicationId ?? row.composeId),
        row.scheduleType,
      );
      // A row saved before the create was refused does not run.
      refuseCloudServiceHostWork(parent, 'commandSchedules');
      return { serverId: parent.serverId, parent };
    }
    if (row.scheduleType === 'server') {
      return { serverId: row.serverId, parent: null };
    }
    return { serverId: null, parent: null };
  }

  /**
   * Run at create/update for server and cloudgate-server schedules: materialize
   * script.sh on the target host.
   *
   * Takes the four fields it reads rather than a `Schedule`, because
   * both call sites hand it the value object they are *about* to persist
   * — the script has to be on disk before the row exists.
   *
   * A host-side write cannot be rolled back by the database, so this does not
   * claim atomicity; it claims that the durable, actionable artefact is the
   * row and the row goes last. When a later step fails the residue on the
   * target is an inert directory under schedulesDirectoryOn() named after an
   * appName no row holds: nothing can run it, because both
   * buildScheduleScriptRunCommand and the cron registration are only ever
   * reached from a row. It is deliberately not swept — a compensating `rm -rf`
   * on the target is the same unreliable second write that ruled out the
   * compensating-delete shape, and its bad day would be deleting a live
   * script.
   */
  private async materializeScript(
    row: {
      scheduleId: string;
      appName: string;
      script?: string | null;
      scheduleType: ScheduleType;
    },
    target: ScheduleTarget,
  ): Promise<void> {
    // The one classification, shared with the DTO's refusal and with
    // `refuseInertScript`. This early return *was* the only statement of
    // it, which is why a `script` could be accepted for a type that never
    // reaches this line.
    if (!scheduleRunsAScript(row.scheduleType)) return;
    await this.exec(
      target.serverId,
      buildScriptMaterializationCommand(row, target.serverId),
    );
  }

  /**
   * Per-verb access checks: container schedules need the schedule permission
   * plus row access to the owning service (cross-org reads look absent);
   * `server` schedules need the permission plus the owner or admin role, with
   * server rows org-scoped; `cloudgate-server` schedules name the platform host
   * and need instance authority (H-63).
   *
   * The three branches are three targets, and only the last one belongs to no
   * organization. `server` names a Server, a Server belongs to an organization,
   * and an organization's owner administers its own fleet — that is
   * {@link requireOwnerOrAdmin} asked of exactly the right thing, and it has
   * not moved. `cloudgate-server` hard-codes `serverId: null`, which is the
   * machine Cloudgate itself runs on (ADR-0008's second consequence), and there
   * the caller's role in their *own* organization was never the question: an
   * owner of any organization on the instance could materialize a `script.sh`
   * under `schedulesDirectoryOn(null)` and have {@link registerJob} run it as the
   * backend process user on a cron of their choosing. Persistent arbitrary code
   * execution on the platform host, from the cheapest account the product can
   * mint a second of.
   *
   * **Instance authority is asked for every verb, not only the writing ones.**
   * `list` and `findOne` already scope `cloudgate-server` rows by
   * `organizationId`, so admitting the read discloses no other tenant's rows —
   * but the target does not change with the verb, and ADR-0013's first
   * consequence is that on the platform host the read moves with the write. A
   * caller who may not address that host may not address it to ask what is
   * scheduled on it either.
   *
   * The `schedule` statement stays in front of it and is not sufficient on its
   * own: ADR-0010's first consequence and ADR-0013's third reject gating
   * host-level power on anything from `statements`, because a licensed custom
   * role can be granted one and would then quietly carry the platform host.
   */
  private async checkAccess(
    ctx: PermissionCtx,
    scheduleType: ScheduleType,
    serviceId: string | null,
    verb: PermissionVerb,
  ): Promise<ScheduleTarget> {
    if (scheduleRunsACommand(scheduleType)) {
      const parent = await findParentService(
        this.db,
        ctx.session.activeOrganizationId,
        this.requireServiceId(serviceId),
        scheduleType,
      );
      await this.permissions.checkPermission(ctx, { schedule: [verb] });
      await this.permissions.checkServiceAccess(ctx, parent.serviceId);
      // A Service in a Cloud account has no container to `docker exec` in,
      // and its `serverId: null` would run the command on the platform host
      //. `create` is also a manual run's verb, so this refuses one of
      // a row saved before; a read or a delete still reaches the row.
      if (verb === 'create' || verb === 'update') {
        refuseCloudServiceHostWork(parent, 'commandSchedules');
      }
      return { serverId: parent.serverId, parent };
    }

    if (scheduleType === 'server') {
      const serverId = this.requireServiceId(serviceId);
      await checkServerAccess(this.db, ctx, serverId);
      await this.permissions.checkPermission(ctx, { schedule: [verb] });
      await this.requireOwnerOrAdmin(ctx);
      return { serverId, parent: null };
    }

    await this.permissions.checkPermission(ctx, { schedule: [verb] });
    await this.permissions.checkInstanceAuthority(ctx);
    return { serverId: null, parent: null };
  }

  /** The row-level variant: derive the target from the row's FK columns.
   * cloudgate-server rows outside the caller's organization read as absent. */
  private async checkRowAccess(
    ctx: PermissionCtx,
    row: Schedule,
    verb: PermissionVerb,
  ): Promise<ScheduleTarget> {
    if (row.scheduleType === 'cloudgate-server') {
      if (row.organizationId !== ctx.session.activeOrganizationId) {
        throw new NotFoundException('Schedule not found');
      }
      return this.checkAccess(ctx, 'cloudgate-server', null, verb);
    }
    return this.checkAccess(
      ctx,
      row.scheduleType,
      row.applicationId ?? row.composeId ?? row.serverId,
      verb,
    );
  }

  /**
   * The owner/admin gate on `server` schedules — the ones that name a
   * Server in the caller's own organization.
   *
   * Kept, and kept named this, for the reason `SettingsService`'s namesake was
   * kept: it is still the right question for a target that belongs to an
   * organization. The `cloudgate-server` branch of {@link checkAccess} no
   * longer calls it (H-63); the platform host belongs to no organization, so
   * this was answering about the wrong one.
   */
  private async requireOwnerOrAdmin(ctx: PermissionCtx): Promise<void> {
    const member = await this.permissions.findMember(ctx);
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new ForbiddenException(
        'Only owners and admins can manage server schedules',
      );
    }
  }

  private requireServiceId(serviceId: string | null | undefined): string {
    if (!serviceId) {
      throw new BadRequestException(
        'serviceId is required for this schedule type',
      );
    }
    return serviceId;
  }

  /**
   * A schedule's program on its target — a Server, or the Cloudgate host when
   * `serverId` is null.
   *
   * **`env` is never-carry's plumbing** (ADR 0015's last bullet). An
   * empty one passes no options at all, so materialization, removal and script
   * runs stay on exactly the transport they have always used; a non-empty one
   * moves the values off the command line, which is only the container-command
   * branch.
   *
   * The local branch spreads `process.env` because `ExecOptions.env`
   * *replaces* the environment rather than extending it — the hazard
   * `RemoteExecService.execFileAsync` documents, which
   * `destinations/rclone-exec.ts` has handled this way, and
   * `DeploymentEngineService.exec` as well. Without the spread a schedule
   * would run with no `PATH` and `docker` would not be found.
   */
  private async exec(
    serverId: string | null,
    command: string,
    env: Record<string, string> = {},
  ): Promise<void> {
    const carries = Object.keys(env).length > 0;
    if (serverId) {
      await this.remoteExec.execAsyncRemote(
        serverId,
        command,
        undefined,
        carries ? { env } : undefined,
      );
    } else {
      await this.remoteExec.execAsync(
        command,
        carries ? { env: { ...process.env, ...env } } : undefined,
      );
    }
  }

  /** The full row by id, before any access decision needs its target. */
  private async findRow(scheduleId: string): Promise<Schedule> {
    const [row] = await this.db
      .select()
      .from(schedule)
      .where(eq(schedule.scheduleId, scheduleId))
      .limit(1);
    if (!row) throw new NotFoundException('Schedule not found');
    return row;
  }
}
