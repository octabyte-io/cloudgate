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
  ELASTICACHE_NODE_TYPES,
  machineNamed,
} from '../../cloud-accounts/aws/definitions/database-class';
import { cloudAccount } from '../../cloud-accounts/cloud-account.schema';
import { byCloud, cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { environment } from '../../environments/environment.schema';
import {
  markWiredChanged,
  refuseWhileLinked,
} from '../../project-config/outputs';
import { project } from '../../projects/project.schema';
import type { PermissionCtx } from '../../rbac/permission.service';
import { server } from '../../servers/server.schema';
import {
  CLOUD_REBUILD_REFUSED,
  CLOUD_REBUILD_REFUSED_CODE,
  ELASTICACHE_CANNOT_STOP,
  ELASTICACHE_CANNOT_STOP_CODE,
  MEMORYSTORE_CANNOT_STOP,
  MEMORYSTORE_CANNOT_STOP_CODE,
  cloudDatabaseRefusal,
  existingNeedsCloud,
} from '../common/cloud-database-refusals';
import { BaseDatabaseService } from '../common/database-service';
import type { DatabaseDeleteOptions } from '../common/database-service';
import { existingDatabase } from '../postgres/existing-database.schema';
import type { ExistingDatabase } from '../postgres/existing-database.schema';
import {
  EXISTING_NOT_MANAGED,
  EXISTING_NOT_MANAGED_CODE,
  existingReach,
  leftAsItWas,
} from '../postgres/existing-postgres';
import type { ExistingReach } from '../postgres/existing-postgres';
import type {
  CreateExistingRedisDto,
  CreateRedisDto,
  SaveRedisElastiCacheSettingsDto,
  SaveRedisMemorystoreSettingsDto,
  SwitchToExistingRedisDto,
  UpdateExistingRedisDto,
} from './dto/redis.dto';
import {
  askSwitch,
  dropSwitch,
  switchOf,
  switchView,
} from '../postgres/database-switches';
import type { SwitchView } from '../postgres/database-switches';
import { parseValkeyName } from '../../cloud-accounts/gcp/plan-reader/existing-valkey';
import { REPLICATION_GROUP_ID_REGEX } from './dto/redis.dto';
import { awsConsoleRefusalOf } from '../../native/aws-console-owned';
import { gcpConsoleRefusalOf } from '../../native/gcp-console-owned';
import { cacheOutputsChanged, existingCacheView } from './existing-redis';
import type { ExistingCacheView } from './existing-redis';
import { redis } from './redis.schema';
import type { Redis } from './redis.schema';

/** A redis on Memorystore's own setting, as the API answers it. */
export interface MemorystoreView {
  /** One replica in another zone, two nodes; off by default. */
  readonly highAvailability: boolean;
}

type RedisNested = Redis & {
  environment: typeof environment.$inferSelect & {
    project: typeof project.$inferSelect;
  };
  server: typeof server.$inferSelect | null;
};

/**
 * The name the requirepass entrypoint reads the password out of, invented here
 * so the password never becomes a word of the container's argv.
 *
 * `CG_`-prefixed and index-free on `builders/build-env.ts`' precedent: a holder
 * is the tree's answer to "this value must reach a program without being in the
 * program", and the prefix is what keeps it out of the space of names an
 * operator would plausibly choose. Unlike a build's holders it does share one
 * namespace with the operator's own `env` — see {@link RedisService.defaultEnv}
 * for what that costs and why the alternative costs more.
 */
const REQUIREPASS_HOLDER = 'CG_REDIS_REQUIREPASS';

/**
 * A Delete's answer: the base's, and on an Existing database what was left
 * as it was.
 */
type Removed = Awaited<
  ReturnType<BaseDatabaseService<Redis, RedisNested>['remove']>
> & { left?: { identifier: string; message: string } };

/** Redis: a thin engine spec over the shared database base. */
@Injectable()
export class RedisService extends BaseDatabaseService<Redis, RedisNested> {
  protected readonly engineLabel = 'Redis';
  protected readonly appNamePrefix = 'redis';
  protected readonly serviceType = 'redis' as const;
  protected readonly targetPort = 6379;
  protected readonly table = redis;
  protected readonly columns = {
    id: redis.redisId,
    appName: redis.appName,
    environmentId: redis.environmentId,
    serverId: redis.serverId,
    applicationStatus: redis.applicationStatus,
    configLinks: redis.configLinks,
  };

  /** What its Outputs are built from, by the Outputs module's names. */
  protected readonly outputColumns = { databasePassword: 'password' };

  /**
   * `caps` and `initial` are a Plan's: a plan-created database's
   * `size` and its Config name; the HTTP body carries neither. So is a cloud
   * place: the id its plan read the replication group with, its
   * Cloud account and region, the node type Cloudgate chose when it has no
   * size, and its generated AUTH token.
   */
  create(
    ctx: PermissionCtx,
    data: CreateRedisDto & {
      cpuLimit?: string;
      memoryLimit?: string;
      redisId?: string;
      cloudAccountId?: string;
      region?: string;
      nodeType?: string | null;
      authToken?: string;
    },
    initial?: { configName: string },
  ) {
    return this.createDatabase(ctx, { ...data }, initial);
  }

  /**
   * A redis on ElastiCache is never deployed as a container: its
   * replication group is made by Cloud runs, so a Deploy, Rebuild or Apply
   * that would start one on the platform host is refused, saying so. Its
   * own lifecycle actions are separate.
   */
  override async deployInternal(
    databaseId: string,
    intent: 'start' | 'apply',
  ): Promise<Redis> {
    await this.refuseExisting(databaseId);
    await this.refuseOnElastiCache(
      databaseId,
      'runs in its Cloud account (ElastiCache or Memorystore), so it is never deployed as a container; a plan’s Apply makes its changes',
    );
    return super.deployInternal(databaseId, intent);
  }

  /**
   * An Existing cache's Delete removes only Cloudgate's records of it
   * a redis on ElastiCache's is the base's destroy-only Cloud run
   * with its final snapshot.
   */
  override async remove(
    ctx: PermissionCtx,
    databaseId: string,
    force = false,
    options: DatabaseDeleteOptions = {},
  ): Promise<Removed> {
    const existing = await this.existingOf(databaseId);
    // One whose own state holds what Cloudgate made for it — on Google
    // Cloud its two endpoints — is the cloud Delete's, which
    // destroys only those, and never its data.
    if (existing && !(await this.states?.findForRedis(databaseId))) {
      return this.removeExisting(ctx, databaseId, existing, options);
    }
    const before = existing
      ? (
          await this.db
            .select()
            .from(redis)
            .where(eq(redis.redisId, databaseId))
        )[0]
      : null;
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
   * "Use an existing database" for a `redis`: a redis Service under
   * the Config name of the Environment's entry, whose place is the
   * node-based ElastiCache replication group the operator names, in the
   * Environment's Cloud account and region, fixed from now on (ADR-0035).
   * Gated as any create (`service: ['create']`). It is not a console Save:
   * the Project config does not change, and the entry stays described, so
   * the next plan matches it and creates nothing. Its AUTH token is stored
   * encrypted and never returned, only `hasAuthToken`. Answers it as the
   * API reads it.
   */
  async createExisting(ctx: PermissionCtx, data: CreateExistingRedisDto) {
    const target = await this.existingTargetOf(ctx, data.environmentId);
    if (target?.kind === 'cloud') {
      await this.checkIdentifier(target.cloudAccountId, data);
    }
    // An unknown or foreign Environment is the create's own 404.
    const created = await this.create(
      ctx,
      {
        environmentId: data.environmentId,
        name: data.configName,
        ...(data.authToken ? { authToken: data.authToken } : {}),
      },
      { configName: data.configName },
    );
    if (target?.kind !== 'cloud') throw new Error('unreachable');
    try {
      await this.db.insert(existingDatabase).values({
        redisId: created.redisId,
        cloudAccountId: target.cloudAccountId,
        region: target.region,
        identifier: data.identifier,
        tls: data.tls,
        madeReachable: data.madeReachable,
      });
    } catch (error) {
      await this.db.delete(redis).where(eq(redis.redisId, created.redisId));
      throw error;
    }
    return this.present(await this.findOne(ctx, created.redisId));
  }

  /**
   * An Existing cache's replication group id, AUTH token, TLS flag or
   * reachability tick, edited on its page (`service: ['update']`). The
   * config does not change. An edit that changes its Outputs does so
   * outside a plan, so the Services linking them read "deploy to pick up
   * the new value"; nothing is deployed. An empty token clears it.
   * Answers it as the API reads it.
   */
  async updateExisting(
    ctx: PermissionCtx,
    redisId: string,
    data: UpdateExistingRedisDto,
  ) {
    const owned = await this.findOwnedForUpdate(ctx, redisId);
    const existing = await this.existingOf(owned.id);
    if (!existing) {
      throw new BadRequestException(
        'This redis is not an existing database; its settings are its own',
      );
    }
    await this.checkIdentifier(existing.cloudAccountId, data);
    const { authToken, ...place } = data;
    const [before] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, owned.id));
    const identifier =
      place.identifier !== undefined &&
      place.identifier !== existing.identifier;
    if (Object.keys(place).length > 0) {
      await this.db
        .update(existingDatabase)
        .set({
          // Named column by column: the place never names its Service.
          identifier: place.identifier,
          tls: place.tls,
          madeReachable: place.madeReachable,
          // Another cache: its address is the next lookup's.
          ...(identifier ? { address: null } : {}),
        })
        .where(eq(existingDatabase.redisId, owned.id));
    }
    const token = authToken === undefined ? undefined : authToken || null;
    const updated =
      token === undefined
        ? before
        : await this.updateRow(owned.id, { authToken: token });
    const changed = cacheOutputsChanged({
      token: token !== undefined && token !== before.authToken,
      tls: place.tls !== undefined && place.tls !== existing.tls,
      identifier,
    });
    if (updated.configName && changed.length > 0) {
      await markWiredChanged(
        this.db,
        {
          environmentId: updated.environmentId,
          configName: updated.configName,
        },
        changed,
      );
    }
    return this.present(updated);
  }

  /**
   * An Existing cache's Delete (ADR-0033): refused while a Service links to
   * it, like any database's; otherwise its row, its AUTH token and its
   * lookup's workspace go, and nothing reaches AWS — no snapshot, no "also
   * delete its data", no change to the cache. The config is not rewritten.
   */
  private async removeExisting(
    ctx: PermissionCtx,
    databaseId: string,
    existing: ExistingDatabase,
    options: { readonly linksMoveToReplacement?: boolean },
  ): Promise<Removed> {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'delete');
    const owned = await this.findOwned(ctx, databaseId);
    const [row] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, owned.id));
    const configName = row.configName ?? row.name;
    if (!options.linksMoveToReplacement) {
      await refuseWhileLinked(this.db, {
        environmentId: row.environmentId,
        configName,
      });
    }
    await this.states?.remove(existing.existingDatabaseId);
    const [removed] = await this.db
      .delete(redis)
      .where(eq(redis.redisId, owned.id))
      .returning();
    return {
      ...removed,
      volumeLeftBehind: null,
      left: leftAsItWas(existing.identifier, configName),
    };
  }

  // ── Switching (ADR-0033) ──

  /**
   * A Cloudgate-made redis is to use an existing cache instead: the choice
   * is recorded for its Environment and Config name, and the next plan
   * removes this Service and adds the existing one. Refused on one that is
   * existing already, and where the Deploy target is not a Cloud account,
   * which the lookup runs in. Answers it as the API reads it.
   */
  async switchToExisting(
    ctx: PermissionCtx,
    redisId: string,
    data: SwitchToExistingRedisDto,
  ) {
    const row = await this.switchable(ctx, redisId);
    const existing = await this.existingOf(row.redisId);
    if (existing) {
      throw new BadRequestException(
        `${row.configName} already uses the existing cache ${existing.identifier}; another replication group is edited on its page`,
      );
    }
    const target = await this.existingTargetOf(ctx, row.environmentId);
    if (target?.kind === 'cloud') {
      await this.checkIdentifier(target.cloudAccountId, data);
    }
    await askSwitch(this.db, row, { kind: 'redis', to: 'existing', ...data });
    return this.present(row);
  }

  /** An Existing cache is to become one Cloudgate makes, at the next plan. */
  async switchToMade(ctx: PermissionCtx, redisId: string) {
    const row = await this.switchable(ctx, redisId);
    if (!(await this.existingOf(row.redisId))) {
      throw new BadRequestException(
        `${row.configName} is a cache Cloudgate made already`,
      );
    }
    await askSwitch(this.db, row, { kind: 'redis', to: 'made' });
    return this.present(row);
  }

  /** A switch no Apply has made yet, cancelled: the next plan keeps the Service. */
  async cancelSwitch(ctx: PermissionCtx, redisId: string) {
    const row = await this.switchable(ctx, redisId);
    await dropSwitch(this.db, row);
    return this.present(row);
  }

  private async switchable(
    ctx: PermissionCtx,
    redisId: string,
  ): Promise<Redis> {
    const owned = await this.findOwnedForUpdate(ctx, redisId);
    const [row] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, owned.id));
    return row;
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
    if (target.kind !== 'cloud') throw existingNeedsCloud();
    return existingReach(
      this.db,
      {
        environmentId,
        cloudAccountId: target.cloudAccountId,
        region: target.region,
      },
      6379,
    );
  }

  /**
   * A row as the API answers it: an Existing cache's with where it is and
   * its TLS flag (`existing`), `null` on every other redis, the switch its
   * next plan makes, or `switch: null`, and a redis on Memorystore's
   * own setting (`memorystore`), `null` anywhere else. Its AUTH token
   * is answered as `hasAuthToken` by the controller's interceptor.
   */
  async present<T extends { redisId: string }>(
    row: T & { left?: unknown },
  ): Promise<
    T & {
      existing: ExistingCacheView | null;
      switch: SwitchView | null;
      memorystore: MemorystoreView | null;
    }
  > {
    const existing = row.left ? null : await this.existingOf(row.redisId);
    const pending = row.left ? null : await this.switchViewOf(row.redisId);
    const memorystore = row.left ? null : await this.memorystoreOf(row.redisId);
    return {
      ...row,
      existing: existing ? await this.cacheViewOf(existing) : null,
      switch: pending,
      memorystore,
    };
  }

  /** An existing cache as its page reads it, its cloud's half included. */
  private async cacheViewOf(
    existing: ExistingDatabase,
  ): Promise<ExistingCacheView> {
    const [account] = await this.db
      .select({ cloud: cloudAccount.cloud, cloudId: cloudAccount.cloudId })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, existing.cloudAccountId));
    const [row] = existing.redisId
      ? await this.db
          .select({ environmentId: redis.environmentId })
          .from(redis)
          .where(eq(redis.redisId, existing.redisId))
      : [];
    const cloud = account?.cloud ?? null;
    return existingCacheView(
      existing,
      cloud,
      byCloud(cloudOrLegacy(cloud), {
        aws: null,
        gcp:
          account && row
            ? { projectId: account.cloudId, environmentId: row.environmentId }
            : null,
      }),
    );
  }

  /**
   * Refuses what an existing cache's Cloud account's cloud does not take
   * (ADR-0043): an ElastiCache replication group id on AWS; on Google Cloud
   * a Memorystore instance name, `project/region/instance`, with no
   * AUTH token, since Cloudgate reaches only an `AUTH_DISABLED` Valkey
   * (ADR-0042). Its TLS is read there, never typed.
   */
  private async checkIdentifier(
    cloudAccountId: string,
    data: { readonly identifier?: string; readonly authToken?: string },
  ): Promise<void> {
    const [account] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    const { identifier } = data;
    const refusal = byCloud<() => string | null>(
      cloudOrLegacy(account?.cloud ?? null),
      {
        aws: () =>
          identifier === undefined ||
          REPLICATION_GROUP_ID_REGEX.test(identifier)
            ? null
            : 'identifier must be an ElastiCache replication group id: 1 to 40 letters, digits and hyphens, starting with a letter',
        gcp: () =>
          identifier !== undefined && !parseValkeyName(identifier)
            ? "identifier must be the Memorystore for Valkey instance's name on Google Cloud: project/region/instance"
            : data.authToken
              ? 'An existing cache on Google Cloud takes no AUTH token: Cloudgate reaches only a Valkey instance with authorization off (AUTH_DISABLED), and reads its TLS itself'
              : null,
      },
    )();
    if (refusal) throw new BadRequestException(refusal);
  }

  /** A redis's high availability, when it runs on Memorystore. */
  private async memorystoreOf(
    redisId: string,
  ): Promise<MemorystoreView | null> {
    const [row] = await this.db
      .select({
        cloud: cloudAccount.cloud,
        highAvailability: redis.memorystoreHighAvailability,
      })
      .from(redis)
      .innerJoin(
        cloudAccount,
        eq(cloudAccount.cloudAccountId, redis.cloudAccountId),
      )
      .where(eq(redis.redisId, redisId));
    return row
      ? byCloud(row.cloud, {
          aws: null,
          gcp: { highAvailability: row.highAvailability },
        })
      : null;
  }

  private async switchViewOf(redisId: string): Promise<SwitchView | null> {
    const [row] = await this.db
      .select({
        environmentId: redis.environmentId,
        configName: redis.configName,
        identifier: existingDatabase.identifier,
      })
      .from(redis)
      .leftJoin(existingDatabase, eq(existingDatabase.redisId, redis.redisId))
      .where(eq(redis.redisId, redisId));
    if (!row) return null;
    const found = await switchOf(this.db, row, 'redis');
    return found ? switchView(found, row.identifier) : null;
  }

  override async update(
    ctx: PermissionCtx,
    databaseId: string,
    data: object,
  ): Promise<Redis> {
    const extra = Object.keys(data).filter(
      (key) => key !== 'name' && key !== 'description',
    );
    if (extra.length > 0 && (await this.existingOf(databaseId))) {
      throw new BadRequestException(
        `An existing database is used as given: only its name and description are its settings here; its replication group, AUTH token and TLS are edited on its page (PATCH /redis/${databaseId}/existing), never ${extra.join(', ')}`,
      );
    }
    if ('databasePassword' in data) {
      // Access first, so a caller who may not edit it learns nothing of it.
      const owned = await this.findOwnedForUpdate(ctx, databaseId);
      await this.refuseCloudPassword(owned.id);
    }
    return super.update(ctx, databaseId, data);
  }

  /**
   * A redis Cloudgate made on a cloud is never reached with the Server's
   * password, so it is no setting there: refused before any write,
   * which would mark its linked Services for a value they never get, and
   * only after the caller's access to it is checked.
   */
  private async refuseCloudPassword(redisId: string): Promise<void> {
    const [row] = await this.db
      .select({
        name: redis.name,
        configName: redis.configName,
        cloud: cloudAccount.cloud,
      })
      .from(redis)
      .innerJoin(
        cloudAccount,
        eq(cloudAccount.cloudAccountId, redis.cloudAccountId),
      )
      .where(eq(redis.redisId, redisId));
    if (!row) return;
    const name = row.configName ?? row.name;
    throw new BadRequestException(
      byCloud(row.cloud, {
        gcp: `${name} runs on Memorystore, which has no password: only this Environment's private network reaches it, over TLS`,
        aws: `${name} runs on ElastiCache, where its password is the AUTH token Cloudgate made for it, which is never edited`,
      }),
    );
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
    options?: Parameters<BaseDatabaseService<Redis, RedisNested>['start']>[2],
  ) {
    await this.refuseExisting(databaseId);
    return super.start(ctx, databaseId, options);
  }

  override async stop(
    ctx: PermissionCtx,
    databaseId: string,
    options?: Parameters<BaseDatabaseService<Redis, RedisNested>['stop']>[2],
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
    data: Parameters<
      BaseDatabaseService<Redis, RedisNested>['changeStatus']
    >[2],
  ) {
    await this.refuseExisting(databaseId);
    return super.changeStatus(ctx, databaseId, data);
  }

  /** The Existing database a redis is, or `null` for any other. */
  async existingOf(redisId: string): Promise<ExistingDatabase | null> {
    const [found] = await this.db
      .select()
      .from(existingDatabase)
      .where(eq(existingDatabase.redisId, redisId));
    return found ?? null;
  }

  /** Refuses touching an Existing cache: it is never Cloudgate's to run. */
  private async refuseExisting(redisId: string): Promise<void> {
    if (await this.existingOf(redisId)) {
      throw new ConflictException({
        message: EXISTING_NOT_MANAGED,
        code: EXISTING_NOT_MANAGED_CODE,
      });
    }
  }

  /**
   * The Environment's Deploy target when it is in this organization, so an
   * existing cache is looked up in its Cloud account; refused when it is
   * not a Cloud account. `null` for an unknown or foreign Environment.
   */
  private async existingTargetOf(ctx: PermissionCtx, environmentId: string) {
    const [env] = await this.db
      .select({
        deployTarget: environment.deployTarget,
        organizationId: project.organizationId,
      })
      .from(environment)
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(eq(environment.environmentId, environmentId));
    const target =
      env?.organizationId === ctx.session.activeOrganizationId
        ? env.deployTarget
        : null;
    if (target && target.kind !== 'cloud') throw existingNeedsCloud();
    return target;
  }

  /**
   * Cloudgate's own settings of a redis on ElastiCache, from its cloud
   * Database page: stored on the Service, never in the config, and
   * applied by the next plan's Apply, whose plan shows each one moving.
   * Refused on a redis that is not on ElastiCache, a redis on Memorystore
   * among them, whose node type is its size's or its `native.gcp`
   * `node_type`'s and whose own settings are its Memorystore ones; the
   * node type only for
   * an entry with no size (the size decides it otherwise, so the config is
   * where to change it), and only one Cloudgate chooses.
   */
  async saveElastiCacheSettings(
    ctx: PermissionCtx,
    redisId: string,
    data: SaveRedisElastiCacheSettingsDto,
  ): Promise<Redis> {
    const owned = await this.findOwnedForUpdate(ctx, redisId);
    const [row] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, owned.id));
    const name = row.configName ?? row.name;
    if (!row.cloudAccountId) {
      throw new BadRequestException(
        `${name} does not run on ElastiCache, so it has no ElastiCache settings; its size and version are its own settings`,
      );
    }
    // Where each cloud keeps a redis's own settings (ADR-0043). On
    // Memorystore a node type here would be written unplanned, and a
    // replica and snapshot days are not its settings.
    const [account] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, row.cloudAccountId));
    const elsewhere = byCloud(cloudOrLegacy(account?.cloud ?? null), {
      aws: null,
      gcp: `${name} runs on Memorystore, not ElastiCache, so it has no ElastiCache settings: its node type is its size's, or its native.gcp node_type's, in the Project config, and its high availability and backup retention are its Memorystore settings (PATCH /redis/${owned.id}/memorystore-settings)`,
    });
    if (elsewhere !== null) throw new BadRequestException(elsewhere);
    // A setting the config's `native.aws` sets is the config's, its
    // size-bearing class or node type too:
    // native wins, and this page may not change it while it does.
    const native = awsConsoleRefusalOf(
      name,
      row.nativeAws,
      (['replica', 'snapshotRetentionDays', 'nodeType'] as const).filter(
        (setting) => data[setting] !== undefined,
      ),
    );
    if (native) throw new ConflictException(native);
    if (data.nodeType !== undefined) {
      if (row.nodeType === null) {
        throw new BadRequestException(
          `${name}'s node type comes from its size in the Project config; change size in ${name}'s entry there`,
        );
      }
      if (!machineNamed(ELASTICACHE_NODE_TYPES, data.nodeType)) {
        throw new BadRequestException(
          `${data.nodeType} is not a node type Cloudgate chooses; choose one of ${ELASTICACHE_NODE_TYPES.types.map((one) => one.name).join(', ')}`,
        );
      }
    }
    return this.updateRow(owned.id, { ...data });
  }

  /**
   * A redis on Memorystore's high availability (spec "Redis on
   * Memorystore") and backup retention: Cloudgate's own settings,
   * never in the config, so a plan from the Project config never moves
   * them. Saved here, each plans as its change (the replica's addition or
   * removal, the retention's move) until the next Apply makes it in place.
   * Refused for a redis on a Server, the platform host or ElastiCache,
   * naming where its own settings are.
   */
  async saveMemorystoreSettings(
    ctx: PermissionCtx,
    redisId: string,
    data: SaveRedisMemorystoreSettingsDto,
  ): Promise<Redis> {
    const owned = await this.findOwnedForUpdate(ctx, redisId);
    const [row] = await this.db
      .select({
        name: redis.name,
        configName: redis.configName,
        cloud: cloudAccount.cloud,
        nativeGcp: redis.nativeGcp,
      })
      .from(redis)
      .leftJoin(
        cloudAccount,
        eq(cloudAccount.cloudAccountId, redis.cloudAccountId),
      )
      .where(eq(redis.redisId, owned.id));
    const name = row.configName ?? row.name;
    if (row.cloud === null) {
      throw new BadRequestException(
        `${name} does not run on Memorystore, so it has no high availability setting: that is a setting of a redis Cloudgate makes on Google Cloud`,
      );
    }
    // Where each cloud keeps a redis's high availability (ADR-0043).
    const elsewhere = byCloud(row.cloud, {
      aws: `${name} runs on ElastiCache, not Memorystore: its replica is one of its ElastiCache settings (PATCH /redis/${owned.id}/elasticache-settings)`,
      gcp: null,
    });
    if (elsewhere !== null) throw new BadRequestException(elsewhere);
    // A setting the config's `native.gcp` sets is the config's:
    // native wins, and this page may not change it while it does.
    const native = gcpConsoleRefusalOf(
      name,
      row.nativeGcp,
      (['highAvailability', 'backupRetentionDays'] as const).filter(
        (setting) => data[setting] !== undefined,
      ),
    );
    if (native) throw new ConflictException(native);
    return this.updateRow(owned.id, {
      ...(data.highAvailability === undefined
        ? {}
        : { memorystoreHighAvailability: data.highAvailability }),
      // Its Backups tab's retention, planned as a change of it.
      ...(data.backupRetentionDays === undefined
        ? {}
        : { memorystoreBackupRetentionDays: data.backupRetentionDays }),
    });
  }

  /**
   * A redis in a Cloud account's lifecycle (spec "Lifecycle";
   * spec "Stop and Start"): neither ElastiCache nor
   * Memorystore has a stopped state, so Start, Stop and a status write are
   * refused with the one way to stop its bill, in its cloud's name, and
   * Rebuild because its data goes by a Delete only.
   */
  protected override async inCloud(
    redisId: string,
    action: 'start' | 'stop' | 'rebuild' | 'status',
  ): Promise<Redis | null> {
    const [row] = await this.db
      .select({
        cloudAccountId: redis.cloudAccountId,
        cloud: cloudAccount.cloud,
      })
      .from(redis)
      .leftJoin(
        cloudAccount,
        eq(cloudAccount.cloudAccountId, redis.cloudAccountId),
      )
      .where(eq(redis.redisId, redisId));
    if (!row?.cloudAccountId) return null;
    if (action === 'rebuild') {
      throw cloudDatabaseRefusal(
        CLOUD_REBUILD_REFUSED,
        CLOUD_REBUILD_REFUSED_CODE,
      );
    }
    // Each cloud's sentence (ADR-0043); a Cloud account gone reads as AWS.
    const [message, code] = byCloud(cloudOrLegacy(row.cloud), {
      aws: [ELASTICACHE_CANNOT_STOP, ELASTICACHE_CANNOT_STOP_CODE],
      gcp: [MEMORYSTORE_CANNOT_STOP, MEMORYSTORE_CANNOT_STOP_CODE],
    });
    throw cloudDatabaseRefusal(message, code);
  }

  private async refuseOnElastiCache(redisId: string, why: string) {
    const [row] = await this.db
      .select({ name: redis.name, cloudAccountId: redis.cloudAccountId })
      .from(redis)
      .where(eq(redis.redisId, redisId));
    if (row?.cloudAccountId) throw new ConflictException(`${row.name} ${why}`);
  }

  protected idOf(row: Redis): string {
    return row.redisId;
  }

  protected queryById(redisId: string) {
    return this.db.query.redis.findFirst({
      where: eq(redis.redisId, redisId),
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
  }

  /**
   * No database name or user to announce.
   *
   * `REDIS_PASSWORD` is the operator's — it is what an application in the same
   * network reads to build a connection string, and it is why this engine has a
   * `defaultEnv` at all. {@link REQUIREPASS_HOLDER} is this file's, and it
   * carries the same value under a machine-made name so that
   * {@link containerCommand} can *reference* the password instead of spelling
   * it. Two names for one value in one `Env` array is not a second audience:
   * `ContainerSpec.Env` already held this value before and holds it after,
   * and everything that can read one name can read the other.
   *
   * **A holder rather than reusing `REDIS_PASSWORD`, for the reason at
   * `builders/build-env.ts`: a value should not travel under a name an operator
   * also writes.** `BaseDatabaseService.deployInternal` concatenates this string
   * and *then* the row's own `env`, and `dotenv`'s parse lets the later
   * assignment win — so `--requirepass "$REDIS_PASSWORD"` would let an operator
   * who sets `REDIS_PASSWORD` in their service environment change the password
   * the server actually enforces, leaving `redis.databasePassword` — the value
   * the console shows and the one this platform believes — silently wrong.
   * Under the holder that operator gets today's behaviour unchanged: a
   * misleading `REDIS_PASSWORD` in their container and a server that still wants
   * the stored password.
   *
   * The residual this paragraph used to describe is closed, in the two halves
   * that were a decision about all six engines rather than about redis.
   * `CG_REDIS_REQUIREPASS` in a row's `env` is refused at the write
   * (`common/reserved-env.ts`), and `REDIS_PASSWORD` — which this engine emits
   * for the operator's benefit and reads nothing back from — is refused there
   * too and overridden at the deploy. This engine is the mirror image of
   * the four whose entrypoints read their own credential: overriding
   * `REDIS_PASSWORD` never changed what the server enforced, only what the
   * operator's applications were told, which is why it is a correctness fix
   * here rather than an authentication one.
   *
   * Pairs rather than a dotenv body — one rule for the six, though
   * this engine's two values are the one column that already has a charset.
   */
  protected defaultEnv(row: RedisNested): Record<string, string> {
    return {
      REDIS_PASSWORD: row.databasePassword,
      [REQUIREPASS_HOLDER]: row.databasePassword,
    };
  }

  protected mountPath(): string {
    return '/data';
  }

  /**
   * The stock image starts an unauthenticated server, so absent a
   * user-supplied command/args the entrypoint enforces the password via
   * requirepass.
   *
   * **The password is expanded here, not written here, and the audience
   * that buys is the Server's own process table.** This is a Docker *API*
   * service spec and not a shell string, so — unlike every credential moved
   * into the environment — neither form of it ever reached an `ExecError` or the deployment
   * log: `buildDatabaseServiceSpec` hands the object to `convergeDatabaseService`,
   * which calls `createService`/`update` over the socket, and nothing on that
   * path carries a `command`. Measured the other question too, on Docker 29.3.1
   * with a real one-node swarm: `docker service inspect` returns
   * `Args` and `Env` side by side in the same `ContainerSpec`, both in clear, to
   * anyone holding that Server's Docker socket. **So moving the value from one
   * to the other buys nothing at all in the spec, and that is why this is not
   * the command-line credential defect one module over.**
   *
   * What it does buy is an audience that needs no socket. `Args` becomes the
   * argv of a real process on the Server, and with `--pid=host` on Docker
   * 29.3.1 that process is `/bin/sh -c redis-server --requirepass <password>`,
   * whose `/proc/<pid>/cmdline` is mode `-r--r--r--` — readable by *every*
   * account on the box, for as long as the container runs — while
   * `/proc/<pid>/environ` is `-r--------`, and `nobody` reading it gets
   * `Permission denied`. `redis-server` itself is not the leak: it rewrites its
   * own argv to `redis-server *:6379`, so the wrapper shell was the whole of it.
   *
   * `exec`, and it is the second half of the same measurement rather than
   * tidiness. Without it dash stays resident as PID 1 with the password in its
   * cmdline **and swallows the shutdown signal**: `docker stop -t 20` against
   * the old shape took **20.17 s** and the log ends at *"Ready to accept
   * connections"* — no RDB save, no *"bye bye"*, the container SIGKILLed when
   * the grace period expired. With `exec` the same stop took **0.16 s** and
   * redis logged *"Saving the final RDB snapshot before exiting … DB saved on
   * disk … Redis is now ready to exit, bye bye…"*. So the 30-second
   * `StopGracePeriod` `database-spec.ts` sets *"so they can flush to disk"* was
   * being spent waiting for a shell that had already ignored the signal, and
   * every Stop, Remove-containers and redeploy of a redis lost whatever was not
   * yet persisted.
   *
   * Double quotes and not single, for the reason `build-env.ts`'s `envFlagWord`
   * gives: the point is that the variable expands, and double quotes still stop
   * word splitting and globbing on a value that is never re-parsed after. The
   * holder is a literal in this file, so there is nothing operator-controlled
   * left in the word — which is also why `DATABASE_PASSWORD_REGEX` becomes
   * belt-and-braces here rather than the defence it was (`redis.dto.ts` says so
   * at its own site).
   */
  protected containerCommand(row: RedisNested) {
    if (row.command || (row.args && row.args.length > 0)) return undefined;
    return {
      Command: ['/bin/sh'],
      Args: ['-c', `exec redis-server --requirepass "$${REQUIREPASS_HOLDER}"`],
    };
  }
}
