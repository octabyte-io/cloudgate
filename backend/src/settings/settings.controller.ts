import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Ip,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { project } from '../projects/project.schema';
import { server } from '../servers/server.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { prepareEnvironmentVariables } from '../docker/docker.utils';
import { checkServerAccess } from '../common/owned-server';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { CleanupService } from './cleanup.service';
import { DnsChallengeService } from './dns-challenge.service';
import { DockerCleanupService } from './docker-cleanup.service';
import {
  DockerResourceService,
  getCloudgateImageTag,
} from './docker-resource.service';
import { GpuService } from './gpu.service';
import { InfraHealthService } from './infra-health.service';
import { LogCleanupService } from './log-cleanup.service';
import { RuntimeInfoService } from './runtime-info.service';
import { UpdatesService } from './updates.service';
import { RuntimeInfoQueryDto } from './dto/runtime-info.dto';
import {
  AssignDomainDto,
  ModifyTraefikFileDto,
  PutDnsChallengeDto,
  ReadTraefikFileQueryDto,
  ServerIdQueryDto,
  ToggleDashboardDto,
  ToggleRequestsDto,
  TraefikConfigDto,
  UpdateBuildsConcurrencyDto,
  UpdateCloudRunsConcurrencyDto,
  UpdateCloudRunTimeLimitDto,
  UpdateRequestedPreviewMaxTtlDto,
  UpdateDockerCleanupDto,
  UpdateLogCleanupDto,
  UpdateServerIpDto,
  UpdateTraefikPortsDto,
  UpdateWhitelabelingDto,
  WriteTraefikEnvDto,
} from './dto/settings.dto';
import { RequestLoggingService } from './request-logging.service';
import { RequestMetricsService } from './request-metrics.service';
import { SettingsService } from './settings.service';
import { MAIN_TRAEFIK_DIR, TraefikFilesService } from './traefik-files.service';
import type { TraefikDirectoryOn } from './traefik-files.service';
import { TraefikSetupService } from './traefik-setup.service';
import { CLOUDGATE_VERSION } from './version';

type Session = NonNullable<ValidatedRequest['session']>;

/** The caller's permission ctx in the session's active organization. */
function toCtx(user: AuthSession['user'], session: Session): PermissionCtx {
  if (!session.activeOrganizationId) {
    throw new ForbiddenException('No active organization');
  }
  return {
    user: { id: user.id },
    session: { activeOrganizationId: session.activeOrganizationId },
  };
}

// Authorization is per route, not on the controller: a handler with no check
// of its own is open to any authenticated user, and the rest ask for the
// authority their target needs (see traefikTargetAuthority and
// maintenanceTargetAuthority below).
@Controller('settings')
export class SettingsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly settings: SettingsService,
    private readonly traefikFiles: TraefikFilesService,
    private readonly dockerResources: DockerResourceService,
    private readonly traefikSetup: TraefikSetupService,
    private readonly dnsChallenge: DnsChallengeService,
    private readonly logCleanup: LogCleanupService,
    private readonly cleanup: CleanupService,
    private readonly dockerCleanup: DockerCleanupService,
    private readonly updates: UpdatesService,
    private readonly gpu: GpuService,
    private readonly infraHealth: InfraHealthService,
    private readonly runtime: RuntimeInfoService,
    private readonly deployments: DeploymentsService,
    private readonly requestMetrics: RequestMetricsService,
    private readonly requestLogging: RequestLoggingService,
    @Inject(MAIN_TRAEFIK_DIR) private readonly traefikDir: TraefikDirectoryOn,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * The web-server settings singleton (any authenticated user), sanitized: the
   * metrics agent token is projected out and reported only as
   * `metricsConfig.server.hasToken`. Carries `consoleOrigin` — whether sign-in
   * on the console domain will be let in.
   */
  @Get('web-server')
  getWebServerSettings() {
    return this.settings.getWebServerSettingsView();
  }

  /**
   * The instance's branding. `@Public()` for the same reason
   * `GET /sso/show-sign-in` is: the sign-in screen is the first page a
   * white-labelled instance has to get right, and it is reached with no
   * session. Answers the branding blob and nothing else off the settings row.
   */
  @Public()
  @Get('whitelabeling')
  getWhitelabelingConfig() {
    return this.settings.getWhitelabelingConfig();
  }

  /**
   * Rebrand the instance: enterprise-gated in the service, like
   * the other enterprise surfaces. A merge, not a replace — an omitted key
   * keeps its stored value and an explicit null clears it.
   */
  @Patch('whitelabeling')
  updateWhitelabelingConfig(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateWhitelabelingDto,
  ) {
    return this.settings.updateWhitelabelingConfig(toCtx(user, session), body);
  }

  @Get('ip')
  getIp() {
    return this.settings.getIp();
  }

  /**
   * Sets the platform host's IP on the settings singleton; instance authority.
   * Answers with the sanitized row, which withholds the metrics agent token —
   * the instance's SSH private key rode this response once, and that
   * column is now dropped altogether.
   *
   * **Every `@Post` on this controller is `@HttpCode(200)`** — 26 of them,
   * and the uniformity is the finding, not laziness. None creates a resource:
   * they write instance settings, rewrite a Traefik file, or run a cleanup, and
   * each answers with `true` or a settings/status object. `204` was rejected for
   * all of them precisely because of that `true`: it is a body, so a 204 would be
   * a status contradicting the response, and dropping it to earn one is the
   * response-body change put out of scope.
   */
  @Post('ip')
  @HttpCode(200)
  updateServerIp(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateServerIpDto,
  ) {
    return this.settings.updateServerIp(toCtx(user, session), body.serverIp);
  }

  @Post('builds-concurrency')
  @HttpCode(200)
  async updateBuildsConcurrency(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateBuildsConcurrencyDto,
  ) {
    await this.settings.updateBuildsConcurrency(
      toCtx(user, session),
      body.buildsConcurrency,
    );
    return true;
  }

  /** The Cloud run pool limit, gated like Concurrent builds. */
  @Post('cloud-runs-concurrency')
  @HttpCode(200)
  async updateCloudRunsConcurrency(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateCloudRunsConcurrencyDto,
  ) {
    await this.settings.updateCloudRunsConcurrency(
      toCtx(user, session),
      body.cloudRunsConcurrency,
    );
    return true;
  }

  /** The Cloud run time limit, gated like Concurrent builds. */
  @Post('cloud-run-time-limit')
  @HttpCode(200)
  async updateCloudRunTimeLimit(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateCloudRunTimeLimitDto,
  ) {
    await this.settings.updateCloudRunTimeLimit(
      toCtx(user, session),
      body.cloudRunTimeLimitMinutes,
    );
    return true;
  }

  /** The instance maximum TTL of a Requested preview, gated like the above. */
  @Post('requested-preview-max-ttl')
  @HttpCode(200)
  async updateRequestedPreviewMaxTtl(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateRequestedPreviewMaxTtlDto,
  ) {
    await this.settings.updateRequestedPreviewMaxTtl(
      toCtx(user, session),
      body.requestedPreviewMaxTtlMinutes,
    );
    return true;
  }

  /**
   * The target a Traefik route names, and the authority it takes (H-52).
   *
   * A `serverId` names a Server, and a Server belongs to an organization: the
   * caller's own owner/admin role plus `checkServerAccess`, exactly as before.
   * **Its absence names the platform host, which belongs to no organization** —
   * `checkServerAccess` returns early for an absent id by design (ADR-0008's
   * second consequence, restated in `common/owned-server.ts` as *"not a bug —
   * do not fix it"*), and that early return was mistaken for the whole answer.
   * What was missing was never a lookup; it was the other question. So the host
   * branch takes instance authority instead, and the organization role is not
   * asked, because for the platform host it was never the right question.
   *
   * The six handlers that take no `serverId` at all — the read/write pairs over
   * `traefik.yml`, `dynamic/cloudgate.yml` and `dynamic/middlewares.yml` — are
   * unconditionally the host, so they call `requireInstanceAuthority` outright
   * rather than through this.
   *
   * **Reads move with writes.** Splitting them was considered and rejected:
   * these routes answer with the platform's own Traefik configuration —
   * entrypoints, certificate resolvers, the console's router and the ACME
   * email — so a boundary that admits the read hands another organization's
   * owner the reconnaissance half of the same attack, and tells them the
   * resource is there. `GET /settings/traefik/requests` is deliberately *not*
   * here: it answers one boolean, discloses no configuration, and is a
   * documented any-authenticated-user quirk.
   */
  private async traefikTargetAuthority(
    ctx: PermissionCtx,
    serverId?: string | null,
  ): Promise<void> {
    if (!serverId) {
      await this.settings.requireInstanceAuthority(ctx);
      return;
    }
    await this.settings.requireOwnerOrAdmin(ctx);
    await checkServerAccess(this.db, ctx, serverId);
  }

  /**
   * {@link traefikTargetAuthority} for the routes that address the Traefik
   * directory by path. They gate on `traefikFiles:read`/`:write` through
   * `@RequirePermission` rather than on owner/admin, so the Server branch keeps
   * that decorator as its only role check and this adds nothing to it — but the
   * host branch is the same platform host, reachable here with
   * `path: 'dynamic/cloudgate.yml'` and no `serverId`, which is
   * `POST /settings/traefik/web-server-config` by another name (H-52). Closing
   * one and not the other would have left the finding open through a route
   * whose gate is *weaker*: `traefikFiles:write` is grantable to a licensed
   * custom role, and owner/admin was never asked for here at all.
   */
  private async traefikFileTarget(
    ctx: PermissionCtx,
    serverId?: string | null,
  ): Promise<void> {
    if (!serverId) {
      await this.settings.requireInstanceAuthority(ctx);
      return;
    }
    await checkServerAccess(this.db, ctx, serverId);
  }

  /** Reads the platform host's main `traefik.yml`; instance authority. */
  @Get('traefik/config')
  async readTraefikConfig(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    return this.traefikFiles.readMainConfig();
  }

  /**
   * Overwrites the platform host's main `traefik.yml`; instance authority.
   * Refused with the parser's line when it is not YAML Traefik can start from.
   */
  @Post('traefik/config')
  @HttpCode(200)
  async updateTraefikConfig(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TraefikConfigDto,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    this.traefikFiles.writeMainConfig(body.traefikConfig);
    return true;
  }

  /** Reads the console's `dynamic/cloudgate.yml`; instance authority. */
  @Get('traefik/web-server-config')
  async readWebServerTraefikConfig(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    return this.traefikFiles.readConfig('cloudgate');
  }

  /**
   * Overwrites `dynamic/cloudgate.yml` with raw YAML; instance authority.
   *
   * The write goes through {@link SettingsService.writeRawTraefikConfig},
   * which observes what Traefik makes of it without gating it.
   */
  @Post('traefik/web-server-config')
  @HttpCode(200)
  async updateWebServerTraefikConfig(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TraefikConfigDto,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    await this.settings.writeRawTraefikConfig('cloudgate', body.traefikConfig);
    return true;
  }

  /** Reads `dynamic/middlewares.yml`; instance authority. */
  @Get('traefik/middlewares-config')
  async readMiddlewareTraefikConfig(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    return this.traefikFiles.readConfig('middlewares');
  }

  /**
   * Overwrites `dynamic/middlewares.yml` with raw YAML; instance authority.
   *
   * Observed for the same reason as the route above, and this is the
   * file the Console routing card's second source names.
   */
  @Post('traefik/middlewares-config')
  @HttpCode(200)
  async updateMiddlewareTraefikConfig(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TraefikConfigDto,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    await this.settings.writeRawTraefikConfig(
      'middlewares',
      body.traefikConfig,
    );
    return true;
  }

  /**
   * Lists the Traefik directory tree of the platform host or of the Server
   * `serverId` names (`traefikFiles:read`; the host takes instance authority).
   *
   * The directory walked is the named Server's own Traefik tree, so the root is
   * that Server's — this route hands the *path* to a walk that runs on the
   * machine it also hands the `serverId` to, and under the local root the
   * remote script's `root_dir=` named a directory that host never had.
   */
  @Get('traefik/directories')
  @RequirePermission('traefikFiles', 'read')
  async readDirectories(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    await this.traefikFileTarget(toCtx(user, session), query.serverId);
    const result = await this.traefikFiles.readDirectory(
      this.traefikDir(query.serverId),
      query.serverId,
    );
    return result || [];
  }

  /**
   * Reads one file under the Traefik directory by path (`traefikFiles:read`;
   * `serverId` org-scoped, the host takes instance authority). A file holding
   * private-key material is refused, and htpasswd entries come back redacted.
   */
  @Get('traefik/file')
  @RequirePermission('traefikFiles', 'read')
  async readTraefikFile(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ReadTraefikFileQueryDto,
  ) {
    await this.traefikFileTarget(toCtx(user, session), query.serverId);
    return this.traefikFiles.readFileForConsole(query.path, query.serverId);
  }

  /**
   * Writes one file under the Traefik directory by path (`traefikFiles:write`;
   * `serverId` org-scoped, the host takes instance authority). A key file is
   * refused, YAML is parsed before it is written, and a redacted
   * htpasswd entry keeps its stored secret.
   */
  @Post('traefik/file')
  @HttpCode(200)
  @RequirePermission('traefikFiles', 'write')
  async updateTraefikFile(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ModifyTraefikFileDto,
  ) {
    await this.traefikFileTarget(toCtx(user, session), body.serverId);
    await this.traefikFiles.writeFileFromConsole(
      body.path,
      body.traefikConfig,
      body.serverId,
    );
    return true;
  }

  /** The running Cloudgate version (any authenticated user). */
  @Get('version')
  getVersion() {
    return CLOUDGATE_VERSION;
  }

  /** The image tag this instance runs (any authenticated user). */
  @Get('release-tag')
  getReleaseTag() {
    return getCloudgateImageTag();
  }

  /**
   * Compares the running version with the newest `cloudgate/cloudgate` tag on
   * Docker Hub (any authenticated user). A POST, though it writes nothing.
   */
  @Post('update-data')
  @HttpCode(200)
  getUpdateData() {
    return this.updates.getUpdateData(CLOUDGATE_VERSION);
  }

  /**
   * Pulls the newest `cloudgate` image and force-updates the service running
   * this console.
   *
   * Unconditionally the platform host — there is no `serverId` to fork on — so
   * it takes instance authority outright, the way the six `traefik.yml` /
   * `dynamic/*.yml` handlers do (H-63). Moving the whole instance onto a
   * different version of itself, and restarting it to get there, is not
   * something one organization does to the others.
   */
  @Post('update-server')
  @HttpCode(200)
  async updateServer(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    await this.updates.updateServer(CLOUDGATE_VERSION);
    return true;
  }

  /**
   * NVIDIA driver, runtime, CUDA and swarm GPU status of the platform host or
   * the named Server (see maintenanceTargetAuthority for who may call it).
   */
  @Get('gpu')
  async checkGpuStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    await this.maintenanceTargetAuthority(user, session, query.serverId);
    return this.gpu.checkGpuStatus(query.serverId);
  }

  /**
   * The counts-only GPU read: cards advertised by ID and cards no
   * running task holds, on the platform host or the named Server, read live.
   *
   * Open to anyone who may create a Service there — `service: ['create']` and
   * Server access — because choosing a GPU count needs it, while the
   * driver/CUDA check above stays on maintenanceTargetAuthority. Two numbers
   * and a setup state are what a refused reservation would say anyway; ADR-0013
   * records that this is not a precedent against "reads move with writes".
   */
  @Get('gpu/counts')
  @RequirePermission('service', 'create')
  async gpuCounts(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    // The host's own cards are no create form's choice on the Hosted
    // instance, where nothing is created there (ADR-0053).
    if (!query.serverId) this.instanceMode.refusePlatformHost('services');
    await checkServerAccess(this.db, toCtx(user, session), query.serverId);
    return this.gpu.counts(query.serverId);
  }

  /**
   * Sets up swarm GPU support on the platform host or the named Server
   * (maintenanceTargetAuthority); a failure answers 400 with its message.
   */
  @Post('gpu-setup')
  @HttpCode(200)
  async setupGpu(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ServerIdQueryDto,
  ) {
    await this.maintenanceTargetAuthority(user, session, body.serverId);
    try {
      await this.gpu.setupGpuSupport(body.serverId);
      return { success: true };
    } catch (error) {
      console.error('GPU Setup Error:', error);
      throw new BadRequestException(
        error instanceof Error ? error.message : 'GPU setup failed',
      );
    }
  }

  /**
   * Health of the platform's Postgres and Traefik — the platform host's own
   * containers, so instance authority, reads moving with writes on this surface
   * (H-63, ADR-0013). Deliberately not `@Public()` like `/settings/health`
   * below it, which answers one liveness bit and nothing about what is running.
   */
  @Get('infrastructure-health')
  async checkInfrastructureHealth(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    return this.infraHealth.checkInfrastructureHealth();
  }

  /**
   * What this install is actually running, declared beside observed.
   *
   * Cloudgate's own version, Traefik's, Docker's, Postgres's, Node's, the Swarm
   * state, the OS and kernel, both uptimes, the platform directory's free space
   * and whether `cloudgate-network` exists — for the platform host, or for the
   * Server `serverId` names.
   *
   * The fifth route over this ground and the only one that observes anything:
   * `/settings/version`, `/settings/release-tag` and `/settings/infrastructure-health`
   * each re-serve a constant or a liveness bit, and are left exactly as they are
   * for their existing callers. `RuntimeInfoService`'s docblock says which to
   * reach for.
   *
   * Owner/admin like `infrastructure-health` above and explicitly **not**
   * `@Public()` like `/settings/health`: a precise version inventory of a fleet
   * is a targeting aid. The same preamble also org-scopes `serverId`, so a
   * Server in another organization reads as 404 before anything is probed.
   */
  @Get('runtime-info')
  async getRuntimeInfo(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: RuntimeInfoQueryDto,
  ) {
    await this.maintenanceTargetAuthority(user, session, query.serverId);
    return this.runtime.getRuntimeInfo(query.serverId);
  }

  /** Liveness: `{ status: 'ok' }` once the database answers (public). */
  @Public()
  @Get('health')
  health() {
    return this.infraHealth.health();
  }

  /** Whether the active org has servers or projects (any signed-in user). */
  @Get('is-user-subscribed')
  async isUserSubscribed(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    const ctx = toCtx(user, session);
    const organizationId = ctx.session.activeOrganizationId;
    const haveServers = await this.db.query.server.findMany({
      where: eq(server.organizationId, organizationId),
    });
    const haveProjects = await this.db.query.project.findMany({
      where: eq(project.organizationId, organizationId),
    });
    return haveServers.length > 0 || haveProjects.length > 0;
  }

  /**
   * Whether Traefik's access log is on in `traefik.yml` (any authenticated
   * user), Server-scoped like the neighbouring Traefik routes. Answers
   * `{ present, enabled }`: a host with no traefik.yml is `present: false`, so
   * a missing file is never reported as logging being off.
   */
  @Get('traefik/requests')
  async haveActivateRequests(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    await checkServerAccess(this.db, toCtx(user, session), query.serverId);
    return this.traefikFiles.haveActivateRequests(query.serverId);
  }

  /**
   * Switches Traefik's **Access log** on or off in `traefik.yml`, behind the
   * gate `POST /settings/traefik/reload` and Enable request metrics take
   * ({@link traefikTargetAuthority}): instance authority on the platform host,
   * owner/admin of the Server's Organization plus `checkServerAccess` on a
   * Server. `RequestLoggingService` says what each branch does — on a Server
   * the write and the Traefik restart are one action; on the platform
   * host the answer carries `restartRequired` and the restart stays the
   * separate, named `POST /settings/traefik/reload` — and audits both as
   * `update server`.
   *
   * **The Server branch took `checkServerAccess` alone at first**, so any
   * Member of any role could switch the collection of visitor IPs and paths
   * on or off. That is the Organization's leaders' decision (ADR-0055), and
   * the switch now restarts Traefik, which drops every connection on 80 and
   * 443 — so it takes exactly the restart's gate. The Instance organization
   * gets no override: `checkServerAccess` scopes to the active Organization.
   *
   * **The host branch is not covered by the `traefik/requests` carve-out, and
   * H-64 is that it was treated as though it were.** ADR-0013 left one route
   * here alone and named it: `GET /settings/traefik/requests`, *"it answers one
   * boolean, discloses no configuration, and is a documented
   * any-authenticated-user quirk"*. Every word of that is about the **read**.
   * This is the write beside it, and the gate it had was `checkServerAccess`
   * alone — which returns for an absent `serverId` by design, so on the platform
   * host there was no gate at all: any signed-in member of any organization
   * could rewrite the instance's static `traefik.yml` and switch its access log
   * off, which is the audit trail `POST /monitoring/requests/logs` and
   * `/requests/stats` read. Switching it *on* is no safer — it points Traefik at
   * a filePath on the host and re-serialises the operator's static config
   * around it.
   *
   * So the host branch takes instance authority, which both
   * {@link traefikFileTarget} and {@link traefikTargetAuthority} give it; the
   * second is the one named here because of the Server branch above.
   */
  @Post('traefik/requests')
  @HttpCode(200)
  async toggleRequests(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Ip() ip: string,
    @Body() body: ToggleRequestsDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, body.serverId);
    return this.requestLogging.toggle(
      ctx,
      body.enable,
      body.serverId ?? null,
      ip,
    );
  }

  /**
   * Assigns the console's domain, certificate type and ACME email and rewrites
   * `dynamic/cloudgate.yml`; instance authority. Answers with the sanitized
   * row: the metrics agent token is projected out, and
   * `consoleOrigin` says whether sign-in on the new domain will work.
   */
  @Post('assign-domain')
  @HttpCode(200)
  assignDomain(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: AssignDomainDto,
  ) {
    return this.settings.assignDomain(toCtx(user, session), body);
  }

  /**
   * Starts or stops the access-log rotation cron; instance authority. It once
   * had no `@CurrentUser` at all, so it asked nobody anything (H-64).
   *
   * There is no Server branch to weigh. `LogCleanupService` registers one
   * instance-wide cron and writes `logCleanupCron` on the web-server settings
   * singleton, and its body rotates the platform host's own access log — so this
   * route is unconditionally the platform host, the way the six `traefik.yml` /
   * `dynamic/*.yml` handlers are, and like them it calls
   * `requireInstanceAuthority` outright rather than through a target branch.
   *
   * Both directions were reachable and both are writes. `cronExpression: null`
   * *stops* rotation, which is how the access log grows without bound until it
   * is the thing a ranged read has to walk; a hostile expression sets the
   * schedule the whole instance rotates on. Neither is a setting one
   * organization owns.
   */
  @Post('log-cleanup')
  @HttpCode(200)
  async updateLogCleanup(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateLogCleanupDto,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    return body.cronExpression
      ? this.logCleanup.start(body.cronExpression)
      : this.logCleanup.stop();
  }

  /**
   * The access-log rotation schedule — the read half of the `@Post` above,
   * and it takes the same authority (H-63).
   *
   * It was reachable by any signed-in member of any organization, having no
   * `@CurrentUser` at all. `LogCleanupService.getStatus` answers
   * `{ enabled, cronExpression }` off the `web_server_settings` singleton, so
   * what it discloses is the schedule the **platform host** rotates its access
   * log on — configuration, and the operational half of the write beside it:
   * knowing the interval is knowing how long a line survives before rotation,
   * and how long a flood has to run to outgrow `ACCESS_LOG_MAX_BYTES` between
   * two ticks.
   *
   * `GET /settings/traefik/requests` is **not** the precedent that keeps this
   * open, and the difference is the whole of ADR-0013's carve-out: that route
   * answers one boolean and discloses no configuration. This one answers the
   * cron expression itself.
   */
  @Get('log-cleanup')
  async getLogCleanupStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    return this.logCleanup.getStatus();
  }

  /**
   * Drops every job waiting in the deployment queue, and settles each dropped
   * build's Deployment as `cancelled` rather than leaving it `pending` for ever
   * — `DeploymentsService.emptyQueue` says which rows and why.
   *
   * **Every** — `QueuePort.clearWaiting` empties the waiting list of every
   * partition, and the partitions are not organization-scoped, so one caller
   * discarded every other organization's pending builds and the console showed
   * them nothing but a queue that had gone quiet. Instance authority (H-63):
   * there is no `serverId` here and never was, because the queue is the
   * instance's.
   */
  @Post('clean-deployment-queue')
  @HttpCode(200)
  async cleanAllDeploymentQueue(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    await this.deployments.emptyQueue();
    return true;
  }

  /**
   * The target a maintenance route names, and the authority it takes (H-63).
   *
   * This is {@link traefikTargetAuthority}'s shape for the other family on this
   * controller — the owner/admin + org-scoped-`serverId` preamble that
   * `gpu`, `gpu-setup`, `runtime-info` and the six `cleanup/*` verbs share. Same
   * fork, same reason: a `serverId` names a Server and a Server belongs to an
   * organization, so the caller's own owner/admin role plus `checkServerAccess`
   * is exactly right and has not moved; **its absence names the platform host,
   * which belongs to no organization**, and there the organization role was
   * never the question (ADR-0008's second consequence, ADR-0013).
   *
   * On the host branch what got through was not an over-broad admin role. It
   * was `docker volume prune --all --force` on the machine every organization's
   * services run on, which takes out every volume no running container holds —
   * *other tenants' data*, deleted by a caller who was never a member of their
   * organization. `cleanup/all` and `cleanup/docker-prune` add
   * `docker system prune --all --force`, and `gpu-setup` rewrites
   * `/etc/docker/daemon.json` and restarts the daemon under it.
   *
   * **The delegation an operator actually makes still works, which is why this
   * primitive is the right one rather than a narrower "instance owner".** Docker
   * hygiene on the platform host is a job an operator hands to an admin, and
   * `checkInstanceAuthority` admits the instance organization's owners *and* its
   * admins — the same set `requireOwnerOrAdmin` admitted on the
   * single-organization install `deploy/install.sh` produces. The only caller it
   * refuses is a *different* organization's admin, who has no host to keep tidy
   * here.
   *
   * **Reads move with writes**, per ADR-0013's first consequence: `gpu` and
   * `runtime-info` answer with the platform host's driver, CUDA and swarm
   * inventory and its version-by-version software bill, which
   * `getRuntimeInfo`'s own docblock already calls a targeting aid. Admitting the
   * read hands another organization the reconnaissance half of the write beside
   * it.
   */
  private async maintenanceTargetAuthority(
    user: AuthSession['user'],
    session: Session,
    // `string | null`, not `string | undefined`: the DTO hands the platform host
    // through as an explicit `null` now rather than 400ing on it, and
    // `checkServerAccess` has always returned early for either spelling.
    serverId?: string | null,
  ): Promise<void> {
    const ctx = toCtx(user, session);
    if (!serverId) {
      await this.settings.requireInstanceAuthority(ctx);
      return;
    }
    await this.settings.requireOwnerOrAdmin(ctx);
    await checkServerAccess(this.db, ctx, serverId);
  }

  /** `docker image prune --all` (maintenanceTargetAuthority). */
  @Post('cleanup/images')
  @HttpCode(200)
  async cleanUnusedImages(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ServerIdQueryDto,
  ) {
    await this.maintenanceTargetAuthority(user, session, body.serverId);
    await this.cleanup.cleanupImages(body.serverId);
    return true;
  }

  /** `docker volume prune --all` (maintenanceTargetAuthority). */
  @Post('cleanup/volumes')
  @HttpCode(200)
  async cleanUnusedVolumes(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ServerIdQueryDto,
  ) {
    await this.maintenanceTargetAuthority(user, session, body.serverId);
    await this.cleanup.cleanupVolumes(body.serverId);
    return true;
  }

  /** `docker container prune` (maintenanceTargetAuthority). */
  @Post('cleanup/stopped-containers')
  @HttpCode(200)
  async cleanStoppedContainers(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ServerIdQueryDto,
  ) {
    await this.maintenanceTargetAuthority(user, session, body.serverId);
    await this.cleanup.cleanupContainers(body.serverId);
    return true;
  }

  /** `docker builder prune --all` (maintenanceTargetAuthority). */
  @Post('cleanup/docker-builder')
  @HttpCode(200)
  async cleanDockerBuilder(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ServerIdQueryDto,
  ) {
    await this.maintenanceTargetAuthority(user, session, body.serverId);
    await this.cleanup.cleanupBuilders(body.serverId);
    return true;
  }

  /** System prune + builder prune (maintenanceTargetAuthority). */
  @Post('cleanup/docker-prune')
  @HttpCode(200)
  async cleanDockerPrune(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ServerIdQueryDto,
  ) {
    await this.maintenanceTargetAuthority(user, session, body.serverId);
    await this.cleanup.cleanupSystem(body.serverId);
    await this.cleanup.cleanupBuilders(body.serverId);
    return true;
  }

  /** Every prune but volumes, backgrounded (maintenanceTargetAuthority). */
  @Post('cleanup/all')
  @HttpCode(200)
  async cleanAll(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ServerIdQueryDto,
  ) {
    await this.maintenanceTargetAuthority(user, session, body.serverId);
    return this.cleanup.cleanupAllBackground(body.serverId);
  }

  /**
   * Deletes the platform host's stored samples — its `server_metric` and
   * `container_metric` rows, every organization's containers on it included —
   * and recreates its metrics directory. No `serverId` — the store is
   * the instance's — so instance authority outright (H-63). A Server's samples
   * are not touched; its own retention cleanup prunes them.
   */
  @Post('cleanup/monitoring')
  @HttpCode(200)
  async cleanMonitoring(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    await this.cleanup.cleanMonitoring();
    return true;
  }

  /**
   * `docker system df` on the platform host and only there —
   * `CleanupService.getDockerDiskUsage` takes no `serverId` and calls
   * `execAsync` directly. Instance authority, and it is the read half of the
   * `cleanup/*` pair right above: what is reclaimable, then reclaim it (H-63,
   * ADR-0013's first consequence).
   */
  @Get('docker-disk-usage')
  async getDockerDiskUsage(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    return this.cleanup.getDockerDiskUsage();
  }

  /**
   * Turns the nightly docker-cleanup cron on or off for the platform host or
   * the named Server; `DockerCleanupService.updateDockerCleanup` checks who.
   */
  @Post('docker-cleanup')
  @HttpCode(200)
  async updateDockerCleanup(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateDockerCleanupDto,
  ) {
    await this.dockerCleanup.updateDockerCleanup(toCtx(user, session), body);
    return true;
  }

  /**
   * Force-updates the `cloudgate` service, which restarts the backend serving
   * this request.
   *
   * Instance authority (H-63). It hard-codes `undefined` for the target, so it
   * is unconditionally the platform host, and a restart is an outage for every
   * organization on the instance rather than a maintenance action inside one.
   */
  @Post('reload-server')
  @HttpCode(200)
  async reloadServer(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    await this.settings.requireInstanceAuthority(toCtx(user, session));
    await this.dockerResources.reloadDockerResource(
      'cloudgate',
      undefined,
      CLOUDGATE_VERSION,
    );
    return true;
  }

  /**
   * Restarts Traefik on the platform host or the named Server
   * (traefikTargetAuthority), fire-and-forget so the request returns before
   * Traefik goes down (avoids proxy timeouts).
   */
  @Post('traefik/reload')
  @HttpCode(200)
  async reloadTraefik(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ServerIdQueryDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, body.serverId);
    void this.dockerResources
      .reloadDockerResource('cloudgate-traefik', body.serverId)
      .catch((err) => {
        console.error('reloadTraefik background:', err);
      });
    return true;
  }

  /**
   * **Enable request metrics** on the platform host or the named Server
   * (ADR-0027): writes the loopback `metrics` entryPoint and
   * `metrics.prometheus` into that machine's traefik.yml and requests the
   * Traefik restart static configuration needs — so it takes exactly the gate
   * `POST /settings/traefik/reload` takes (traefikTargetAuthority), and the
   * console puts it behind the same restart confirmation. 404 on a machine with
   * no traefik.yml. Audited by `RequestMetricsService` itself as `update
   * server` naming the machine (its id, or `local` for the platform host) and
   * the change (US77), which the path alone cannot. Answers `{ enabled: true }`; the state is then read on the
   * Server (`requestMetricsEnabled` on `GET /servers/:id`) or, for the platform
   * host, on `GET /settings/web-server`.
   */
  @Post('traefik/request-metrics')
  @HttpCode(200)
  async enableRequestMetrics(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ServerIdQueryDto,
    @Ip() ip: string,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, body.serverId);
    return this.requestMetrics.enable(ctx, body.serverId ?? null, ip);
  }

  /**
   * Traefik's environment as KEY=value lines (traefikTargetAuthority), less
   * every key the machine's DNS-01 setup names: those are credentials, and a
   * response carries a secret's presence, never its value (ADR-0019).
   * `GET /settings/traefik/dns-challenge` is where their names are answered.
   */
  @Get('traefik/env')
  async readTraefikEnv(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, query.serverId);
    return this.dnsChallenge.traefikEnv(query.serverId);
  }

  /**
   * The machine's DNS-01 setup (traefikTargetAuthority):
   * `{ provider, credentialKeys }`, or null when it has none. The credential
   * values are never answered (ADR-0019).
   */
  @Get('traefik/dns-challenge')
  async readDnsChallenge(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, query.serverId);
    return this.dnsChallenge.view(query.serverId ?? null);
  }

  /**
   * Sets the machine's DNS provider and credentials, writes the
   * `letsencrypt-dns` resolver into its traefik.yml and recreates its Traefik
   * with the credentials in its env (traefikTargetAuthority). Answers
   * what the GET answers.
   */
  @Put('traefik/dns-challenge')
  async updateDnsChallenge(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: PutDnsChallengeDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, body.serverId);
    return this.dnsChallenge.put(body.serverId ?? null, {
      provider: body.provider,
      credentials: body.credentials,
    });
  }

  /**
   * Removes the machine's DNS-01 setup — row, resolver and env keys — or 409s
   * naming the Applications whose previews still use it
   * (traefikTargetAuthority).
   */
  @Delete('traefik/dns-challenge')
  async removeDnsChallenge(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, query.serverId);
    return this.dnsChallenge.remove(query.serverId ?? null);
  }

  /**
   * Replaces Traefik's environment (traefikTargetAuthority): resolve the env
   * refs, keep the current ports, and recreate Traefik in the background.
   * The machine's DNS-01 credentials are not in `body.env` — the GET withholds
   * them — and `writeTraefikSetup` merges them back in, so a save here keeps
   * them on the container.
   */
  @Post('traefik/env')
  @HttpCode(200)
  async writeTraefikEnv(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: WriteTraefikEnvDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, body.serverId);
    const envs = prepareEnvironmentVariables(body.env);
    const ports = await this.dockerResources.readPorts(
      'cloudgate-traefik',
      body.serverId,
    );

    void this.traefikSetup
      .writeTraefikSetup({
        env: envs,
        additionalPorts: ports,
        serverId: body.serverId,
      })
      .catch((err) => {
        console.error('writeTraefikEnv background writeTraefikSetup:', err);
      });
    return true;
  }

  /** Whether Traefik publishes dashboard port 8080 (traefikTargetAuthority). */
  @Get('traefik/dashboard')
  async haveTraefikDashboardPortEnabled(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, query.serverId);
    const ports = await this.dockerResources.readPorts(
      'cloudgate-traefik',
      query.serverId,
    );
    return ports.some((port) => port.targetPort === 8080);
  }

  /**
   * Publishes or withdraws Traefik's dashboard port 8080 **and the `api` block
   * that answers on it**, 409 when 8080 is taken (traefikTargetAuthority).
   *
   * Publishing needs a traefik.yml to write `api` into and 404s without one;
   * withdrawing works either way, so a port published on a host that has since
   * lost its config can still be taken back.
   */
  @Post('traefik/dashboard')
  @HttpCode(200)
  async toggleDashboard(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ToggleDashboardDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, body.serverId);

    const ports = await this.dockerResources.readPorts(
      'cloudgate-traefik',
      body.serverId,
    );
    // Withheld and merged back by `writeTraefikSetup`, not re-submitted.
    const env = await this.dnsChallenge.traefikEnv(body.serverId);
    const preparedEnv = prepareEnvironmentVariables(env);
    let newPorts = ports;
    if (body.enableDashboard) {
      const portCheck = await this.dockerResources.checkPortInUse(
        8080,
        body.serverId,
      );
      if (portCheck.isInUse) {
        const conflictInfo = portCheck.conflictingContainer
          ? ` by ${portCheck.conflictingContainer}`
          : '';
        throw new ConflictException(
          `Port 8080 is already in use${conflictInfo}. Please stop the conflicting service or use a different port for the Traefik dashboard.`,
        );
      }
      newPorts.push({ targetPort: 8080, publishedPort: 8080, protocol: 'tcp' });
    } else {
      newPorts = ports.filter((port) => port.targetPort !== 8080);
    }

    // The port was only ever half of it: `api` is *static* configuration, and
    // without it Traefik listens on 80 and 443 only, so 8080 was published with
    // nothing behind it. Awaited, and before the recreate below, because
    // that recreate is the restart static configuration needs — and because a
    // host with no traefik.yml must 404 *before* `newPorts` is written rather
    // than publish a port for nothing. That refusal is the on-switch only: the
    // off-switch has no `api` block to remove on such a host and goes on to
    // unpublish 8080, so the two halves never disagree about which way the
    // switch went.
    // `enableDashboard` is optional in the DTO, and the branch above reads a
    // missing one as "off"; the write is given the same answer rather than a
    // second reading of it.
    await this.traefikFiles.toggleDashboardApi(
      body.enableDashboard === true,
      body.serverId,
    );

    // Fire-and-forget: the client polls health while Traefik is recreated.
    void this.traefikSetup
      .writeTraefikSetup({
        env: preparedEnv,
        additionalPorts: newPorts,
        serverId: body.serverId,
      })
      .catch((err) => {
        console.error('toggleDashboard background writeTraefikSetup:', err);
      });
    return true;
  }

  /** Traefik's additional published ports (traefikTargetAuthority). */
  @Get('traefik/ports')
  async getTraefikPorts(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, query.serverId);
    return this.dockerResources.readPorts('cloudgate-traefik', query.serverId);
  }

  /**
   * Replaces Traefik's additional published ports after checking none is in
   * use, and recreates Traefik in the background (traefikTargetAuthority).
   */
  @Post('traefik/ports')
  @HttpCode(200)
  async updateTraefikPorts(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateTraefikPortsDto,
  ) {
    const ctx = toCtx(user, session);
    await this.traefikTargetAuthority(ctx, body.serverId);
    try {
      // Withheld and merged back by `writeTraefikSetup`, not re-submitted.
      const env = await this.dnsChallenge.traefikEnv(body.serverId);

      for (const port of body.additionalPorts) {
        const portCheck = await this.dockerResources.checkPortInUse(
          port.publishedPort,
          body.serverId,
        );
        if (portCheck.isInUse) {
          throw new ConflictException(
            `Port ${port.targetPort} is already in use by ${portCheck.conflictingContainer}`,
          );
        }
      }
      const preparedEnv = prepareEnvironmentVariables(env);

      void this.traefikSetup
        .writeTraefikSetup({
          env: preparedEnv,
          additionalPorts: body.additionalPorts,
          serverId: body.serverId,
        })
        .catch((err) => {
          console.error(
            'updateTraefikPorts background writeTraefikSetup:',
            err,
          );
        });
      return true;
    } catch (error) {
      // Every failure answers 400, even the port conflict thrown above as 409.
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Error updating Traefik ports',
      );
    }
  }
}
