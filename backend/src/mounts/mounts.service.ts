import * as path from 'node:path';
import { stackRootId } from '../compose/stack-root';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type {
  ServiceType,
  WorkloadServiceType,
} from '../applications/application.schema';
import { refuseWeightsVolumeMount } from '../ai-models/weights-volume';
import { ownerOnlyDirectoryCommand } from '../common/files/owner-only';
import {
  isCloudService,
  refuseCloudServiceHostWork,
} from '../common/cloud-service-host-work';
import { findParentService } from '../common/service-parent';
import type { ServiceParent } from '../common/service-parent';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  getCreateFileCommand,
  resolveShellSafePath,
} from '../docker/docker.utils';
import {
  composeDirectoryOn,
  fileMountsDirectoryOnRunServer,
} from '../deployment-engine/deployment-engine.paths';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { runTargetOn } from '../remote/run-target';
import { compose } from '../compose/compose.schema';
import { mount, mountServiceFk } from './mount.schema';
import type { Mount, MountType } from './mount.schema';
import type {
  CreateMountDto,
  ListMountsDto,
  UpdateMountDto,
} from './dto/mount.dto';

/** The mount row's FK insert field for each owning service type. */
const MOUNT_FK_FIELD = {
  application: 'applicationId',
  postgres: 'postgresId',
  mysql: 'mysqlId',
  mariadb: 'mariadbId',
  mongo: 'mongoId',
  redis: 'redisId',
  compose: 'composeId',
  libsql: 'libsqlId',
} as const satisfies Record<
  WorkloadServiceType,
  keyof typeof mount.$inferInsert
>;

/**
 * The source columns each kind of mount does **not** own, nulled — what a
 * change of kind writes under the body so the old source goes with it.
 * A key the body also sends wins, so a value for the new kind is kept.
 */
const UNOWNED_BY = {
  volume: { hostPath: null, filePath: null, content: null },
  bind: { volumeName: null, filePath: null, content: null },
  file: { volumeName: null, hostPath: null },
} as const satisfies Record<MountType, Partial<typeof mount.$inferInsert>>;

/** The owning service's id off a mount row (exactly one FK is set). */
function serviceIdOf(row: Mount): string {
  const serviceId = row[MOUNT_FK_FIELD[row.serviceType]];
  if (!serviceId) throw new NotFoundException('Mount has no owning service');
  return serviceId;
}

@Injectable()
export class MountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
  ) {}

  /**
   * The `POST /mounts` route: volume create permission plus a
   * *definition-write* level on the owning service. A file mount is
   * materialized on the service's **run** Server immediately
   * ({@link writeFileMount}) — deploys only bind-mount the result.
   *
   * **`volume: ['create']` and `service: ['update']`, and the second is not
   * redundant.** They are about different things, which is why this
   * module is in the `'update'`-level set at all while `backups`,
   * `volumeBackups`, `schedules` and `domains` — each of which also runs a
   * `checkServiceAccess` beside its own statement — are not. A Backup, a
   * Schedule and a Domain *are* their own resource, so `backup:update` and
   * `domain:delete` set the level of those writes and `checkServiceAccess` is
   * only answering entitlement, for which `read` is right. A Mount is not:
   * `volume` is the Docker volume, "named after the volume itself rather than
   * any service that mounts it" (`CONTEXT.md`, *Volume lock*), so
   * `volume:create` gates *having* a volume and nothing before that change
   * gated *changing this Service's* mounts. The three writes here took
   * `checkServiceAccess`'s defaulted `'read'`, and a mount is a bind into a
   * caller-chosen container path on somebody's workload.
   *
   * That reasoning is about a Service that **already exists**, which is the
   * whole of it — a caller reaching this route names a stack somebody else's
   * statement built. {@link createForNewService} is the same write against a
   * stack the caller is in the middle of creating, and it takes a different
   * level for the reason its own docblock gives. The level is written as a
   * literal in each of the two rather than threaded through one private on a
   * parameter, so that the gate is readable at the entry point and so that
   * `test/coding-standards/composed-creates.spec.ts` can read it there too.
   */
  async create(ctx: PermissionCtx, data: CreateMountDto) {
    // `createMountSchema`'s default (the pipe applies it on HTTP calls;
    // direct service calls need it here).
    const serviceType = data.serviceType ?? 'application';
    const parent = await this.findParentService(
      ctx,
      data.serviceId,
      serviceType,
    );
    await this.permissions.checkPermission(ctx, { volume: ['create'] });
    await this.permissions.checkServiceAccess(ctx, data.serviceId, 'update');

    return this.insertMount(data, serviceType, parent);
  }

  /**
   * The same create, for a Service the *same operation* has just brought into
   * existence — `PlanApplier`'s create of a Template part and
   * `AiService.deploy`, whose config-file mounts are part of the stack being built rather than an edit to
   * one that was already there. **Internal: no controller reaches this**, and
   * `POST /mounts` must not (see {@link create}).
   *
   * **Why taking `'read'` here is not a hole (and the regression it
   * caused).** Both callers open with
   * `checkServiceAccess(ctx, parent.projectId, 'create')` — the caller is
   * authorized, at the Project, for the whole composed operation, *before
   * anything is written* — and then call `addNewService` on the row they just
   * inserted. So by the time this runs, the caller has been found entitled to
   * the Project and holds `service: ['create']`, and the Service named here is
   * one statement old and was granted to them by name.
   *
   * Asking for `'update'` on top of that does not add a check; it takes one
   * away, because it asks a question about *rewriting an existing definition*
   * of a Service that has no previous definition to rewrite — the mounts being
   * attached **are** the definition being created. It made `service: ['create']`
   * a statement that cannot be carried to completion: a custom role holding
   * `service: ['create', 'read']` authorized the stack, wrote it, was granted
   * it, and was then refused its own config files, with the compose row left
   * standing. The operation is atomic to the operator and it failed halfway.
   *
   * What is deliberately *not* skipped is everything that answers a different
   * question. `volume: ['create']` still runs, because a caller who may not
   * have a volume at all may not have one here either; `checkServiceAccess` at
   * `'read'` still runs, because the row-level half of it reads
   * `accessedServices` and that is the entitlement question — *which* Service —
   * which `CONTEXT.md`'s Service entry separates from the level. It is also why
   * the grant is ordered before the loops in both callers rather than after
   * them. `DomainsService.create`, the sibling in the same two loops, needs no
   * such twin: its `checkServiceAccess` is already `'read'`, and the
   * `domain: ['create']` beside it is the Domain's own resource statement,
   * which the caller genuinely has to hold.
   */
  async createForNewService(ctx: PermissionCtx, data: CreateMountDto) {
    const serviceType = data.serviceType ?? 'application';
    const parent = await this.findParentService(
      ctx,
      data.serviceId,
      serviceType,
    );
    await this.permissions.checkPermission(ctx, { volume: ['create'] });
    await this.permissions.checkServiceAccess(ctx, data.serviceId, 'read');

    return this.insertMount(data, serviceType, parent);
  }

  /**
   * The write both creates share, once their gates have run.
   *
   * The insert is deliberately last. It used to come first, so a build
   * server that could not take the file answered 500 with the row committed —
   * a mount the console lists and the next deploy bind-mounts at a path with
   * nothing behind it. Nothing had to be minted to make the reorder possible:
   * the write is addressed by the *parent* Service's `appName` and the caller's
   * `filePath`, and `findParentService` already resolved the parent in the
   * caller above. What did have to be decided is what a caller-supplied
   * `filePath` may be, which `dto/mount.dto.ts` answers.
   *
   * No transaction: a host-side write cannot join one, and §2.3
   * forbids holding one open across it. When the write succeeds and the insert
   * then fails, the residue is a file under the service's files directory that
   * no mount row points at — inert, because only a row puts it in a deploy
   * spec, and it is overwritten by the next create at the same path. It is
   * deliberately not swept: a compensating `rm -rf` is the same unreliable
   * second write that ruled out the compensating-delete shape, and its bad day
   * would be deleting a live config file.
   */
  private async insertMount(
    data: CreateMountDto,
    serviceType: WorkloadServiceType,
    parent: ServiceParent,
  ) {
    // A Service in a Cloud account has no container to mount into, and its
    // `serverId: null` would write the file on the platform host — except a
    // stack on its own Stack VM, whose config file is written there.
    refuseMountsInCloud(serviceType, parent);
    const { serviceId, ...rest } = data;
    await refuseWeightsVolumeMount(this.db, { serviceType, serviceId }, data);
    const values = {
      ...rest,
      serviceType,
      // A compose mount may arrive without one, and `mount_path` is
      // `notNull()` with no default (`mount.schema.ts`), so an absent value
      // would be a runtime constraint violation rather than a 400. `''` is the
      // schema's encoding of "no container target"; the column stays NOT NULL
      // because `docker.types.ts` and the console both read it non-nullable.
      mountPath: data.mountPath ?? '',
      [MOUNT_FK_FIELD[serviceType]]: serviceId,
    };

    // A stack whose Stack VM is not made yet has nowhere to write it: the
    // row is the record, and the Cloud run that makes the Stack VM writes
    // the stack's files there before its first Deployment
    // ({@link writeStackVmFiles}, #1379).
    if (values.type === 'file' && !(await this.onUnmadeStackVm(parent))) {
      await this.writeFileMount(values, parent);
    }

    const [created] = await this.db.insert(mount).values(values).returning();
    return created;
  }

  /**
   * Writes every file mount of a stack onto its Stack VM (ADR-0070,
   * #1379): the Cloud run that made a fresh Stack VM calls it once the VM
   * answers, before the stack's first Deployment there binds them, since a
   * file mount made before the VM existed is a row only. Each file is
   * written as {@link create} writes one; no caller session, as the run's
   * authority is the stack row it was handed.
   */
  async writeStackVmFiles(composeId: string): Promise<number> {
    const parent = await findParentService(this.db, null, composeId, 'compose');
    const files = await this.db
      .select()
      .from(mount)
      .where(eq(mount.composeId, composeId));
    let written = 0;
    for (const row of files) {
      if (row.type !== 'file') continue;
      await this.writeFileMount(row, parent);
      written += 1;
    }
    return written;
  }

  /** A stack in a Cloud account whose Stack VM no Cloud run has made yet. */
  private async onUnmadeStackVm(parent: ServiceParent): Promise<boolean> {
    if (parent.composeType === null || !parent.cloudAccountId) return false;
    const [found] = await this.db
      .select({ stackVm: compose.stackVm })
      .from(compose)
      .where(eq(compose.composeId, parent.serviceId));
    return !!found?.stackVm && found.stackVm.made === null;
  }

  /** One mount, access-scoped through the owning service. */
  async findOne(ctx: PermissionCtx, mountId: string) {
    const row = await this.findRow(mountId);
    await this.findParentService(ctx, serviceIdOf(row), row.serviceType);
    await this.permissions.checkServiceAccess(ctx, serviceIdOf(row));
    return row;
  }

  /**
   * A file mount's file is rewritten on the run Server after the row changes
   * ({@link writeFileMount}).
   *
   * **The compose-kind rule is enforced here and not in the schema.**
   * `createMountSchema` refuses a `bind` or a `volume` mount on a Compose
   * stack, because nothing assembles a stack's mount rows into a deploy spec
   * and only a `file` mount is consumed — its own `superRefine` carries the
   * argument. `updateMountSchema` cannot make that call: `serviceType` is
   * deliberately absent from it, since a mount cannot be re-pointed at another
   * service, so the body does not say which kind of parent the row hangs off.
   * `type` *is* in it and the schema is `.partial()`, so a `PATCH` was the way
   * round the create rule — the create-then-patch shape `filePath`'s own
   * comment in that file is about. The stored row is what knows, so the
   * refusal is here, after the gates: a caller with no access to the Service
   * gets the 403 rather than a 400 that tells them what kind of row it is.
   *
   * **A change of kind clears the old kind's source.** A `PATCH` that
   * does not mention a column leaves it as it was, so a volume switched to a
   * bind would otherwise keep `volumeName` beside its new `hostPath` and the
   * row would name two sources. The console used to clear them itself by
   * sending `""`, which `volumeNameSchema` and `filePathSchema` refuse — so
   * every edit it made answered 400. The clear is here instead, keyed on the
   * stored row, so no caller has to know which columns a kind owns.
   */
  async update(ctx: PermissionCtx, mountId: string, data: UpdateMountDto) {
    const current = await this.findRow(mountId);
    const parent = await this.findParentService(
      ctx,
      serviceIdOf(current),
      current.serviceType,
    );
    await this.permissions.checkPermission(ctx, { volume: ['create'] });
    await this.permissions.checkServiceAccess(
      ctx,
      serviceIdOf(current),
      'update',
    );
    refuseMountsInCloud(current.serviceType, parent);
    if (
      current.serviceType === 'compose' &&
      data.type !== undefined &&
      data.type !== 'file'
    ) {
      throw new BadRequestException(
        "A Compose stack only takes a 'file' mount; declare a bind or a " +
          "volume in the stack's own compose file",
      );
    }

    const set =
      data.type !== undefined && data.type !== current.type
        ? { ...UNOWNED_BY[data.type], ...data }
        : data;
    // What the PATCH writes, so retargeting either half at an AI model's
    // weights volume is refused as a create of it is.
    await refuseWeightsVolumeMount(
      this.db,
      { serviceType: current.serviceType, serviceId: serviceIdOf(current) },
      {
        type: set.type ?? current.type,
        volumeName: set.volumeName,
        mountPath: set.mountPath,
      },
    );

    const [updated] = await this.db
      .update(mount)
      .set(set)
      .where(eq(mount.mountId, current.mountId))
      .returning();

    if (updated.type === 'file') {
      await this.writeFileMount(updated, parent);
    }
    return updated;
  }

  /**
   * A file mount's file goes first, then the row.
   *
   * The `rm -rf` target goes through `resolveShellSafePath` rather than
   * straight into the double-quoted word it used to be interpolated into:
   * `$` and a backtick substitute a command inside double quotes, so
   * this was the same injection `getCreateFileCommand` had, on the same stored
   * value, one route later. It is refused rather than escaped for the reason
   * the builder gives.
   *
   * The path is now argv as well, which is belt over braces: the refusal
   * above is what makes this safe, and the argv is what keeps the word out of
   * shell-word review. Neither replaces the other — a path that passes
   * `resolveShellSafePath` can still be the wrong path, and argv would not have
   * made an unconfined one safe.
   *
   * Consequence worth naming: a row whose `filePath` carries a metacharacter
   * now answers 400 on delete instead of running the payload, so the row
   * outlives the request. That is only reachable for a row minted *before* this
   * fix — `create` and `update` no longer write one — and refusing to delete a
   * row is recoverable where running the payload is not.
   */
  async remove(ctx: PermissionCtx, mountId: string) {
    const current = await this.findRow(mountId);
    const parent = await this.findParentService(
      ctx,
      serviceIdOf(current),
      current.serviceType,
    );
    await this.permissions.checkPermission(ctx, { volume: ['delete'] });
    await this.permissions.checkServiceAccess(
      ctx,
      serviceIdOf(current),
      'update',
    );

    // A row saved for a Service in a Cloud account before the create was
    // refused goes, and nothing runs for it: its `serverId: null` names the
    // platform host, which is not where that Service runs. A file an
    // earlier create left there is inert, since no deploy of a cloud Service
    // bind-mounts it.
    if (
      current.type === 'file' &&
      current.filePath &&
      (!isCloudService(parent) || current.serviceType === 'compose')
    ) {
      const place = mountPlace(current.serviceType, parent);
      const fullPath = resolveShellSafePath(
        this.baseFilesPath(current.serviceType, parent.appName, place),
        current.filePath,
      );
      await runTargetOn(place, {
        remoteExec: this.remoteExec,
      }).exec(['rm', '-rf', fullPath]);
    }

    const [removed] = await this.db
      .delete(mount)
      .where(eq(mount.mountId, current.mountId))
      .returning();
    return removed;
  }

  /** One service's mounts, access-scoped through the service. */
  async listByService(ctx: PermissionCtx, query: ListMountsDto) {
    await this.findParentService(ctx, query.serviceId, query.serviceType);
    await this.permissions.checkServiceAccess(ctx, query.serviceId);
    return this.db
      .select()
      .from(mount)
      .where(eq(mountServiceFk[query.serviceType], query.serviceId));
  }

  /** The full row by id, before any access decision needs its parent. */
  private async findRow(mountId: string) {
    const [row] = await this.db
      .select()
      .from(mount)
      .where(eq(mount.mountId, mountId))
      .limit(1);
    if (!row) throw new NotFoundException('Mount not found');
    return row;
  }

  /** The service the mount attaches to, org-scoped (shared helper). */
  private findParentService(
    ctx: PermissionCtx,
    serviceId: string,
    serviceType: ServiceType,
  ) {
    return findParentService(
      this.db,
      ctx.session.activeOrganizationId,
      serviceId,
      serviceType,
    );
  }

  /**
   * File mounts live under the service's files directory — the compose tree
   * for compose services, applications otherwise.
   *
   * **Both arms are rooted on the machine now, and they answer with two
   * different helpers rather than one** (the compose arm was converted first,
   * then the application arm). That is the whole content of this docblock, and
   * the reason the two do not collapse into one expression is that they name
   * two different trees: a stack's file mounts sit in the stack's project tree,
   * an Application's or a database's in the applications tree.
   *
   * The compose arm is rooted on the machine, `composeDirectoryOn(serverId)`.
   * It has to be: this is one of the two *writers* of the compose tree, beside
   * `DeploymentEngineService.deployCompose`'s clone, and the `rm -rf` in
   * {@link remove} is one of its destroyers — so a local root here would have
   * written a stack's config file under a directory the stack's own
   * `docker compose -f` never looks in. A stack has one machine
   * (`findCompose` hard-codes `buildServerId: null`), so the daemon that
   * resolves `{...}/files/...` as the operator's own `volumes:` source is the
   * daemon on the Server the file was written to, and the write and the mount
   * agree by construction.
   *
   * The application arm is rooted on the machine too, and its conversion is
   * what settled that it could be. It was `localCloudgateDirectory` for every
   * machine alike — deliberately, because the path is a bind-mount **source**
   * in a Swarm spec and the earlier reading was that such a path is resolved by
   * neither this process nor a build host and so by neither answer the fork
   * gives. What that missed is that a bind source is a path in the *mounting
   * host's* filesystem, which makes it the **run** Server's root: the remote
   * one, not a third. So this arm and the two consumers of the same string —
   * `mechanize.ts`'s `buildServiceSettings` and
   * `databases/common/database-spec.ts` — moved in one commit, since they
   * agreed until then only by all three spelling the same wrong root.
   * `fileMountsDirectoryOnRunServer` carries the argument and is now the one
   * expression of the path, so the write below and the mount cannot be told
   * apart by an edit to one of them.
   *
   * `serverId` is the run Server (`findParentService`'s column), which is what
   * {@link writeFileMount} already dispatches to and what {@link remove}
   * already sends its `rm -rf` to. It is passed rather than re-derived so that
   * the path and the machine cannot come from two reads.
   */
  private baseFilesPath(
    serviceType: ServiceType,
    appName: string,
    place: string | null,
  ): string {
    return serviceType === 'compose'
      ? `${composeDirectoryOn(place)}/${appName}/files`
      : fileMountsDirectoryOnRunServer(place, appName);
  }

  /** Writes the content onto the service's **run** Server (local exec or SSH
   * by serverId).
   *
   * The run Server and not the build one, which is what `parent.serverId`
   * already is: `findParentService` reads `SERVICE_TABLES[…].serverId`, and an
   * Application's `buildServerId` is a separate column only the engine's
   * `buildHostServerId` resolves. That is the correct host and not an
   * accident — the file is bind-mounted into the container at run time, so it
   * has to exist on the machine that runs it; a dedicated build Server holds
   * the image and never the mount. The docblocks here said "build server"
   * for a while, and the value never did.
   *
   * Takes the three fields it reads rather than a `Mount`, because
   * `create` hands it the value object it is *about* to persist — the file has
   * to be on that Server before the row exists. `update` still hands it a
   * row.
   *
   * **The Service directory above `files` is made `0700` first, and the file
   * keeps its own mode.** The content is what the console tells the
   * operator is *"the right place for a config file that carries a
   * credential"*, and it used to land `0644` under four `0755` directories,
   * readable by the console's `cloudgate` user. It is not written `0600`
   * because a bind-mounted file keeps its host mode and owner inside the
   * container, and the container may run as anybody — U14's was Dex, as
   * `1001`, reading its OIDC client secret out of exactly this file. The
   * daemon resolves the bind source as root when the container starts, so the
   * directory above it is never checked from inside, which is why closing the
   * directory is the whole fix (`common/files/owner-only.ts`). The Service
   * directory rather than `files` itself, because it is the one directory the
   * deploy's `.env` and this share. */
  private async writeFileMount(
    row: {
      serviceType: ServiceType;
      filePath?: string | null;
      content?: string | null;
    },
    parent: Pick<
      ServiceParent,
      'serviceId' | 'appName' | 'serverId' | 'cloudAccountId'
    >,
  ) {
    const place = mountPlace(row.serviceType, parent);
    const filesPath = this.baseFilesPath(
      row.serviceType,
      parent.appName,
      place,
    );
    const command = `${ownerOnlyDirectoryCommand(path.dirname(filesPath))};\n${getCreateFileCommand(
      filesPath,
      row.filePath ?? '',
      row.content ?? '',
    )}`;
    // Where the Service runs (`remote/run-target.ts`): the file is written
    // there, over SSH for a Server, through its tunnel for a stack's Stack
    // VM, and on this machine for the platform host. Its content is
    // decrypted only to be written there.
    await runTargetOn(place, { remoteExec: this.remoteExec }).exec(command);
  }
}

/**
 * Where a mount's file is written, as the id its paths are rooted on and its
 * run target reaches: a stack's Stack VM when it is in a Cloud account
 * (ADR-0070), else the Service's Server, else the platform host.
 */
function mountPlace(
  serviceType: ServiceType,
  parent: Pick<ServiceParent, 'serviceId' | 'serverId' | 'cloudAccountId'>,
): string | null {
  return serviceType === 'compose'
    ? stackRootId({
        composeId: parent.serviceId,
        serverId: parent.serverId,
        cloudAccountId: parent.cloudAccountId,
      })
    : parent.serverId;
}

/**
 * Mounts are Server-only for a Service in a Cloud account
 * (`refuseCloudServiceHostWork`), but a stack there runs on its own Stack VM,
 * which takes its config files as a Server does.
 */
function refuseMountsInCloud(
  serviceType: ServiceType,
  parent: ServiceParent,
): void {
  if (serviceType === 'compose') return;
  refuseCloudServiceHostWork(parent, 'mounts');
}
