import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';

import {
  RDS_CLASSES,
  machineNamed,
} from '../../cloud-accounts/aws/definitions/database-class';
import { RDS_ENGINES } from '../../cloud-accounts/aws/definitions/rds-engines';
import type { RdsEngineName } from '../../cloud-accounts/aws/definitions/rds-engines';
import { cloudAccount } from '../../cloud-accounts/cloud-account.schema';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { SettleClock } from '../../compose/compose.utils';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { RemoteDockerFactory } from '../../docker/remote-docker.factory';
import { byCloud, cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import { parseConnectionName } from '../../cloud-accounts/gcp/plan-reader/existing-cloud-sql';
import { RDS_IDENTIFIER_REGEX } from '../postgres/dto/postgres.dto';
import { environment } from '../../environments/environment.schema';
import { ConsoleSaves } from '../../project-config/console-saves';
import {
  markWiredChanged,
  outputsChangedBy,
  refuseWhileLinked,
} from '../../project-config/outputs';
import { project } from '../../projects/project.schema';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { RemoteExecService } from '../../remote/remote-exec.service';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { IncidentsService } from '../../service-health/incidents.service';
import {
  askSwitch,
  dropSwitch,
  switchOf,
  switchView,
} from '../postgres/database-switches';
import type { SwitchView } from '../postgres/database-switches';
import { existingDatabase } from '../postgres/existing-database.schema';
import type { ExistingDatabase } from '../postgres/existing-database.schema';
import {
  EXISTING_NOT_MANAGED,
  EXISTING_NOT_MANAGED_CODE,
  existingReach,
  existingView,
  leftAsItWas,
} from '../postgres/existing-postgres';
import type {
  ExistingReach,
  ExistingView,
} from '../postgres/existing-postgres';
import { rdsStopOf } from '../postgres/rds-stop';
import type { RdsStopColumns } from '../postgres/rds-stop';
import { CloudDatabaseLifecycle } from './cloud-database-lifecycle';
import { cloudStopView } from './cloud-database-stop';
import type { CloudStopView } from './cloud-database-stop';
import {
  CLOUD_REBUILD_REFUSED,
  CLOUD_REBUILD_REFUSED_CODE,
  RDS_STATUS_IS_AWS,
  RDS_STATUS_IS_AWS_CODE,
  cloudDatabaseRefusal,
  existingNeedsCloud,
} from './cloud-database-refusals';
import { CloudDatabaseDeletes } from './cloud-database-deletes';
import { DATABASE_CONVERGENCE_CLOCK } from './database-convergence';
import { DATABASE_VOLUME_RELEASE_CLOCK } from './database-ops';
import { BaseDatabaseService } from './database-service';
import type { DatabaseDeleteOptions } from './database-service';
import type { DatabaseNested } from './database-service';
import type { OrphanedWorkload } from '../../applications/application-ops';
import type { UnreclaimedArtifact } from '../../common/teardown-steps';
import {
  deleteRdsRow,
  findRdsRow,
  findRdsState,
  rdsExistingColumn,
} from './rds-rows';
import type { RdsRow } from './rds-rows';
import { awsConsoleRefusalOf } from '../../native/aws-console-owned';
import { gcpConsoleRefusalOf } from '../../native/gcp-console-owned';

/** What "Use an existing database" and a switch to one take. */
export interface ExistingLogin {
  readonly identifier: string;
  readonly madeReachable: boolean;
  readonly databaseUser: string;
  readonly databaseName: string;
  readonly databasePassword: string;
}

/**
 * A Delete's answer: the base's, and on an Existing database what was left
 * as it was.
 */
export type RdsRemoved<TRow> = TRow & {
  orphaned?: OrphanedWorkload;
  unreclaimedArtifacts?: UnreclaimedArtifact[];
  volumeLeftBehind: boolean | null;
  left?: { identifier: string; message: string };
};

/** What an Existing database's page edits. */
export type ExistingLoginEdit = Partial<ExistingLogin>;

/** Cloudgate's own settings of an RDS instance, from its cloud Database page. */
export interface RdsSettingsEdit {
  readonly instanceClass?: string;
  readonly storageGb?: number;
  readonly maxStorageGb?: number;
  readonly multiAz?: boolean;
  readonly backupRetentionDays?: number;
}

/**
 * **A database engine RDS can run**: a `postgres` or a `mysql`
 * Everything a database has on RDS beyond a Server's — its
 * Existing database (ADR-0033), its switch to or from one, its
 * RDS settings, its Stop and Start by RDS's own calls, and a
 * refused Deploy, Rebuild and status write — is this one class, parameterised
 * by the engine's kind, so a mysql on RDS has exactly a postgres's
 * behaviour rather than a copy of it.
 */
@Injectable()
export abstract class RdsDatabaseService<
  TRow extends RdsRow,
  TNested extends DatabaseNested & RdsRow,
> extends BaseDatabaseService<TRow, TNested> {
  constructor(
    @Inject(DRIZZLE) db: DrizzleDB,
    permissions: PermissionService,
    dockerFactory: RemoteDockerFactory,
    remoteExec: RemoteExecService,
    instanceMode: InstanceMode,
    @Optional()
    @Inject(DATABASE_VOLUME_RELEASE_CLOCK)
    volumeReleaseClock?: SettleClock,
    @Optional()
    @Inject(DATABASE_CONVERGENCE_CLOCK)
    convergenceClock?: SettleClock,
    @Optional() incidents?: IncidentsService,
    @Optional() consoleSaves?: ConsoleSaves,
    // A Delete in its Cloud account, as the base takes it.
    @Optional() cloudDeletes?: CloudDatabaseDeletes,
    // Stop and Start on RDS and Cloud SQL; the engine's
    // module provides it, and a spec that builds the engine by hand never
    // reaches a cloud place.
    @Optional() private readonly lifecycle?: CloudDatabaseLifecycle,
  ) {
    super(
      db,
      permissions,
      dockerFactory,
      remoteExec,
      instanceMode,
      volumeReleaseClock,
      convergenceClock,
      incidents,
      consoleSaves,
      cloudDeletes,
    );
  }

  /** `postgres` or `mysql`: its RDS engine, and the kind its switches and Outputs are named by. */
  protected abstract readonly rdsKind: RdsEngineName;

  /**
   * The engine's own create, which "Use an existing database" creates the
   * Service with; the engine's generated secrets are its own.
   */
  abstract create(
    ctx: PermissionCtx,
    data: {
      environmentId: string;
      name: string;
      databaseName: string;
      databaseUser: string;
      databasePassword?: string;
    },
    initial?: { configName: string },
  ): Promise<TRow>;

  /**
   * A database on RDS is never deployed as a container: its
   * instance is made and changed by Cloud runs, so a Deploy, Rebuild or
   * Apply that would start one on the platform host is refused, saying so.
   */
  override async deployInternal(
    databaseId: string,
    intent: 'start' | 'apply',
  ): Promise<TRow> {
    await this.refuseExisting(databaseId);
    await this.refuseOnRds(
      databaseId,
      'runs on RDS in its Cloud account, so it is never deployed as a container; a plan’s Apply makes its changes',
    );
    return super.deployInternal(databaseId, intent);
  }

  /**
   * An Existing database's Delete removes only Cloudgate's records of it
   * one on RDS's is the base's destroy-only Cloud run with its
   * final snapshot.
   */
  override async remove(
    ctx: PermissionCtx,
    databaseId: string,
    force = false,
    options: DatabaseDeleteOptions = {},
  ): Promise<RdsRemoved<TRow>> {
    const existing = await this.existingOf(databaseId);
    // One whose own state holds what Cloudgate made for it — on Google
    // Cloud its endpoint and zone — is the cloud Delete's, which
    // destroys only those, and never its data.
    const ownState =
      this.states &&
      (await findRdsState(this.states, this.rdsKind, databaseId));
    if (existing && !ownState) {
      return this.removeExisting(ctx, databaseId, existing, options);
    }
    const before = existing ? await this.rdsRowOf(databaseId) : null;
    const removed = await super.remove(ctx, databaseId, force, {
      ...options,
      ...(existing ? { deleteData: false } : {}),
    });
    return existing
      ? {
          ...removed,
          left: leftAsItWas(
            existing.identifier,
            before?.configName ?? before?.name ?? existing.identifier,
          ),
        }
      : removed;
  }

  // ── Existing database (ADR-0033) ──

  /**
   * The workspace each lookup plans against; it holds nothing, and goes
   * with the Delete. Optional only for the hand-built specs.
   */
  @Optional()
  @Inject(InfrastructureStatesService)
  private readonly states?: InfrastructureStatesService;

  /**
   * "Use an existing database": a Service of this kind under the
   * Config name of the Environment's entry, whose place is the RDS instance
   * the operator names, in the Environment's Cloud account and region,
   * fixed from now on (ADR-0035). Gated as any create (`service:
   * ['create']`). It is not a console Save: the Project config does not
   * change, and the entry stays described, so the next plan matches it and
   * creates nothing. Its login is the apps' own, stored encrypted and never
   * returned. Answers it as the API reads it.
   */
  async createExisting(
    ctx: PermissionCtx,
    data: ExistingLogin & { environmentId: string; configName: string },
  ) {
    const [env] = await this.db
      .select({
        deployTarget: environment.deployTarget,
        organizationId: project.organizationId,
      })
      .from(environment)
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(eq(environment.environmentId, data.environmentId));
    const target =
      env?.organizationId === ctx.session.activeOrganizationId
        ? env.deployTarget
        : null;
    if (target && target.kind !== 'cloud') {
      throw existingNeedsCloud();
    }
    if (target)
      await this.checkIdentifier(target.cloudAccountId, data.identifier);
    // An unknown or foreign Environment is the create's own 404.
    const created = await this.create(
      ctx,
      {
        environmentId: data.environmentId,
        name: data.configName,
        databaseName: data.databaseName,
        databaseUser: data.databaseUser,
        databasePassword: data.databasePassword,
      },
      { configName: data.configName },
    );
    if (target?.kind !== 'cloud') throw new Error('unreachable');
    const id = this.idOf(created);
    try {
      await this.db.insert(existingDatabase).values({
        // Its id column named literally here (parent-id-writes.spec.ts).
        ...(this.rdsKind === 'mysql' ? { mysqlId: id } : { postgresId: id }),
        cloudAccountId: target.cloudAccountId,
        region: target.region,
        identifier: data.identifier,
        madeReachable: data.madeReachable,
      });
    } catch (error) {
      await deleteRdsRow(this.db, this.rdsKind, id);
      throw error;
    }
    return this.present(await this.findOne(ctx, id));
  }

  /**
   * An Existing database's login, identifier or reachability tick, edited
   * on its page (`service: ['update']`). The config does not change. A new
   * login changes its Outputs outside a plan, so the Services linking them
   * read "deploy to pick up the new value"; nothing is deployed.
   * Answers it as the API reads it.
   */
  async updateExisting(
    ctx: PermissionCtx,
    databaseId: string,
    data: ExistingLoginEdit,
  ) {
    const owned = await this.findOwnedForUpdate(ctx, databaseId);
    const current = await this.existingOf(owned.id);
    if (!current) {
      throw new BadRequestException(
        `This ${this.rdsKind} is not an existing database; its settings are its own`,
      );
    }
    const { identifier, madeReachable, ...login } = data;
    if (identifier !== undefined) {
      await this.checkIdentifier(current.cloudAccountId, identifier);
    }
    const before = await this.ownedRdsRow(owned.id);
    if (identifier !== undefined || madeReachable !== undefined) {
      await this.db
        .update(existingDatabase)
        .set({
          ...(identifier === undefined
            ? {}
            : // Another database: its address is the next lookup's.
              { identifier, address: null }),
          ...(madeReachable === undefined ? {} : { madeReachable }),
        })
        .where(eq(rdsExistingColumn(this.rdsKind), owned.id));
    }
    const updated =
      Object.keys(login).length > 0
        ? await this.updateRow(owned.id, login)
        : before;
    const changed = Object.entries(this.outputColumns ?? {})
      .filter(
        ([column]) =>
          before[column as keyof TRow] !== updated[column as keyof TRow],
      )
      .map(([, output]) => output);
    if (updated.configName) {
      await markWiredChanged(
        this.db,
        {
          environmentId: updated.environmentId,
          configName: updated.configName,
        },
        outputsChangedBy(this.rdsKind, changed),
      );
    }
    return this.present(updated);
  }

  /**
   * An Existing database's Delete (ADR-0033): refused while a Service links
   * to it, like any database's; otherwise its row, its saved login and its
   * lookup's workspace go, and nothing reaches AWS — no snapshot, no "also
   * delete its data", no change to the database. The config is not
   * rewritten either: what it lists is the operator's to change.
   */
  private async removeExisting(
    ctx: PermissionCtx,
    databaseId: string,
    existing: ExistingDatabase,
    options: { readonly linksMoveToReplacement?: boolean },
  ): Promise<RdsRemoved<TRow>> {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'delete');
    const owned = await this.findOwned(ctx, databaseId);
    const row = await this.ownedRdsRow(owned.id);
    const configName = row.configName ?? row.name;
    if (!options.linksMoveToReplacement) {
      await refuseWhileLinked(this.db, {
        environmentId: row.environmentId,
        configName,
      });
    }
    await this.states?.remove(existing.existingDatabaseId);
    await deleteRdsRow(this.db, this.rdsKind, owned.id);
    return {
      ...row,
      volumeLeftBehind: null,
      left: leftAsItWas(existing.identifier, configName),
    };
  }

  // ── Switching (ADR-0033) ──

  /**
   * A Cloudgate-made database is to use an existing one instead: the
   * choice is recorded for its Environment and Config name, and the next
   * plan removes this Service and adds the existing one. Refused on one
   * that is existing already, and where the Deploy target is not a Cloud
   * account, which the lookup runs in.
   */
  async switchToExisting(
    ctx: PermissionCtx,
    databaseId: string,
    data: ExistingLogin,
  ) {
    const row = await this.switchable(ctx, databaseId);
    const existing = await this.existingOf(this.idOf(row));
    if (existing) {
      throw new BadRequestException(
        `${row.configName} already uses the existing database ${existing.identifier}; another identifier is edited on its page`,
      );
    }
    const [env] = await this.db
      .select({ deployTarget: environment.deployTarget })
      .from(environment)
      .where(eq(environment.environmentId, row.environmentId));
    if (env?.deployTarget.kind !== 'cloud') {
      throw existingNeedsCloud();
    }
    await this.checkIdentifier(
      env.deployTarget.cloudAccountId,
      data.identifier,
    );
    await askSwitch(this.db, switchPlaceOf(row), {
      kind: this.rdsKind,
      to: 'existing',
      ...data,
    });
    return this.present(row);
  }

  /** An Existing database is to become one Cloudgate makes, at the next plan. */
  async switchToMade(ctx: PermissionCtx, databaseId: string) {
    const row = await this.switchable(ctx, databaseId);
    if (!(await this.existingOf(this.idOf(row)))) {
      throw new BadRequestException(
        `${row.configName} is a database Cloudgate made already`,
      );
    }
    await askSwitch(this.db, switchPlaceOf(row), {
      kind: this.rdsKind,
      to: 'made',
    });
    return this.present(row);
  }

  /** A switch no Apply has made yet, cancelled: the next plan keeps the Service. */
  async cancelSwitch(ctx: PermissionCtx, databaseId: string) {
    const row = await this.switchable(ctx, databaseId);
    await dropSwitch(this.db, switchPlaceOf(row));
    return this.present(row);
  }

  private async switchable(
    ctx: PermissionCtx,
    databaseId: string,
  ): Promise<TRow> {
    const owned = await this.findOwnedForUpdate(ctx, databaseId);
    return await this.ownedRdsRow(owned.id);
  }

  /** What the "Use an existing database" form shows for this Environment. */
  async existingReach(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<ExistingReach> {
    const [env] = await this.db
      .select({
        deployTarget: environment.deployTarget,
        projectId: environment.projectId,
        organizationId: project.organizationId,
      })
      .from(environment)
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(eq(environment.environmentId, environmentId));
    if (!env || env.organizationId !== ctx.session.activeOrganizationId) {
      throw new NotFoundException('Environment not found');
    }
    await this.permissions.checkServiceAccess(ctx, env.projectId, 'create');
    const target = env.deployTarget;
    if (target.kind !== 'cloud') {
      throw existingNeedsCloud();
    }
    return existingReach(
      this.db,
      {
        environmentId,
        cloudAccountId: target.cloudAccountId,
        region: target.region,
      },
      RDS_ENGINES[this.rdsKind].port,
    );
  }

  /**
   * A row as the API answers it: an Existing database's with where it is
   * and only whether its login's password is set, never the password
   * (ADR-0019); `existing: null` on every other one. With the switch its
   * next plan makes, or `switch: null`.
   */
  async present<T extends { databasePassword: string }>(
    row: T & { left?: unknown },
  ): Promise<
    (
      | (T & { existing: null })
      | (Omit<T, 'databasePassword'> & { existing: ExistingView })
    ) & { switch: SwitchView | null }
  > {
    const id = this.idOf(row as unknown as TRow);
    const existing = row.left ? null : await this.existingOf(id);
    const pending = row.left ? null : await this.switchViewOf(id);
    if (!existing && !row.left) {
      return { ...row, existing: null, switch: pending };
    }
    const { databasePassword, ...rest } = row;
    return {
      ...rest,
      existing: existing
        ? existingView(
            existing,
            databasePassword,
            await this.cloudOfAccount(existing.cloudAccountId),
          )
        : null,
      switch: pending,
    } as Omit<T, 'databasePassword'> & {
      existing: ExistingView;
      switch: SwitchView | null;
    };
  }

  private async switchViewOf(databaseId: string): Promise<SwitchView | null> {
    const row = await this.rdsRowOf(databaseId);
    if (!row?.configName) return null;
    const found = await switchOf(this.db, switchPlaceOf(row), this.rdsKind);
    if (!found) return null;
    const existing = await this.existingOf(databaseId);
    return switchView(found, existing?.identifier ?? null);
  }

  override async update(
    ctx: PermissionCtx,
    databaseId: string,
    data: object,
  ): Promise<TRow> {
    const extra = Object.keys(data).filter(
      (key) => key !== 'name' && key !== 'description',
    );
    if (extra.length > 0 && (await this.existingOf(databaseId))) {
      throw new BadRequestException(
        `An existing database is used as given: only its name and description are its settings here; its login and identifier are edited on its page (PATCH /${this.rdsKind}/${databaseId}/existing), never ${extra.join(', ')}`,
      );
    }
    return super.update(ctx, databaseId, data);
  }

  override async saveExternalPort(
    ctx: PermissionCtx,
    databaseId: string,
    data: { externalPort: number | null },
  ) {
    await this.refuseExisting(databaseId);
    return super.saveExternalPort(ctx, databaseId, data);
  }

  override async start(
    ctx: PermissionCtx,
    databaseId: string,
    options?: Parameters<BaseDatabaseService<TRow, TNested>['start']>[2],
  ) {
    await this.refuseExisting(databaseId);
    return super.start(ctx, databaseId, options);
  }

  override async stop(
    ctx: PermissionCtx,
    databaseId: string,
    options?: Parameters<BaseDatabaseService<TRow, TNested>['stop']>[2],
  ) {
    await this.refuseExisting(databaseId);
    return super.stop(ctx, databaseId, options);
  }

  override async rebuild(ctx: PermissionCtx, databaseId: string) {
    await this.refuseExisting(databaseId);
    return super.rebuild(ctx, databaseId);
  }

  override async changeStatus(
    ctx: PermissionCtx,
    databaseId: string,
    data: Parameters<BaseDatabaseService<TRow, TNested>['changeStatus']>[2],
  ) {
    await this.refuseExisting(databaseId);
    return super.changeStatus(ctx, databaseId, data);
  }

  /**
   * Refuses an identifier its Cloud account's cloud does not name an
   * instance by (ADR-0043): an RDS instance identifier on AWS; on Google
   * Cloud a Cloud SQL connection name, `project:region:instance`, for a
   * postgres and a mysql alike.
   */
  private async checkIdentifier(
    cloudAccountId: string,
    identifier: string,
  ): Promise<void> {
    const cloud = await this.cloudOfAccount(cloudAccountId);
    const refusal = byCloud<() => string | null>(cloudOrLegacy(cloud), {
      aws: () =>
        RDS_IDENTIFIER_REGEX.test(identifier)
          ? null
          : 'identifier must be an RDS DB instance identifier: 1 to 63 letters, digits and hyphens, starting with a letter',
      gcp: () =>
        parseConnectionName(identifier)
          ? null
          : "identifier must be the Cloud SQL instance's connection name on Google Cloud: project:region:instance",
    })();
    if (refusal) throw new BadRequestException(refusal);
  }

  /** The cloud of the Cloud account an Existing database is looked up in, or `null` once it is gone. */
  private async cloudOfAccount(cloudAccountId: string) {
    const [found] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    return found?.cloud ?? null;
  }

  /** The Existing database this Service is, or `null` for any other. */
  async existingOf(databaseId: string): Promise<ExistingDatabase | null> {
    const [found] = await this.db
      .select()
      .from(existingDatabase)
      .where(eq(rdsExistingColumn(this.rdsKind), databaseId));
    return found ?? null;
  }

  /** Refuses touching an Existing database: it is never Cloudgate's to run. */
  private async refuseExisting(databaseId: string): Promise<void> {
    if (await this.existingOf(databaseId)) {
      throw new ConflictException({
        message: EXISTING_NOT_MANAGED,
        code: EXISTING_NOT_MANAGED_CODE,
      });
    }
  }

  /**
   * Cloudgate's own settings of a database on RDS, from its cloud Database
   * page: stored on the Service, never in the config, and applied by
   * the next plan's Apply, whose plan shows each one moving. Refused on one
   * that is not on RDS, a postgres on Cloud SQL among them, whose machine
   * is its size's or its `native.gcp` tier's and whose retention is its
   * Backups tab's; the class only for an entry with no size (the size
   * decides it otherwise, so the config is where to change it); a class
   * Cloudgate does not choose; storage below what the instance has (RDS
   * cannot shrink it) or a ceiling below the storage.
   */
  async saveRdsSettings(
    ctx: PermissionCtx,
    databaseId: string,
    data: RdsSettingsEdit,
  ): Promise<TRow> {
    const owned = await this.findOwnedForUpdate(ctx, databaseId);
    const row = await this.ownedRdsRow(owned.id);
    const name = row.configName ?? row.name;
    if (!row.cloudAccountId) {
      throw new BadRequestException(
        `${name} does not run on RDS, so it has no RDS settings; its size and version are its own settings`,
      );
    }
    // Where each cloud keeps a cloud database's own settings (ADR-0043).
    // On Cloud SQL none of these is one: a class here would be written as
    // its tier unplanned, and storage and Multi-AZ are not written at all.
    const elsewhere = byCloud(cloudOrLegacy(await this.cloudOf(row)), {
      aws: null,
      gcp: `${name} runs on Cloud SQL, not RDS, so it has no RDS settings: its machine is its size's, or its native.gcp settings.tier's, in the Project config, and its backup retention is its Backups tab's`,
    });
    if (elsewhere !== null) throw new BadRequestException(elsewhere);
    // A setting the config's `native.aws` sets is the config's, its
    // size-bearing class or node type too:
    // native wins, and this page may not change it while it does.
    const native = awsConsoleRefusalOf(
      name,
      row.nativeAws,
      (
        [
          'storageGb',
          'maxStorageGb',
          'multiAz',
          'backupRetentionDays',
          'instanceClass',
        ] as const
      ).filter((setting) => data[setting] !== undefined),
    );
    if (native) throw new ConflictException(native);
    if (data.instanceClass !== undefined) {
      if (row.instanceClass === null) {
        throw new BadRequestException(
          `${name}'s class comes from its size in the Project config; change size in ${name}'s entry there`,
        );
      }
      if (!machineNamed(RDS_CLASSES, data.instanceClass)) {
        throw new BadRequestException(
          `${data.instanceClass} is not a class Cloudgate chooses; choose one of ${RDS_CLASSES.types.map((one) => one.name).join(', ')}`,
        );
      }
    }
    const made = row.rdsApplied?.storageGb ?? row.storageGb;
    const storageGb = data.storageGb ?? row.storageGb;
    const maxStorageGb = data.maxStorageGb ?? row.maxStorageGb;
    if (storageGb < made) {
      throw new BadRequestException(
        `storageGb cannot go below ${made}: ${name} has ${made} GB, and RDS cannot shrink an instance's storage`,
      );
    }
    if (maxStorageGb < storageGb) {
      throw new BadRequestException(
        `maxStorageGb must be at least storageGb (${storageGb}): it is the ceiling the storage grows to`,
      );
    }
    return this.updateRow(owned.id, { ...data });
  }

  /**
   * A database on Cloud SQL's backup retention (spec "Backups
   * and Delete"), a postgres's or a mysql's: Cloudgate's own
   * setting, edited on its Backups tab and never in the config, so a plan
   * from the Project config never moves it. Saved here, it plans as a
   * change of the instance until the next Apply makes it, with no restart.
   * Refused for one on a Server, the platform host or RDS, naming where its
   * own settings are.
   */
  async saveCloudSqlSettings(
    ctx: PermissionCtx,
    databaseId: string,
    data: { readonly backupRetentionDays: number },
  ): Promise<TRow> {
    const owned = await this.findOwnedForUpdate(ctx, databaseId);
    const row = await this.ownedRdsRow(owned.id);
    const name = row.configName ?? row.name;
    const cloud = await this.cloudOf(row);
    if (cloud === null) {
      throw new BadRequestException(
        `${name} does not run on Cloud SQL, so it has no Cloud SQL settings: its backups are dumps to a Destination`,
      );
    }
    // Where each cloud keeps a database's backup retention (ADR-0043).
    const elsewhere = byCloud(cloud, {
      aws: `${name} runs on RDS, not Cloud SQL: its backup retention is one of its RDS settings (PATCH /${this.rdsKind}/${owned.id}/rds-settings)`,
      gcp: null,
    });
    if (elsewhere !== null) throw new BadRequestException(elsewhere);
    // A backup count the config's `native.gcp` sets is the config's
    // native wins, and this tab may not change it while it does.
    const native = gcpConsoleRefusalOf(name, row.nativeGcp, [
      'backupRetentionDays',
    ]);
    if (native) throw new ConflictException(native);
    return this.updateRow(owned.id, {
      backupRetentionDays: data.backupRetentionDays,
    });
  }

  /** Its stop, as the Database page reads it on its cloud. */
  protected override async readOf(found: TNested): Promise<CloudStopView> {
    return cloudStopView(found, await this.cloudOf(found), new Date());
  }

  /** The cloud of the row's Cloud account, or `null` off one or when it is gone. */
  private async cloudOf(row: RdsStopColumns): Promise<CloudKind | null> {
    if (!row.cloudAccountId) return null;
    const [found] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, row.cloudAccountId));
    return found?.cloud ?? null;
  }

  /**
   * A database in a Cloud account's lifecycle (spec "Lifecycle";
   * spec "Stop and Start"):
   *
   * - **Stop** is its cloud's own, by a direct call: the row reads `stopped`
   *   with, on RDS, the date AWS starts the instance again (stop time + 7
   *   days), and on Cloud SQL no date, since Google never does; the answer
   *   carries Stop's warning. Cloudgate never stops it again.
   * - **Start** is its cloud's own too, and clears the stop record. One AWS
   *   has started again already only has its record cleared: there is
   *   nothing stopped to start.
   * - **Rebuild** is refused: its data goes by a Delete only.
   * - A bare status write is refused: the cloud holds the status.
   */
  protected override async inCloud(
    databaseId: string,
    action: 'start' | 'stop' | 'rebuild' | 'status',
  ): Promise<TRow | null> {
    const row = await this.rdsRowOf(databaseId);
    if (!row?.cloudAccountId || !row.region) return null;
    const name = row.configName ?? row.name;
    const target = {
      serviceId: databaseId,
      name,
      cloudAccountId: row.cloudAccountId,
      region: row.region,
    };
    switch (action) {
      case 'rebuild':
        throw cloudDatabaseRefusal(
          CLOUD_REBUILD_REFUSED,
          CLOUD_REBUILD_REFUSED_CODE,
        );
      case 'status':
        throw cloudDatabaseRefusal(RDS_STATUS_IS_AWS, RDS_STATUS_IS_AWS_CODE);
      case 'stop': {
        const stoppedAt = new Date();
        const { restartsAt } = await this.cloudLifecycle().stop(
          target,
          stoppedAt,
        );
        const stopped = await this.updateRow(databaseId, {
          applicationStatus: 'stopped',
          restartsAt,
        });
        return withStop(stopped, await this.cloudOf(row), stoppedAt);
      }
      case 'start': {
        // Only RDS starts an instance by itself; a Cloud SQL row has no date.
        if (rdsStopOf(row, new Date())?.state !== 'started-by-aws') {
          await this.cloudLifecycle().start(target);
        }
        const started = await this.updateRow(databaseId, {
          applicationStatus: 'done',
          restartsAt: null,
        });
        return withStop(started, await this.cloudOf(row), new Date());
      }
    }
  }

  private cloudLifecycle(): CloudDatabaseLifecycle {
    if (!this.lifecycle) {
      throw new ConflictException(
        'Stop and Start in a Cloud account are not wired into this process',
      );
    }
    return this.lifecycle;
  }

  private async refuseOnRds(databaseId: string, why: string): Promise<void> {
    const row = await this.rdsRowOf(databaseId);
    if (row?.cloudAccountId) throw new ConflictException(`${row.name} ${why}`);
  }

  /**
   * The row of a Service just found owned, whichever table this engine keeps
   * it in: not found, as `findOwned` answers, when it is gone since.
   */
  private async ownedRdsRow(databaseId: string): Promise<TRow> {
    const row = await this.rdsRowOf(databaseId);
    if (!row) throw new NotFoundException(this.notFound());
    return row as TRow;
  }

  /** The Service's row, whichever table this engine keeps it in. */
  private rdsRowOf(databaseId: string): Promise<RdsRow | null> {
    return findRdsRow(this.db, this.rdsKind, databaseId);
  }
}

/** Which Environment's entry a row's switch is of. */
function switchPlaceOf(row: RdsRow): {
  environmentId: string;
  configName: string;
} {
  return { environmentId: row.environmentId, configName: row.configName ?? '' };
}

function withStop<T extends RdsStopColumns>(
  row: T,
  cloud: CloudKind | null,
  now: Date,
): T {
  return Object.assign(row, cloudStopView(row, cloud, now));
}
