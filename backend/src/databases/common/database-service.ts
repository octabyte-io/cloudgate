import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { PortConfig } from 'dockerode';
import { and, eq } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { OrphanedWorkload } from '../../applications/application-ops';
import {
  callerMayName,
  otherServicesClaiming,
  removeVolumeOn,
  VOLUME_RELEASE_TIMEOUT_MS,
} from '../../applications/application-volumes';
import { applicationStatusEnum } from '../../applications/application.schema';
import type { WorkloadServiceType } from '../../applications/application.schema';
import { refuseDeployUntilReady } from '../../bought-servers/server-readiness';
import { refuseWhileInMaintenance } from '../../servers/server-maintenance';
import { checkServerAccess } from '../../common/owned-server';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { workloadKeptRefusal } from '../../common/workload-kept-refusal';
import { runLogOwnersOf } from '../../common/run-log-owners';
import {
  reclaimDeploymentLogs,
  reclaimFileMounts,
} from '../../common/teardown-steps';
import type { UnreclaimedArtifact } from '../../common/teardown-steps';
import { systemSettleClock } from '../../compose/compose.utils';
import { rethrowIfHostUnreachable } from '../../docker-ops/host-reachability';
import type { SettleClock } from '../../compose/compose.utils';
import { cleanAppName, generateAppName } from '../../db/columns';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { ServiceMount } from '../../docker/docker.types';
import { mount, mountServiceFk } from '../../mounts/mount.schema';
import { prepareEnvironmentVariables } from '../../docker/docker.utils';
import { RemoteDockerFactory } from '../../docker/remote-docker.factory';
import { refuseUnchosenInCloud } from '../../environments/deploy-target';
import { environment } from '../../environments/environment.schema';
import {
  claimServiceConfigName,
  mintServiceConfigName,
} from '../../environments/config-name';
import { project } from '../../projects/project.schema';
import type { PermissionCtx } from '../../rbac/permission.service';
import {
  ConsoleSaves,
  KEEP_NOTHING,
  writeKept,
} from '../../project-config/console-saves';
import type { KeepConfig } from '../../project-config/console-saves';
import { PermissionService } from '../../rbac/permission.service';
import { execOnServer } from '../../remote/exec-dispatch';
import { RemoteExecService } from '../../remote/remote-exec.service';
import { nestedServer } from '../../servers/nested-server';
import type { NestedServer } from '../../servers/nested-server';
import type { Server } from '../../servers/server.schema';
import { IncidentsService } from '../../service-health/incidents.service';
import {
  DATABASE_VOLUME_RELEASE_CLOCK,
  databaseServicePresence,
  databaseVolumeLeftBehind,
  removeDatabaseService,
  removeDatabaseVolumeWhenReleased,
  scaleDatabaseService,
  VolumeStillInUseError,
} from './database-ops';
import type { ScaleOptions } from './database-ops';
import { CloudDatabaseDeletes } from './cloud-database-deletes';
import type {
  CloudDatabaseTarget,
  FinalSnapshotPreview,
} from './cloud-database-deletes';
import {
  awaitDatabaseDeploy,
  DATABASE_CONVERGENCE_CLOCK,
  DEPLOY_REQUEST_WAIT_MS,
} from './database-convergence';
import type {
  ConvergeResult,
  DatabaseDeployVerdict,
} from './database-convergence';
import { blameNativeDocker } from '../../native/docker-native';
import type { DatabaseSpecSource } from './database-spec';
import {
  buildDatabaseServiceSpec,
  convergeDatabaseService,
} from './database-spec';
import { generateDatabasePassword } from './database.constants';
import { withEngineEnv } from './reserved-env';
import {
  clearWiredChanged,
  isLinkingType,
  markWiredChanged,
  outputsChangedBy,
  refuseTypedLinkedNames,
  refuseWhileLinked,
  wiredEnv,
} from '../../project-config/outputs';
import type { ConfigLinks } from '../../project-config/project-config.types';

/**
 * The `application_status` values a managed database's row takes.
 *
 * `'stopped'` is the one no row is created with: `'idle'` is the column's
 * default, so until `'stopped'` existed a database an operator had scaled to zero and one that
 * had never been deployed were the same value, and the console said `idle` over
 * a Swarm service sitting at 0/0. Spelled out rather than derived from
 * `ApplicationStatus` because these five are the lifecycle this base writes —
 * `applicationStatusEnum` is the column's type and carries the migration.
 */
export type DatabaseStatus = (typeof applicationStatusEnum.enumValues)[number];

/** What the shared lifecycle reads off any engine's row: the service-spec
 * source plus the env chain resolved through environment → project. */
export type DatabaseNested = DatabaseSpecSource & {
  /** Read by {@link BaseDatabaseService.deployInternal}, which keeps a
   * `stopped` database stopped on a settings save. */
  applicationStatus: DatabaseStatus;
  env: string | null;
  serverId: string | null;
  environmentId: string;
  /** The wired variables its config entry applied, on the kinds a
   * Project config describes. */
  configLinks?: ConfigLinks | null;
  /** The `server` relation every engine's `queryById` loads whole — declared
   * here so {@link SanitizedDatabaseRead} can project it for the six reads
   * that answer a caller. The raw row stays on `queryById`, which
   * {@link BaseDatabaseService.deployInternal} shares with `findOne`. */
  server: Server | null;
  environment: {
    env: string | null;
    project: { env: string | null; organizationId: string };
  };
};

/**
 * An engine's row as {@link BaseDatabaseService.findOne} answers with it: the
 * `server` relation projected per `common/service-read-relations.ts`.
 *
 * `queryById` is deliberately *not* the seam. It is shared with
 * `deployInternal`, which is internal and takes the row whole, and the six
 * engines each spell their own — so a projection there would be six edits and
 * would have to be undone for the deploy path. `findOne` is one method for all
 * six engines and is the only one of the two that answers a controller.
 */
export type SanitizedDatabaseRead<T extends DatabaseNested> = Omit<
  T,
  'server'
> & { server: NestedServer | null };

/**
 * What Docker said, for an operator-facing message: the command's stderr when
 * there is one — `ExecError` carries it, with payloads already elided — else
 * the error's message, trimmed and capped so a runaway stream stays readable.
 */
const dockerSaid = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const said = (
    typeof stderr === 'string' && stderr.trim() !== ''
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error)
  ).trim();
  return said.length > 500 ? `${said.slice(0, 500)}…` : said;
};

/** The drizzle columns the shared lifecycle queries on the engine's table.
 * Property names are shared across engines; only the table differs. */
export interface DatabaseTableColumns {
  id: AnyPgColumn;
  appName: AnyPgColumn;
  environmentId: AnyPgColumn;
  serverId: AnyPgColumn;
  /** Read by the deploy verdict's write, which lands only on a row still
   * `running`. */
  applicationStatus: AnyPgColumn;
  /** The applied wired variables, on the kinds a Project config
   * describes; a typed value for one of those names is refused. */
  configLinks?: AnyPgColumn;
}

/** What a database's Delete is asked with, beyond `force`. */
export interface DatabaseDeleteOptions {
  /**
   * An Apply's destroy of a database the same plan creates again under its
   * Config name (a kind change): the links to it name the new one.
   */
  readonly linksMoveToReplacement?: boolean;
  /**
   * "Also delete its data": only a database's own Delete or a cloud
   * database's Plan destroy asks it, never an Environment's Delete. In a
   * Cloud account it skips the final snapshot; on a Server it removes
   * `<appName>-data` once the service is confirmed gone (#1413).
   */
  readonly deleteData?: boolean;
}

/**
 * The engines share everything except the image, env variables and data mount
 * path: this base carries the shared CRUD, deploy lifecycle, status, external
 * port and rebuild, while engines override only their spec ingredients.
 */
@Injectable()
export abstract class BaseDatabaseService<
  TRow extends { appName: string },
  TNested extends DatabaseNested,
> {
  constructor(
    @Inject(DRIZZLE) protected readonly db: DrizzleDB,
    protected readonly permissions: PermissionService,
    private readonly dockerFactory: RemoteDockerFactory,
    private readonly remoteExec: RemoteExecService,
    // Refuses a create on the platform host on the Hosted instance.
    protected readonly instanceMode: InstanceMode,
    // Optional with the system clock as its default, so a module that builds
    // an engine without binding the token still boots; each engine module
    // binds it anyway, because that binding is what a suite overrides.
    @Optional()
    @Inject(DATABASE_VOLUME_RELEASE_CLOCK)
    private readonly volumeReleaseClock: SettleClock = systemSettleClock,
    // The same arrangement, for the deploy's wait on Swarm.
    @Optional()
    @Inject(DATABASE_CONVERGENCE_CLOCK)
    private readonly convergenceClock: SettleClock = systemSettleClock,
    // The Stop hook: every engine module imports `ServiceHealthModule`
    // for it. Optional only so a spec that builds an engine by hand with the
    // first four still compiles; the probe tick's sweep closes what a missing
    // hook would leave open.
    @Optional()
    private readonly incidents?: IncidentsService,
    // Console Saves on a Cloudgate-kept config: a create, a settings
    // write and a Delete keep the Project config in step. Every engine module
    // imports `ConsoleSavesModule`; optional for the hand-built specs above.
    @Optional()
    private readonly consoleSaves?: ConsoleSaves,
    // A postgres's or redis's Delete in a Cloud account: a
    // destroy-only Cloud run that keeps a final snapshot. Only those two
    // engine modules bind it; every other engine has no cloud place.
    @Optional()
    private readonly cloudDeletes?: CloudDatabaseDeletes,
  ) {}

  /**
   * The deploy each database's verdict belongs to, so an older deploy's
   * verdict never writes over a newer one's. A process-wide counter,
   * not a per-database one, so a number is never reused once its entry is
   * dropped. In memory, because the verdict it guards runs in this process;
   * the `running` condition on the write covers a Stop or Rebuild in between.
   */
  private static deployCounter = 0;
  private readonly currentDeploy = new Map<string, number>();

  /** Named for the base rather than the engine: the one thing logged from here
   * is a shared decision about the six, and it names the engine in the
   * line rather than in the context. */
  private readonly logger = new Logger(BaseDatabaseService.name);

  /** 'Postgres' / 'MySQL' / … — names the engine in error messages. */
  protected abstract readonly engineLabel: string;
  /** Prefix for generated appNames, e.g. 'postgres'. */
  protected abstract readonly appNamePrefix: string;
  /** The engine's serviceType discriminator — keys its mount rows. */
  protected abstract readonly serviceType: WorkloadServiceType;
  /** The engine's in-container port, published against externalPort. */
  protected abstract readonly targetPort: number;
  /** The engine's drizzle table and the columns the base queries on it. */
  protected abstract readonly table: PgTable;
  protected abstract readonly columns: DatabaseTableColumns;

  /** The row's primary key value. */
  protected abstract idOf(row: TRow): string;
  /** The row with environment → project and server relations resolved. */
  protected abstract queryById(id: string): Promise<TNested | undefined>;
  /**
   * The engine's env pairs derived from the connection columns
   * (POSTGRES_* / MYSQL_* / …). The row's own operator-written env is resolved
   * separately by the base and these are laid over the top of it.
   *
   * **A `Record` and not a dotenv body.** These values came from
   * columns with no charset — `databaseName` and `databaseUser` are
   * `z.string().min(1)` — and interpolating them into a quoted dotenv line
   * made them an injection into `ContainerSpec.Env` rather than a value in it.
   * {@link withEngineEnv} carries the measurement and the two alternatives it
   * rejects; every key returned here must appear in `ENGINE_ENV_OWNERS` for the
   * engine, which `test/databases/reserved-env.spec.ts` pins.
   */
  protected abstract defaultEnv(row: TNested): Record<string, string>;
  /** Where the engine keeps its data inside the container. */
  protected abstract mountPath(row: TNested): string;

  /** An engine-supplied entrypoint that beats the row's command/args columns
   * (Mongo's replica-set bootstrap, Redis's requirepass wrapper). Default:
   * none — the row's own command/args drive the spec. */
  protected containerCommand(
    row: TNested,
  ): { Command: string[]; Args: string[] } | undefined {
    void row;
    return undefined;
  }

  /** Engine-supplied published ports that beat the single externalPort →
   * targetPort mapping (LibSQL publishes http/grpc/admin). Default: none. */
  protected publishedPorts(row: TNested): PortConfig[] | undefined {
    void row;
    return undefined;
  }

  /**
   * Resolves the target environment inside the caller's organization,
   * requires service:create on its project, inserts with the unique-appName
   * check, then grants the creator row-level access.
   * An omitted password is generated server-side; engines with extra
   * secret columns default them in their own create().
   *
   * An unknown or unowned `serverId` is refused 404 before the insert; nullish
   * is the platform host.
   *
   * `initial.configName` is a Plan's: the config entry's key, claimed
   * as it is rather than minted from the display name. A plan-created
   * database's caps ride in `data`, so the Apply writes them in this insert
   * and needs no `service: update` on a Service it is still creating.
   */
  protected async createDatabase(
    ctx: PermissionCtx,
    data: {
      environmentId: string;
      /** The display name, which the Config name is minted from. */
      name: string;
      appName?: string;
      databasePassword?: string;
      /**
       * Nullish is the platform host, and both spellings reach here from the
       * engines' `.nullish()` DTOs — `checkServerAccess` returns
       * undefined for either, which is ADR-0008's contract. Named
       * explicitly because the `Record<string, unknown>` below would otherwise
       * swallow it and the check would have nothing to read.
       */
      serverId?: string | null;
    } & Record<string, unknown>,
    initial?: { configName: string },
  ): Promise<TRow> {
    // A plan's own create is the plan's step, not a console Save.
    if (initial || !this.consoleSaves) {
      return this.insertDatabase(ctx, data, KEEP_NOTHING, initial);
    }
    return this.consoleSaves.create(
      ctx,
      { serviceType: this.serviceType, environmentId: data.environmentId },
      (keep) => this.insertDatabase(ctx, data, keep),
    );
  }

  private async insertDatabase(
    ctx: PermissionCtx,
    data: Parameters<BaseDatabaseService<TRow, TNested>['createDatabase']>[1],
    keep: KeepConfig,
    initial?: { configName: string },
  ): Promise<TRow> {
    const parent = await this.findParentEnvironment(ctx, data.environmentId);
    await this.permissions.checkServiceAccess(ctx, parent.projectId, 'create');
    // After the permission gate, never before: the refusal for an unknown id
    // and for one in another organization are both 404 on purpose — so the
    // fleet is not enumerable — and running this first would let a caller with
    // no service:create tell them apart from a 403. Before this, an unknown
    // serverId reached the insert and the foreign key answered 500 for what is
    // a 404; because that check was the database's it could not be
    // organization-scoped at all, so any existing server_id satisfied it,
    // whoever owned it. Covers all six engines: every one of them is a
    // two-line delegation to this method.
    //
    // No Server and no Cloud account is the platform host: refused on the
    // Hosted instance (ADR-0053 seam 3). A plan's cloud create names
    // its Cloud account; ADR-0008's Self-hosted branch is unchanged.
    if (!data.serverId && !data.cloudAccountId) {
      this.instanceMode.refusePlatformHost('services');
    }
    // A console create that leaves the Server out of a cloud Environment is
    // asked for one rather than put on the platform host. A plan's
    // create, and "Use an existing database", are `initial` and say their own
    // place.
    if (!initial) refuseUnchosenInCloud(data.serverId, parent.deployTarget);
    await checkServerAccess(this.db, ctx, data.serverId);

    const appName = data.appName
      ? cleanAppName(data.appName)
      : generateAppName(this.appNamePrefix);

    const created = await this.db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: this.columns.id })
        .from(this.table)
        .where(eq(this.columns.appName, appName))
        .limit(1);
      if (taken) {
        throw new ConflictException(
          `${this.engineLabel} with this 'appName' already exists`,
        );
      }
      const configName = initial
        ? await claimServiceConfigName(
            tx,
            data.environmentId,
            initial.configName,
          )
        : await mintServiceConfigName(
            tx,
            data.environmentId,
            this.serviceType,
            data.name,
          );
      const [row] = await tx
        .insert(this.table)
        .values({
          ...data,
          appName,
          configName,
          databasePassword: data.databasePassword || generateDatabasePassword(),
        })
        .returning();
      await keep(tx, { serviceId: this.idOf(row as TRow) });
      return row as TRow;
    });

    await this.permissions.addNewService(ctx, this.idOf(created));
    return created;
  }

  /**
   * Row-level service access, org-scoped through environment → project. The row
   * is the connection info — databaseName, databaseUser, databasePassword,
   * externalPort.
   *
   * **This is all six engines' read, and it is where the nested `server`
   * relation is projected**. `metricsConfig.server.token` is the whole
   * of `POST /notifications/receive`'s authentication and a base member with
   * one id in `accessedServices` reaches this method; the rule it follows is
   * `common/service-read-relations.ts`'.
   */
  async findOne(
    ctx: PermissionCtx,
    databaseId: string,
  ): Promise<SanitizedDatabaseRead<TNested>> {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'read');

    const found = await this.queryById(databaseId);
    if (
      !found ||
      found.environment.project.organizationId !==
        ctx.session.activeOrganizationId
    ) {
      throw new NotFoundException(this.notFound());
    }
    return {
      ...found,
      server: nestedServer(found.server),
      ...(await this.readOf?.(found)),
    };
  }

  /**
   * What an engine's read adds beside its row: a postgres or a mysql in a
   * Cloud account's stop. Absent on the engines that add
   * nothing.
   */
  protected readOf?(
    found: TNested,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;

  /** Permission-gated entry to deployInternal. */
  async deploy(ctx: PermissionCtx, databaseId: string) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const owned = await this.findOwned(ctx, databaseId);
    return this.deployInternal(owned.id, 'start');
  }

  /**
   * Pulls the image onto the target server, then converges the swarm service
   * onto the row's spec — image, engine env derived from the connection
   * columns, and the appName-derived data volume. Status tracks running → done,
   * error on failure — and `done` only once Swarm has run the new spec, not
   * when it accepted it. The request answers within
   * `DEPLOY_REQUEST_WAIT_MS`: decided by then it is `done` or a 409 saying why,
   * and otherwise `running`, with the verdict writing the row when it lands.
   *
   * **`intent` is required, and it is what keeps a stopped database stopped.**
   * The spec's replica count is the row's `replicas`, which a Stop
   * does not touch — Stop is a `docker service scale` to zero, not a column —
   * so every converge used to start the service again. For an explicit Deploy
   * or Rebuild that is the point (`'start'`). For a settings save that
   * converges the definition (`'apply'`: the published ports) it brought a
   * database the operator had deliberately stopped back up, and the console
   * said nothing. So on a row reading `stopped`, `'apply'` writes the spec with
   * no tasks — the settings are on the service, where Start, which only
   * scales, picks them up — and leaves the status alone: there is nothing
   * running for Swarm to decide, so no verdict to wait for. Required rather
   * than defaulted so a new caller has to say which it means.
   *
   * It keys on `stopped`, so a database stopped before that status existed — whose row still
   * reads `idle`, the word a never-deployed one wears — is still started by
   * an `'apply'`. The two cannot be told apart from the row, and nothing
   * rewrites those rows (the same gap `application.schema.ts` records);
   * pressing Stop once more makes the row say `stopped`.
   */
  async deployInternal(databaseId: string, intent: 'start' | 'apply') {
    const found = await this.queryById(databaseId);
    if (!found) throw new NotFoundException(this.notFound());

    if (intent === 'apply' && found.applicationStatus === 'stopped') {
      await this.convergeSpec(found, databaseId, { replicas: 0 });
      const [row] = await this.db
        .select()
        .from(this.table)
        .where(eq(this.columns.id, databaseId));
      return row as TRow;
    }

    // Nothing is deployed to a Bought Server until it is Ready (spec #1387).
    await refuseDeployUntilReady(this.db, [found.serverId]);
    // Nor to a Server in maintenance (spec #1420).
    await refuseWhileInMaintenance(this.db, [found.serverId]);

    const clock = this.convergenceClock;
    const requestStartedAt = clock.now();
    const deploy = ++BaseDatabaseService.deployCounter;
    this.currentDeploy.set(databaseId, deploy);

    const running = await this.updateStatus(databaseId, 'running');
    // Its wired variables are built inside the converge; a notice
    // marked before now is answered by this deploy.
    const builtAt = new Date().toISOString();
    let docker: Awaited<ReturnType<RemoteDockerFactory['getRemoteDocker']>>;
    let converged: ConvergeResult;
    let mounts: ServiceMount[];
    try {
      ({ docker, converged, mounts } = await this.convergeSpec(
        found,
        databaseId,
      ));
    } catch (error) {
      await this.settleStatus(databaseId, deploy, 'error');
      throw this.lifecycleFailed(error, 'deploy', found);
    }

    // Docker accepting the spec is not the database running it. A new
    // image the data directory refused was rolled back by Swarm seconds later
    // while this row already read `done` with that image listed. So the status
    // waits for Swarm's decision — but the request does not wait for all of
    // it: the verdict's budget reaches fifteen minutes and the console's proxy
    // gives up at four. The request waits `DEPLOY_REQUEST_WAIT_MS` and answers
    // with whatever is decided by then — `done`, or a 409 carrying why, which
    // the console shows as it is — and past that answers `running`, which the
    // console polls, and the same verdict writes the row when it lands.
    const settled = awaitDatabaseDeploy(
      docker,
      found.appName,
      { ...found, mounts },
      converged,
      { engineLabel: this.engineLabel, clock },
    ).then(
      (verdict) =>
        this.settleDeploy(databaseId, deploy, found.appName, verdict, builtAt),
      (error: unknown) =>
        this.settleDeploy(databaseId, deploy, found.appName, {
          failed: true,
          reason: `Cloudgate could not read whether Swarm ran the ${this.engineLabel} deploy of ${found.appName} — ${dockerSaid(error)}`,
        }),
    );
    // The branch the request may have stopped waiting for still has to land
    // somewhere if the write itself fails.
    settled.catch((error: unknown) => {
      this.logger.error(
        `${found.appName}: the ${this.engineLabel} deploy's status could not be written — ${dockerSaid(error)}`,
      );
    });

    const waitMs = Math.max(
      0,
      DEPLOY_REQUEST_WAIT_MS - (clock.now() - requestStartedAt),
    );
    const answer = await Promise.race([
      settled,
      clock.sleep(waitMs).then(() => null),
    ]);
    if (answer === null) {
      this.logger.log(
        `${found.appName}: Swarm had not decided the ${this.engineLabel} deploy within ${Math.round(DEPLOY_REQUEST_WAIT_MS / 1000)}s; answering running and writing the status when it does`,
      );
      return running;
    }
    if (answer.verdict.failed) {
      throw new ConflictException(answer.verdict.reason);
    }
    return answer.row ?? running;
  }

  /**
   * Pulls the image onto the target server, then converges the swarm service
   * onto the row's spec — {@link deployInternal}'s Docker half, shared by its
   * two arms. `replicas: 0` writes the spec with no tasks, for a
   * database that is stopped and must stay so.
   */
  private async convergeSpec(
    found: TNested,
    databaseId: string,
    options: { replicas?: 0 } = {},
  ): Promise<{
    docker: Awaited<ReturnType<RemoteDockerFactory['getRemoteDocker']>>;
    converged: ConvergeResult;
    mounts: ServiceMount[];
  }> {
    // `dockerImage` is writable through `PATCH /{engine}/:id`, which a plain
    // member reaches (`service:['update']` now — `['read']` before
    // the operate level), as is the deploy below
    // (`deployment:['create']`) — so this word arrived from the caller and
    // lands in `execAsync` / `execAsyncRemote` on the database's Server.
    //
    // Worded rather than refused: an image reference is user-meaningful, and
    // the same value was already settled the same way one module over
    // (`git-providers/strategies/docker.strategy.ts`, which single-quotes with
    // its own local `shEscape` because that file already had one). It
    // landed here as a `quote()` at this site, since replaced with argv, so
    // the word is `execOnServer`'s to join — locally not through a shell at
    // all, remotely through one `quote()` with a test on it. Same emitted
    // word, one fewer place to remember.
    //
    // **The column is no longer a bare `z.string()` on the six DTOs, and this
    // argv does not derive from that** (H-53). It carries
    // `databaseImageSchema` now — `distribution/reference`'s grammar, the
    // belt-and-braces half `builders/build-strategy.ts` names — and the argv
    // stays for the reason `docker.strategy.ts` keeps its own `shEscape`
    // after H-47: rows written before that rule are stored unrevalidated, a
    // `.partial()` PATCH that omits the column never parses it, and this line
    // reads the row rather than a body. Two jobs, two places, on purpose.
    await execOnServer(this.remoteExec, found.serverId, [
      'docker',
      'pull',
      found.dockerImage,
    ]);

    // The operator's own env is resolved on its own and the engine's derived
    // variables are laid over the top, rather than the two being concatenated
    // into one dotenv body for `parse` to settle by later-wins.
    //
    // That concatenation was two defects in one line. The operator's half
    // could assign `POSTGRES_PASSWORD` and win, so the server enforced a
    // credential `databasePassword` did not hold — the reserved-env mechanism, outside
    // the `CG_` prefix it reserved. And the engine's half interpolated
    // charset-free columns into quoted dotenv values, so a `databaseName`
    // carrying a `"` and a newline wrote *extra keys* into the container's
    // environment. `reserved-env.ts` argues both and names what was rejected.
    //
    // The operator loses one thing here and it is deliberate: a `${{KEY}}`
    // self-reference in a database's own env can no longer name one of the
    // engine's derived variables, because those are no longer in the body
    // `prepareEnvironmentVariables` resolves against — such a reference now
    // fails the deploy by that function's own contract instead of resolving.
    // Nothing in `src/`, `backend/test/` or the console writes one, the
    // container holds the value under its real name regardless, and the
    // alternative was to keep rendering the engine's values into text for the
    // reference namespace — which is the lossy step this change exists to
    // remove, and would have let a reference resolve to a *different* value
    // than the variable it names.
    const engineEnv = this.defaultEnv(found);
    const { env, overridden } = withEngineEnv(
      prepareEnvironmentVariables(
        found.env,
        found.environment.project.env,
        found.environment.env,
        // Its wired variables, built now and never saved on the row.
        await wiredEnv(this.db, found.environmentId, found.configLinks),
      ),
      engineEnv,
    );
    if (overridden.length > 0) {
      // The one real objection to shadowing is that it discards what someone
      // typed and says nothing (`reserved-env.ts`). The write refuses these
      // now, so reaching here means a row saved before that rule — and this
      // is the only moment there is to say so.
      this.logger.warn(
        `${found.appName}: ignoring ${overridden.join(', ')} from this ${this.engineLabel}'s environment — Cloudgate derives ${overridden.length === 1 ? 'it' : 'them'} from the row and gave the container the stored value`,
      );
    }
    // The engine's data volume plus the row's user mounts (Phase 33).
    const userMounts = await this.db
      .select()
      .from(mount)
      .where(eq(mountServiceFk[this.serviceType], databaseId));
    const mounts: ServiceMount[] = [
      {
        type: 'volume',
        volumeName: `${found.appName}-data`,
        mountPath: this.mountPath(found),
      },
      ...userMounts,
    ];
    const built = buildDatabaseServiceSpec(
      { ...found, mounts },
      {
        env,
        targetPort: this.targetPort,
        containerCommand: this.containerCommand(found),
        ports: this.publishedPorts(found),
      },
    );

    // A stopped database's spec keeps it stopped. Only a replicated
    // mode has a count to hold at zero, and only a replicated service can have
    // been stopped: Stop is `docker service scale`, which Swarm refuses for a
    // global one.
    const replicated = built.Mode?.Replicated;
    const settings =
      options.replicas === 0 && replicated
        ? {
            ...built,
            Mode: { ...built.Mode, Replicated: { ...replicated, Replicas: 0 } },
          }
        : built;

    const docker = await this.dockerFactory.getRemoteDocker(found.serverId);
    // A value only Docker can judge fails the Deployment naming its native
    // path, when the Engine's refusal names one this database sets.
    const converged = await convergeDatabaseService(
      docker,
      found.appName,
      settings,
    ).catch((error: unknown) => {
      throw blameNativeDocker(error, found);
    });
    return { docker, converged, mounts };
  }

  /**
   * Write a deploy's verdict: its reason to the log always, and its
   * status to the row only through {@link settleStatus}'s two conditions.
   */
  private async settleDeploy(
    databaseId: string,
    deploy: number,
    appName: string,
    verdict: DatabaseDeployVerdict,
    builtAt?: string,
  ): Promise<{ verdict: DatabaseDeployVerdict; row: TRow | undefined }> {
    if (verdict.failed) {
      this.logger.warn(verdict.reason);
    } else if (!verdict.confirmed) {
      this.logger.warn(
        `${appName}: Swarm accepted the ${this.engineLabel}'s spec but had not confirmed it running when the wait ran out; marking it done, as nothing failed`,
      );
    }
    const row = await this.settleStatus(
      databaseId,
      deploy,
      verdict.failed ? 'error' : 'done',
    );
    if (!verdict.failed && builtAt && isLinkingType(this.serviceType)) {
      await clearWiredChanged(
        this.db,
        { serviceType: this.serviceType, serviceId: databaseId },
        builtAt,
      );
    }
    return { verdict, row };
  }

  /**
   * A deploy's closing status write, made only while it is still the latest
   * deploy of this database **and** the row still reads `running`: a newer
   * deploy owns the row once it starts, and a Stop or a Rebuild in between
   * wrote a status this one must not undo. Undefined when it did not
   * write.
   */
  private async settleStatus(
    databaseId: string,
    deploy: number,
    status: 'done' | 'error',
  ): Promise<TRow | undefined> {
    if (this.currentDeploy.get(databaseId) !== deploy) return undefined;
    this.currentDeploy.delete(databaseId);
    const [updated] = await this.db
      .update(this.table)
      .set({ applicationStatus: status })
      .where(
        and(
          eq(this.columns.id, databaseId),
          eq(this.columns.applicationStatus, 'running'),
        ),
      )
      .returning();
    return updated as TRow | undefined;
  }

  /** Updates the row, access-scoped through findOwnedForUpdate. */
  async update(
    ctx: PermissionCtx,
    databaseId: string,
    data: object,
  ): Promise<TRow> {
    return this.saved(ctx, databaseId, async (keep) => {
      const owned = await this.findOwnedForUpdate(ctx, databaseId);
      const before = await this.rowOf(owned.id);
      const updated = await this.updateRow(owned.id, { ...data }, keep);
      await this.markLinkedServices(before, updated);
      return updated;
    });
  }

  /**
   * The Outputs (ADR-0031) each of this engine's columns feeds, by the
   * Outputs module's name for it (`user`, `password`, `database`); absent on
   * an engine that hands out none.
   */
  protected readonly outputColumns?: Readonly<Record<string, string>>;

  private async rowOf(id: string): Promise<Record<string, unknown>> {
    const [row] = await this.db
      .select()
      .from(this.table)
      .where(eq(this.columns.id, id));
    return row;
  }

  /**
   * A settings write that changed what an Output is built from (a login
   * edited in the console) marks every Service linking to one of those
   * Outputs "deploy to pick up the new value", and deploys nothing.
   */
  private async markLinkedServices(
    before: Record<string, unknown>,
    after: TRow,
  ) {
    if (!this.outputColumns) return;
    const changed = Object.entries(this.outputColumns)
      .filter(
        ([column]) =>
          before[column] !== (after as Record<string, unknown>)[column],
      )
      .map(([, setting]) => setting);
    const row = after as unknown as {
      environmentId: string;
      configName: string;
    };
    await markWiredChanged(
      this.db,
      row,
      outputsChangedBy(this.serviceType, changed),
    );
  }

  /**
   * A console write to a database's settings, kept in step with a
   * Cloudgate-kept Project config.
   */
  private saved<T>(
    ctx: PermissionCtx,
    databaseId: string,
    write: (keep: KeepConfig) => Promise<T>,
  ): Promise<T> {
    if (!this.consoleSaves) return write(KEEP_NOTHING);
    return this.consoleSaves.update(
      ctx,
      { serviceType: this.serviceType, serviceId: databaseId },
      write,
    );
  }

  /** Saves env, which lands in an encrypted column. */
  async saveEnvironment(
    ctx: PermissionCtx,
    databaseId: string,
    data: { env: string | null },
  ): Promise<TRow> {
    return this.saved(ctx, databaseId, async (keep) => {
      const owned = await this.findOwnedForUpdate(ctx, databaseId);
      await this.refuseLinkedNames(owned.id, data.env);
      return this.updateRow(owned.id, { env: data.env }, keep);
    });
  }

  /**
   * Refuses typing a value for a name the Project config links (ADR-0031),
   * so a variable has one source.
   */
  private async refuseLinkedNames(id: string, env: string | null) {
    if (!this.columns.configLinks || !env) return;
    const [row] = (await this.db
      .select({ links: this.columns.configLinks })
      .from(this.table)
      .where(eq(this.columns.id, id))) as { links: ConfigLinks | null }[];
    refuseTypedLinkedNames(env, row?.links);
  }

  /** A direct status write. */
  async changeStatus(
    ctx: PermissionCtx,
    databaseId: string,
    data: { applicationStatus: DatabaseStatus },
  ) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const owned = await this.findOwned(ctx, databaseId);
    const onCloud = await this.inCloud?.(owned.id, 'status');
    if (onCloud) return onCloud;
    return this.updateStatus(owned.id, data.applicationStatus);
  }

  /**
   * A Start, Stop, Rebuild or status write of a database in a Cloud account
   * what it does there instead of its Swarm service's, or the 409
   * that refuses it. `null` for one on a Server or the platform host, whose
   * action goes on as it always has. Each action calls it once its
   * permission and `findOwned` have passed, so a refusal never tells a
   * caller without access that the id resolves. Only the engines with a
   * cloud place (postgres on RDS, redis on ElastiCache) have it.
   */
  protected inCloud?(
    databaseId: string,
    action: 'start' | 'stop' | 'rebuild' | 'status',
  ): Promise<TRow | null>;

  /**
   * Teardown of the swarm service, then the row.
   * Volumes survive — only rebuild destroys data.
   *
   * **A teardown that cannot be confirmed refuses the delete.** The
   * order here was already right; what was wrong was the swallowed failure.
   * `docker service rm` used to run inside a bare try/catch whose comment said
   * "the row still goes: a dead server must not make deletion impossible" —
   * and the verification host caught exactly that: a `postgres-i6xyp8` still
   * `Up` twenty-four hours after its row was deleted, visible to all six
   * organizations on the box. The row is the only handle the product has on the
   * workload, so dropping it while the service still runs does not leave litter:
   * per ADR-0008 a container that resolves to no Service is *unmanaged*, reached
   * through machine-level `docker:read` "where there is no Service to ask
   * about", and with "managed" deciding access that means readable and actable by every
   * organization on the host. This is a case where there *was* a Service to ask
   * about and the product destroyed the ability to ask; ADR-0008 does not
   * authorise that.
   *
   * The constraint the old comment was protecting is real, so it survives as
   * `force`: a Server that is never coming back must not strand a row forever.
   * It is now a deliberate act with a truthful answer — the response names what
   * was left behind instead of a bare 200.
   *
   * **And it reclaims a filesystem tree, which is new for this
   * method and for the whole module.** Before this, `src/databases/` contained no
   * `rm -rf` at all — `removeDatabaseService` and `removeDatabaseVolume` are
   * `docker service rm` and `docker volume rm` — while
   * `MountsService.baseFilesPath`'s non-compose arm answers
   * `fileMountsDirectoryOnRunServer` for a managed database exactly as it does
   * for an Application, so a `file` mount on a database materialized a
   * plaintext file that nothing in the product ever removed. `mount` is keyed
   * to the row by `mountServiceFk` and cascades, so the statement below
   * destroyed the encrypted rows and left the plaintext copy behind — on
   * **every** install, not merely on one with a dedicated build Server, which
   * is what made this the worse half of the leak.
   */
  async remove(
    ctx: PermissionCtx,
    databaseId: string,
    force = false,
    /**
     * An Apply's destroy of a database the same plan creates again under
     * its Config name (a kind change): the links to it name the new
     * one, so they do not refuse this Delete. `deleteData` is "also
     * delete its data": no final snapshot in a Cloud account, the data
     * volume removed on a Server.
     */
    options: DatabaseDeleteOptions = {},
  ): Promise<
    TRow & {
      orphaned?: OrphanedWorkload;
      unreclaimedArtifacts?: UnreclaimedArtifact[];
      /** Whether `<appName>-data` is still on the Server; `null` when that
       * could not be read (`databaseVolumeLeftBehind`). */
      volumeLeftBehind: boolean | null;
    }
  > {
    const remove = (keep: KeepConfig) =>
      this.removeRow(ctx, databaseId, force, keep, options);
    if (!this.consoleSaves) return remove(KEEP_NOTHING);
    return this.consoleSaves.remove(
      ctx,
      { serviceType: this.serviceType, serviceId: databaseId },
      remove,
    );
  }

  private async removeRow(
    ctx: PermissionCtx,
    databaseId: string,
    force: boolean,
    keep: KeepConfig,
    options: DatabaseDeleteOptions,
  ): Promise<
    TRow & {
      orphaned?: OrphanedWorkload;
      unreclaimedArtifacts?: UnreclaimedArtifact[];
      /** Whether `<appName>-data` is still on the Server; `null` when that
       * could not be read (`databaseVolumeLeftBehind`). */
      volumeLeftBehind: boolean | null;
    }
  > {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'delete');
    const owned = await this.findOwned(ctx, databaseId);
    // Refused while a Service links to it (ADR-0031), before anything
    // is torn down; `force` is about an unreachable Server, not this.
    if (this.columns.configLinks && !options.linksMoveToReplacement) {
      const row = (await this.rowOf(owned.id)) as {
        environmentId: string;
        configName: string;
      };
      await refuseWhileLinked(this.db, row);
    }
    // In a Cloud account the Delete is a destroy-only Cloud run
    // (ADR-0038): the row stays, `deleting`, until it finishes clean.
    const cloud = await this.cloudTargetOf(owned.id);
    if (cloud) {
      const row = await this.requireCloudDeletes().request(ctx, cloud, keep, {
        retrying: false,
        deleteData: options.deleteData === true,
      });
      return { ...(row as unknown as TRow), volumeLeftBehind: null };
    }
    try {
      await removeDatabaseService(
        this.remoteExec,
        owned.serverId,
        owned.appName,
      );
    } catch {
      // Still best-effort: what is left is decided by the presence read below,
      // not by whether this threw.
    }

    const presence = await databaseServicePresence(
      this.remoteExec,
      owned.serverId,
      owned.appName,
    );
    if (presence !== 'absent' && !force) {
      throw workloadKeptRefusal(
        presence,
        presence === 'present'
          ? `Swarm service ${owned.appName} is still running, so the ${this.engineLabel} was kept: deleting the record would leave the workload unreachable through Cloudgate — stop it, then delete again, or delete with ?force=true`
          : `Cloudgate could not reach Docker to confirm swarm service ${owned.appName} is gone, so the ${this.engineLabel} was kept — delete again when the server is reachable, or delete with ?force=true`,
      );
    }

    // The file-mounts tree, on this database's own Server. Reused from
    // `common/teardown-steps.ts` rather than written a second time here, and
    // the reuse is exact: that helper takes `{ appName, serverId }` and a
    // database's `serverId` *is* its run Server — there is no build-host fork
    // to resolve, which makes this the simpler half of the fix rather than a
    // second mechanism. One database per call, because this route deletes one
    // row; `common/service-cascade.ts`' `fileMountOwnersOf` is the same
    // reclamation over a whole Project, and the two had to land together or the
    // rule would hold on a Project delete and drift on this one (ADR-0018).
    //
    // **After the refusal and before the row**, ADR-0016's slot, and the
    // argument measured for an Application transfers here unchanged
    // because it is an argument about the *writer*: `writeFileMount` has
    // exactly two callers, `MountsService.create` and `.update`, so nothing
    // re-materializes a file mount — a deploy only reads the path back as a
    // bind source (`database-spec.ts`' `generateFileMounts`), and `rebuild`
    // drops the service and the data volume without touching it. Removing the
    // tree ahead of the 409 above would therefore strip the init scripts and
    // config files off a database the caller is then told still exists, with no
    // path back short of re-saving every mount by hand. The refusal shape here
    // is the same one: teardown, presence read, `ConflictException` unless
    // `force`, then the row.
    //
    // Unconditional rather than gated on whether this database has a `file`
    // mount: a gate is a `select` per delete, and it would make the removal a
    // branch the common install never takes — which is how this defect stayed
    // invisible in the first place. `rm -rf` exits 0 for a path that is not
    // there.
    const unreclaimedArtifacts = [
      ...(await reclaimFileMounts(this.remoteExec, [
        { appName: owned.appName, serverId: owned.serverId },
      ])),
      // And the run logs of its backups and volume backups: those rows
      // cascade from this one, each wrote `{logs}/{appName}` under its own
      // `backup-…` / `volume-backup-…` name on this Server, and nothing else
      // would remove them. Same slot, for the same reason — a kept database
      // keeps its backup history. A database writes no Deployment of its own.
      ...(await reclaimDeploymentLogs(
        this.remoteExec,
        await runLogOwnersOf(this.db, [
          { serviceId: databaseId, serverId: owned.serverId },
        ]),
      )),
      ...(options.deleteData
        ? await this.removeDataVolume(
            ctx,
            { ...owned, id: databaseId },
            presence === 'absent',
          )
        : []),
    ];

    // Delete keeps the data volume unless asked; whether one is left is the
    // Server's to say, because a database never deployed has none and a
    // removal asked for can be kept. Never throws — a read that fails is
    // `null`, and the delete goes on.
    const volumeLeftBehind = await databaseVolumeLeftBehind(
      this.remoteExec,
      owned.serverId,
      `${owned.appName}-data`,
    );

    // Absent rather than empty, on `ApplicationsService.remove`'s rule: a bare
    // `unreclaimedArtifacts: []` on every healthy delete would make the field
    // mean "this route can leak a tree" instead of "this tree was left behind".
    const leftBehind =
      unreclaimedArtifacts.length > 0 ? { unreclaimedArtifacts } : {};
    // The row goes in the transaction its console Save's config rewrite
    // commits in.
    const removed = await writeKept(
      this.db,
      keep,
      async (db) => {
        const [row] = await db
          .delete(this.table)
          .where(eq(this.columns.id, owned.id))
          .returning();
        return row;
      },
      () => ({
        serviceId: owned.id,
        removed: { ...leftBehind, volumeLeftBehind },
      }),
    );
    if (presence === 'absent') {
      return { ...(removed as TRow), ...leftBehind, volumeLeftBehind };
    }
    return {
      ...(removed as TRow),
      ...leftBehind,
      volumeLeftBehind,
      orphaned: {
        appName: owned.appName,
        serverId: owned.serverId,
        reason: presence,
      },
    };
  }

  /**
   * "Also delete its data" on a Server (#1413): `<appName>-data` removed on
   * the database's own Server, under its Volume lock and once its task lets
   * go — `removeVolumeOn`, the Application Delete's `?deleteVolumes=true`
   * removal, reused so the two take the lock the same way. Glossary,
   * **Delete**: "its volumes destroyed only on request".
   *
   * In ADR-0016's slot, after the presence refusal: a volume held by a running
   * task cannot be removed, and a database the caller is told still exists
   * must keep its data. A forced Delete whose service was not confirmed gone
   * touches nothing. And a volume another Service on the same Server mounts
   * is kept, through `otherServicesClaiming` — the Application Delete's own
   * check (its reason 1), because a stopped Application or a stack that is
   * down holds no container on it and `docker volume rm` would destroy its
   * data without a word from Docker. Either way a volume kept is a `'volume'`
   * report line, never a failed Delete — the row goes, as an Application's
   * does.
   */
  private async removeDataVolume(
    ctx: PermissionCtx,
    owned: { id: string; appName: string; serverId: string | null },
    serviceGone: boolean,
  ): Promise<UnreclaimedArtifact[]> {
    const volumeName = `${owned.appName}-data`;
    const why = serviceGone
      ? await this.removeUnclaimedVolume(ctx, owned, volumeName)
      : `Kept: the ${this.engineLabel}'s Swarm service could not be confirmed gone, so its data volume was not touched`;
    return why
      ? [
          {
            kind: 'volume',
            appName: owned.appName,
            serverId: owned.serverId,
            path: volumeName,
            reason: why,
          },
        ]
      : [];
  }

  /** `null` once removed, or why the volume was kept: another Service on the
   * same Server claiming it, its Volume lock held, or Docker refusing. */
  private async removeUnclaimedVolume(
    ctx: PermissionCtx,
    owned: { id: string; serverId: string | null },
    volumeName: string,
  ): Promise<string | null> {
    const claims = await otherServicesClaiming(
      {
        db: this.db,
        canName: (owner) => callerMayName(this.permissions, ctx, owner),
      },
      {
        serviceType: this.serviceType,
        serviceId: owned.id,
        serverId: owned.serverId,
      },
      [volumeName],
    );
    return (
      claims.get(volumeName) ??
      removeVolumeOn(
        this.remoteExec,
        owned.serverId,
        volumeName,
        Date.now() + VOLUME_RELEASE_TIMEOUT_MS,
      )
    );
  }

  /**
   * Whether this database's data volume is on its Server now — the Delete
   * dialog's read, before it is confirmed. `present` is
   * {@link databaseVolumeLeftBehind}'s answer: `true`, `false` only on a
   * positive "not here" from a one-node swarm, `null` when it cannot be known.
   *
   * Guarded exactly as {@link remove} is — the route's `service:delete` and the
   * row-level `'delete'` access — because it is that dialog's question and
   * nobody else's, and a read looser than the action it describes would answer
   * people who cannot take it.
   */
  /**
   * The final snapshot a Delete pressed now would keep, for the Delete
   * dialog of a database in a Cloud account: its name and about what it
   * costs a month. Guarded as the Delete is; `null` off a Cloud account.
   */
  async finalSnapshot(
    ctx: PermissionCtx,
    databaseId: string,
  ): Promise<FinalSnapshotPreview | null> {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'delete');
    const owned = await this.findOwned(ctx, databaseId);
    const cloud = await this.cloudTargetOf(owned.id);
    return cloud ? this.requireCloudDeletes().preview(cloud) : null;
  }

  /**
   * **Retry** a cloud database's incomplete Delete (ADR-0038): another
   * destroy-only Cloud run from the kept state, keeping the snapshot the
   * Delete named. `service: delete`, as the Delete.
   */
  async retryCloudDelete(ctx: PermissionCtx, databaseId: string) {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'delete');
    const owned = await this.findOwned(ctx, databaseId);
    const cloud = await this.cloudTargetOf(owned.id);
    if (!cloud) throw new NotFoundException('This Service has no cloud Delete');
    return this.requireCloudDeletes().request(ctx, cloud, KEEP_NOTHING, {
      retrying: true,
      deleteData: false,
    });
  }

  /**
   * **Forget** a cloud database's incomplete Delete (ADR-0038): the row
   * dropped with what is left still in AWS, the list in the audit entry.
   */
  async forgetCloudDelete(ctx: PermissionCtx, databaseId: string) {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'delete');
    const owned = await this.findOwned(ctx, databaseId);
    const cloud = await this.cloudTargetOf(owned.id);
    if (!cloud) throw new NotFoundException('This Service has no cloud Delete');
    return this.requireCloudDeletes().forget(ctx, cloud);
  }

  /** The database's cloud place and Delete record, or `null` off a Cloud account. */
  private async cloudTargetOf(
    databaseId: string,
  ): Promise<CloudDatabaseTarget | null> {
    if (
      this.serviceType !== 'postgres' &&
      this.serviceType !== 'mysql' &&
      this.serviceType !== 'redis'
    ) {
      return null;
    }
    if (!this.cloudDeletes) return null;
    return this.cloudDeletes.targetOf(this.serviceType, databaseId);
  }

  private requireCloudDeletes(): CloudDatabaseDeletes {
    if (!this.cloudDeletes) {
      throw new Error('Nothing deletes a cloud database here');
    }
    return this.cloudDeletes;
  }

  async dataVolume(
    ctx: PermissionCtx,
    databaseId: string,
  ): Promise<{ present: boolean | null }> {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'delete');
    const owned = await this.findOwned(ctx, databaseId);
    return {
      present: await databaseVolumeLeftBehind(
        this.remoteExec,
        owned.serverId,
        `${owned.appName}-data`,
      ),
    };
  }

  /**
   * Persists the published port and immediately converges the service so it
   * takes (or loses) effect — on a running database now, and on a stopped one
   * at its next Start, without starting it ({@link deployInternal}'s
   * `'apply'`).
   */
  async saveExternalPort(
    ctx: PermissionCtx,
    databaseId: string,
    data: { externalPort: number | null },
  ) {
    const owned = await this.findOwnedForUpdate(ctx, databaseId);
    await this.updateRow(owned.id, { externalPort: data.externalPort });
    return this.deployInternal(owned.id, 'apply');
  }

  /**
   * Scales the service up and marks the row done.
   *
   * `options.detach` is the MCP tool's (spec "Database start and
   * stop scale with `--detach`"): the scale returns once Swarm has the replica
   * count, `done` is written ahead of convergence, and the agent polls the
   * status. The console routes pass nothing and wait, as they always have.
   */
  async start(
    ctx: PermissionCtx,
    databaseId: string,
    options: ScaleOptions = {},
  ) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const owned = await this.findOwned(ctx, databaseId);
    const onCloud = await this.inCloud?.(owned.id, 'start');
    if (onCloud) return onCloud;
    // Nothing new starts on a Server in maintenance (spec #1420).
    await refuseWhileInMaintenance(this.db, [owned.serverId]);
    await scaleDatabaseService(
      this.remoteExec,
      owned.serverId,
      owned.appName,
      1,
      options,
    ).catch((error: unknown) => {
      throw this.lifecycleFailed(error, 'start', owned);
    });
    return this.updateStatus(owned.id, 'done');
  }

  /**
   * Scales the service to zero and marks the row stopped.
   *
   * **`'stopped'`, not `'idle'`.** `'idle'` is the column's default, so
   * writing it here made a database an operator had just stopped read exactly
   * like one that had never been deployed — same pill, same word, on the
   * masthead and in the facts card, and unchanged by a reload. Nothing else on
   * the row could tell them apart: a database writes no `deployment` row, and
   * `replicas` is the configured count, which a stop does not touch.
   *
   * `options.detach` as {@link start}'s.
   */
  async stop(
    ctx: PermissionCtx,
    databaseId: string,
    options: ScaleOptions = {},
  ) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const owned = await this.findOwned(ctx, databaseId);
    const onCloud = await this.inCloud?.(owned.id, 'stop');
    if (onCloud) {
      await this.incidents?.closeForService(this.serviceType, owned.id);
      return onCloud;
    }
    await scaleDatabaseService(
      this.remoteExec,
      owned.serverId,
      owned.appName,
      0,
      options,
    ).catch((error: unknown) => {
      throw this.lifecycleFailed(error, 'stop', owned);
    });
    const stopped = await this.updateStatus(owned.id, 'stopped');
    // A Stopped Service's open Incidents close with `service-stopped`, each
    // announced once — as an Application's and a Compose's do. Never
    // throws: the Stop has happened.
    await this.incidents?.closeForService(this.serviceType, owned.id);
    return stopped;
  }

  /**
   * Drops the service and its data volume, then deploys from scratch — a
   * factory reset onto the current config.
   *
   * **Three steps, each of which can be where it stops, and a retry finishes
   * from wherever that was.** It used to be three bare awaits, and on a
   * real Swarm it could not succeed: `docker service rm` returns while the task
   * container is still stopping, so the volume removal straight after it met
   * `volume is in use`, the route answered a bare 500 with the service already
   * gone, and every retry then failed at `docker service rm` of a service that
   * was not there. So:
   *
   * - a service removal that fails is read back with the presence probe, and a
   *   service that is `absent` is removed — which is what a retry sees;
   * - the volume is removed only once no container holds it
   *   ({@link removeDatabaseVolumeWhenReleased}), within a bound;
   * - and each failure is a 409 that names its step, Docker's own words, and
   *   what is true afterwards — the console shows a 409's message as it is,
   *   and "nothing changed" is false once the service has gone.
   *
   * The row is written `running` once the service is gone and `error` if the
   * volume step then fails ({@link deployInternal} writes its own), so the
   * Overview does not read `done` for a database with no service. A failure at
   * the first step leaves the status alone, because the database is still up.
   */
  async rebuild(ctx: PermissionCtx, databaseId: string) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const owned = await this.findOwned(ctx, databaseId);
    const onCloud = await this.inCloud?.(owned.id, 'rebuild');
    if (onCloud) return onCloud;
    // Refused before the running service is removed: a rebuild on a Server
    // in maintenance would stop at its deploy with the database gone (spec
    // #1420).
    await refuseWhileInMaintenance(this.db, [owned.serverId]);
    const volumeName = `${owned.appName}-data`;

    try {
      await removeDatabaseService(
        this.remoteExec,
        owned.serverId,
        owned.appName,
      );
    } catch (error) {
      const presence = await databaseServicePresence(
        this.remoteExec,
        owned.serverId,
        owned.appName,
      );
      if (presence !== 'absent') {
        throw this.rebuildFailed(
          presence === 'present'
            ? `Rebuild stopped at removing the Swarm service ${owned.appName}, so nothing was deleted and the ${this.engineLabel} is still running. Docker said: ${dockerSaid(error)}`
            : `Rebuild stopped at removing the Swarm service ${owned.appName}, and Cloudgate could not confirm whether it is still there. The data volume ${volumeName} was not touched. Docker said: ${dockerSaid(error)}`,
        );
      }
      // Already gone — a retry after a partial failure, or a database that was
      // never deployed. Either way this step is done.
    }

    await this.updateStatus(owned.id, 'running');
    try {
      await removeDatabaseVolumeWhenReleased(
        this.remoteExec,
        owned.serverId,
        volumeName,
        this.volumeReleaseClock,
      );
    } catch (error) {
      await this.updateStatus(owned.id, 'error');
      const why =
        error instanceof VolumeStillInUseError
          ? `it was ${error.reason}`
          : `Docker said: ${dockerSaid(error)}`;
      throw this.rebuildFailed(
        `Rebuild stopped at deleting the data volume ${volumeName}: ${why}. The service was removed and the data is still there, so the ${this.engineLabel} is offline. Rebuild again to finish, or Deploy to bring it back on the data it had.`,
      );
    }

    try {
      return await this.deployInternal(owned.id, 'start');
    } catch (error) {
      // An HttpException from the deploy is Cloudgate's own sentence (a row
      // gone, an env reference that does not resolve) rather than Docker's,
      // so it is quoted as itself — but still wrapped, because on its own it
      // names neither the step nor that the volume is already gone.
      const said =
        error instanceof HttpException
          ? error.message
          : `Docker said: ${dockerSaid(error)}`;
      throw this.rebuildFailed(
        `Rebuild stopped at deploying the ${this.engineLabel} again. The data volume was deleted, so the ${this.engineLabel} is offline and Deploy starts it on an empty one. ${said}`,
      );
    }
  }

  /**
   * A rebuild step's failure, logged and answered as a 409.
   *
   * 409 rather than a 5xx, which is what these are in the HTTP sense: the
   * console rewrites any 5xx into generic "something went wrong" copy and
   * shows a 4xx's message as it is, and the message — which step, what Docker
   * said, what is true now — is the whole point of the answer.
   */
  /**
   * A Deploy, Start or Stop that Docker failed, as a refusal naming what
   * Docker said. It reached the console as a bare 500, "Internal
   * server error", which the console could not tell from a timeout, so it
   * said "this may still be running" and the reason was shown nowhere. A
   * Server not reached is the 503 with its code every Docker read answers,
   * and an `HttpException` already says what it means and goes through.
   */
  private lifecycleFailed(
    error: unknown,
    action: 'deploy' | 'start' | 'stop',
    { appName, serverId }: { appName: string; serverId: string | null },
  ): HttpException {
    if (error instanceof HttpException) return error;
    rethrowIfHostUnreachable(this.logger, serverId, error);
    const message = `The ${this.engineLabel} ${action} of ${appName} failed. Docker said: ${dockerSaid(error)}`;
    this.logger.warn(message);
    return new ConflictException(message);
  }

  private rebuildFailed(message: string): ConflictException {
    this.logger.warn(message);
    return new ConflictException(message);
  }

  /** Internal status write, the deploy lifecycle's bookkeeping. */
  protected updateStatus(
    databaseId: string,
    status: DatabaseStatus,
  ): Promise<TRow> {
    return this.updateRow(databaseId, { applicationStatus: status });
  }

  protected async updateRow(
    databaseId: string,
    values: Record<string, unknown>,
    // A console Save's config rewrite, committed with the write.
    keep: KeepConfig = KEEP_NOTHING,
  ): Promise<TRow> {
    return writeKept(
      this.db,
      keep,
      async (db) => {
        const [updated] = await db
          .update(this.table)
          .set(values)
          .where(eq(this.columns.id, databaseId))
          .returning();
        return updated as TRow;
      },
      (updated) => (updated ? { serviceId: databaseId } : null),
    );
  }

  /**
   * {@link findOwned} at the write level.
   *
   * `findOwned` is correctly `'read'` — it is the lookup both readers and
   * writers share — so the `'update'` claim is made here instead, once, rather
   * than inline in each of the three **definition** writes that need it:
   * {@link update}, {@link saveEnvironment} and {@link saveExternalPort}.
   * `libsql.service.ts` reaches it too, for its three-port write;
   * `ApplicationsService` and `ComposeService` carry the same pair for the same
   * reason.
   *
   * **{@link deploy}, {@link changeStatus}, {@link start}, {@link stop} and
   * {@link rebuild} deliberately keep `findOwned`.** Every one of them already
   * runs `checkPermission({ deployment: ['create'] })`, which is the statement
   * a custom role is granted so it may operate a workload it may not redefine;
   * requiring `service: ['update']` as well would make the operate level —
   * *"see and operate this service, but do not rewrite its definition"* —
   * unsayable. `ComposeService.removeContainers` carries the long form of the
   * argument. `saveExternalPort` is on the other side of the line despite
   * converging the service afterwards, because the write it converges is a
   * column of the row: the published port is part of the definition.
   *
   * The order is the point of the method. Asking for `'update'` *before*
   * `findOwned` runs means a caller holding `read` and not `update` is refused
   * without learning whether the id resolves (§2.2). The redundant `'read'`
   * check inside `findOwned` afterwards costs a second pass over the member row
   * and is deliberate: a custom role granted `update` without `read` is
   * refused, because there is no writing a definition you cannot see.
   */
  protected async findOwnedForUpdate(
    ctx: PermissionCtx,
    databaseId: string,
  ): Promise<{ id: string; appName: string; serverId: string | null }> {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'update');
    return this.findOwned(ctx, databaseId);
  }

  /**
   * Row-level service access plus org scoping (environment → project), the
   * write-path counterpart of findOne without the relation tree.
   *
   * Read-level, and stays so: {@link findOwnedForUpdate} is the write-path
   * entry.
   */
  protected async findOwned(
    ctx: PermissionCtx,
    databaseId: string,
  ): Promise<{ id: string; appName: string; serverId: string | null }> {
    await this.permissions.checkServiceAccess(ctx, databaseId, 'read');
    const [found] = await this.db
      .select({
        id: this.columns.id,
        appName: this.columns.appName,
        serverId: this.columns.serverId,
      })
      .from(this.table)
      .innerJoin(
        environment,
        eq(this.columns.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(this.columns.id, databaseId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException(this.notFound());
    return found as { id: string; appName: string; serverId: string | null };
  }

  /** The environment (with its projectId) inside the caller's organization. */
  private async findParentEnvironment(
    ctx: PermissionCtx,
    environmentId: string,
  ) {
    const [found] = await this.db
      .select({
        environmentId: environment.environmentId,
        projectId: environment.projectId,
        deployTarget: environment.deployTarget,
      })
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(environment.environmentId, environmentId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Environment not found');
    return found;
  }

  protected notFound(): string {
    return `${this.engineLabel} not found`;
  }
}
