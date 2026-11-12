import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  MethodNotAllowedException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, or } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { ServiceType } from '../applications/application.schema';
import { AuthService } from '../auth/auth.service';
import type { CredentialHandle } from '../auth/auth.service';
import { findParentService } from '../common/service-parent';
import type { UnreclaimedArtifact } from '../common/teardown-steps';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { traceStore } from '../db/schema';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import type { PutTracesDto } from './dto/traces.dto';
import {
  isTraceStoreRunning,
  isTraceServiceType,
  removeTraceStore,
  restartTraceStoreIfRunning,
  runtimeOf,
  traceStoreBasePath,
  traceStoreOwnerColumn,
  traceStoreRowOf,
  traceStoreSizeBytes,
} from './trace-store';
import {
  mintTraceStoreFrameToken,
  TRACE_STORE_FRAME_TTL_MS,
  traceStoreFrameBasePath,
  traceStoreFramePath,
  verifyTraceStoreFrameToken,
} from './trace-store-frame';
import { forwardToTraceStore, TraceStoreTransport } from './trace-store-proxy';
import type { TraceServiceType, TraceStoreOwner } from './trace-store';
import { DEFAULT_TRACE_RETENTION_DAYS } from './trace-store.schema';
import type { TraceStore } from './trace-store.schema';

/** A Service's traces setting as the API answers it. */
export interface TracesView {
  serviceType: TraceServiceType;
  serviceId: string;
  enabled: boolean;
  retentionDays: number;
  /** Whether the Service has a credential yet — never the credential (ADR-0019). */
  hasCredential: boolean;
}

/**
 * The traces read: the setting, and the store as it is on its Server
 * now. Both are read on demand, and only while traces are on.
 */
export interface TracesReadView extends TracesView {
  /**
   * Whether the store's container is running now. False while traces are
   * off, and while they are on but the Service has not been deployed since,
   * which is when the store starts.
   */
  storeRunning: boolean;
  /**
   * The store directory's size on disk, in bytes: Badger has no disk cap, so
   * this is what an operator watches. Null while traces are off, before the
   * store's first start, or when its Server could not be asked.
   */
  storeSizeBytes: number | null;
}

/** The answer to a write: the setting, and what a turn-off could not remove. */
export interface TracesWriteView extends TracesView {
  /** Absent rather than empty when nothing was left, `cascadeDelete`'s rule. */
  unreclaimedArtifacts?: UnreclaimedArtifact[];
}

/**
 * Where the console frames this viewer's Trace store, and until when: the UI's
 * base path under a frame token (`trace-store-frame.ts`), which the frame
 * opens a page under. Never a credential of the store's or the Service's.
 */
export interface TraceStoreFrameView {
  uiPath: string;
  expiresAt: string;
}

/**
 * Why a frame request is refused before its token is read further: forged,
 * altered, another Service's or expired, one answer for all of them.
 */
export const FRAME_TOKEN_REFUSAL =
  'This Trace store link is not valid or has expired: reopen the Traces tab';

/** Why a Database is refused traces (ADR-0028), as the 400 says it. */
export const DATABASE_TRACES_REFUSAL =
  'A Database cannot have traces: only an Application or a Compose has a Trace store';

/** Why the proxy has no store to reach: traces were never on, or are off. */
export const NO_TRACES_MESSAGE = 'This Service has no traces turned on';

/** Why the proxy's store is not there yet, as the 409 says it. */
export const STORE_NOT_RUNNING_MESSAGE =
  "The Service's Trace store is not running: it starts at the Service's next deploy";

/** What the proxy forwards: reads, see `TracesService.proxy`. */
const PROXIED_METHODS = new Set(['GET', 'HEAD', 'POST']);

/**
 * The path and query the store is asked for: its base path, then whatever
 * followed `/traces/:serviceId/ui/t/:token` in the request, byte for byte.
 * Read off `originalUrl` rather than the route's parameters, which Express has
 * already decoded.
 */
export function storePathOf(
  serviceId: string,
  token: string,
  originalUrl: string,
): string {
  const prefix = traceStoreFramePath(encodeURIComponent(serviceId), token);
  const rest = originalUrl.startsWith(prefix)
    ? originalUrl.slice(prefix.length)
    : '';
  return `${traceStoreBasePath(serviceId)}${rest}`;
}

/** A generated `basicauth` password: 32 URL-safe characters. */
const generateCredential = (): string => randomBytes(24).toString('base64url');

/**
 * A Service's **traces** setting (ADR-0028): reading it, and turning it
 * on, off, or changing its retention.
 *
 * - **Configured like an Error-rate threshold**: the read is
 *   `service: ['read']` and every write `service: ['update']` on the owning
 *   Service, through `checkServiceAccess` after `findParentService` has
 *   answered another Organization's Service as not found. Every write is
 *   audited by its route (`traces` in `KIND_BY_SEGMENT`).
 * - **Turning on writes the row and nothing else**: the store starts at the
 *   Service's next deploy (`DeploymentEngineService.deploy`, or
 *   `deployCompose` for a Compose, whose inner services share one store),
 *   which is also when the Service is told where to send.
 * - **Turning off removes the store's container and directory now**, on the
 *   Service's run Server, and keeps the row off, with its retention and
 *   credentials, for a later turn-on.
 * - **A retention change restarts a running store in place** with the new
 *   `ttl.spans`, keeping its directory and so its traces.
 */
@Injectable()
export class TracesService {
  private readonly logger = new Logger(TracesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly transport: TraceStoreTransport,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The Service's traces setting, and its store's state and size on disk;
   * off, with the default retention, when never set. A store that is off or
   * not started yet is said to be so, never an error, and so is a Server that
   * does not answer.
   */
  async get(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
  ): Promise<TracesReadView> {
    const parent = await this.authorize(ctx, serviceType, serviceId, 'read');
    const traceType = this.assertTraceable(serviceType);
    const row = await traceStoreRowOf(this.db, traceType, serviceId);
    if (!row?.enabled) {
      return {
        ...(row
          ? toTracesView(row)
          : {
              serviceType: traceType,
              serviceId,
              enabled: false,
              retentionDays: DEFAULT_TRACE_RETENTION_DAYS,
              hasCredential: false,
            }),
        storeRunning: false,
        storeSizeBytes: null,
      };
    }
    const owner = {
      serviceType: traceType,
      appName: parent.appName,
      serverId: parent.serverId,
    };
    const [storeRunning, storeSizeBytes] = await Promise.all([
      isTraceStoreRunning(this.remoteExec, owner),
      traceStoreSizeBytes(this.remoteExec, owner),
    ]);
    return { ...toTracesView(row), storeRunning, storeSizeBytes };
  }

  /**
   * Where the console frames the Service's Trace store for this caller: the
   * store's UI under a frame token minted for them (ADR-0075). Under the
   * check the proxy itself used to make with the session, and makes again on
   * every framed request: `service: ['read']` on the Service (the route's
   * decorator) and the caller's entitlement to it. A Service with no row, in
   * another Organization, or with traces off is the same 404 the proxy gives.
   *
   * The token is bound to `credential`, the session or Personal key the caller
   * was recognised by, so the frame ends with it.
   */
  async frame(
    ctx: PermissionCtx,
    credential: CredentialHandle,
    serviceId: string,
  ): Promise<TraceStoreFrameView> {
    const row = await this.storeRowOf(serviceId);
    await this.authorize(ctx, row.serviceType, serviceId, 'read');
    if (!row.enabled) throw new NotFoundException(NO_TRACES_MESSAGE);
    const expiresAt = Date.now() + TRACE_STORE_FRAME_TTL_MS;
    const token = mintTraceStoreFrameToken(this.frameSecret(), {
      serviceId,
      userId: ctx.user.id,
      organizationId: ctx.session.activeOrganizationId,
      credential,
      expiresAt,
    });
    return {
      uiPath: traceStoreFrameBasePath(serviceId, token),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Forwards one request from a Trace store frame to the Service's store's UI
   * or query API (ADR-0028, ADR-0075). The request carries no session: the
   * frame is sandboxed, so its requests are cross-site and the cookie stays
   * behind. Its authority is the frame token in its path, and nothing reaches
   * the store until all of this has passed, in this order:
   *
   * 1. the token is this Service's, signed by this instance and unexpired;
   * 2. the credential it was minted for is still alive and still acting in
   *    the Organization it was minted in (`AuthService.assertCredentialAlive`,
   *    ADR-0012's re-read by id);
   * 3. the one check, re-run as that Member: `service: ['read']` and the
   *    entitlement to the Service. `monitoring:read` plays no part.
   *
   * The Service is named by its id alone, which is how the store's base path
   * names it; its kind is its `trace_store` row's. A Service with no row, in
   * another Organization, or not one at all is the same 404.
   *
   * Only reads are forwarded, since a read is all `service: ['read']` grants:
   * `GET`, `HEAD`, and the `POST` the UI makes to render an uploaded trace
   * file, which the store answers without storing anything.
   */
  async proxy(
    token: string,
    serviceId: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    const claims = verifyTraceStoreFrameToken(
      this.frameSecret(),
      token,
      serviceId,
    );
    if (!claims) throw new UnauthorizedException(FRAME_TOKEN_REFUSAL);
    await this.auth.assertCredentialAlive(
      claims.credential,
      claims.organizationId,
    );
    const ctx: PermissionCtx = {
      user: { id: claims.userId },
      session: { activeOrganizationId: claims.organizationId },
    };

    const row = await this.storeRowOf(serviceId);
    const parent = await this.authorize(
      ctx,
      row.serviceType,
      serviceId,
      'read',
    );
    if (!row.enabled) throw new NotFoundException(NO_TRACES_MESSAGE);
    if (!PROXIED_METHODS.has(req.method)) {
      throw new MethodNotAllowedException(
        `A Trace store is read through the backend: ${[...PROXIED_METHODS].join(', ')} only`,
      );
    }

    const connection = await this.transport.open({
      serviceType: this.assertTraceable(row.serviceType),
      appName: parent.appName,
      serverId: parent.serverId,
    });
    if (!connection) throw new ConflictException(STORE_NOT_RUNNING_MESSAGE);

    await forwardToTraceStore({
      req,
      res,
      connection,
      path: storePathOf(serviceId, token, req.originalUrl),
      queryCredential: row.queryCredential,
      storeBasePath: traceStoreBasePath(serviceId),
      frameBasePath: traceStoreFrameBasePath(serviceId, token),
    });
  }

  /** The Service's `trace_store` row, by its id alone, or the proxy's 404. */
  private async storeRowOf(serviceId: string): Promise<TraceStore> {
    const [row] = await this.db
      .select()
      .from(traceStore)
      .where(
        or(
          eq(traceStore.applicationId, serviceId),
          eq(traceStore.composeId, serviceId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException(NO_TRACES_MESSAGE);
    return row;
  }

  /** What frame tokens are signed with: the instance's auth secret. */
  private frameSecret(): string {
    return this.config.getOrThrow<string>('BETTER_AUTH_SECRET');
  }

  /**
   * Sets the Service's traces, whole. The first write of either state makes
   * the row and its two credentials; they are kept from then on.
   */
  async put(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
    data: PutTracesDto,
  ): Promise<TracesWriteView> {
    const parent = await this.authorize(ctx, serviceType, serviceId, 'update');
    const traceType = this.assertTraceable(serviceType);
    const owner: TraceStoreOwner = {
      serviceType: traceType,
      serviceId,
      appName: parent.appName,
      serverId: parent.serverId,
    };

    const { before, after } = await this.db.transaction(async (tx) => {
      const column = traceStoreOwnerColumn(traceType);
      const lock = () =>
        tx.select().from(traceStore).where(eq(column, serviceId)).for('update');
      let [current] = await lock();
      if (!current) {
        const [created] = await tx
          .insert(traceStore)
          .values({
            serviceType: traceType,
            applicationId: traceType === 'application' ? serviceId : null,
            composeId: traceType === 'compose' ? serviceId : null,
            enabled: data.enabled,
            retentionDays: data.retentionDays,
            credential: generateCredential(),
            queryCredential: generateCredential(),
          })
          .onConflictDoNothing()
          .returning();
        if (created) return { before: null, after: created };
        // A PUT that raced this one created it first: set it over that one.
        [current] = await lock();
      }
      const [updated] = await tx
        .update(traceStore)
        .set({ enabled: data.enabled, retentionDays: data.retentionDays })
        .where(eq(traceStore.traceStoreId, current.traceStoreId))
        .returning();
      return { before: current, after: updated };
    });

    // Off: the store goes now, whether or not it was ever started. On a row
    // that was already off this is a retry of a removal that failed, which is
    // cheap because both commands are idempotent.
    if (!after.enabled) {
      const unreclaimed = await removeTraceStore(this.remoteExec, owner);
      return {
        ...toTracesView(after),
        ...(unreclaimed.length > 0
          ? { unreclaimedArtifacts: unreclaimed }
          : {}),
      };
    }
    if (before?.enabled && before.retentionDays !== after.retentionDays) {
      try {
        await restartTraceStoreIfRunning(
          this.remoteExec,
          runtimeOf(owner, after),
        );
      } catch (error) {
        // The setting is saved either way, and the next deploy starts a store
        // that is not running with it; a Server that cannot be reached now
        // must not turn a saved setting into a 500.
        this.logger.warn(
          `Could not restart the Trace store of ${owner.appName} with its new retention: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return toTracesView(after);
  }

  private assertTraceable(serviceType: ServiceType): TraceServiceType {
    if (!isTraceServiceType(serviceType)) {
      throw new BadRequestException(DATABASE_TRACES_REFUSAL);
    }
    return serviceType;
  }

  /**
   * The owning Service in the caller's Organization, and the caller's right
   * to `action` it — an Error-rate threshold's rule.
   */
  private async authorize(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
    action: 'read' | 'update',
  ) {
    const parent = await findParentService(
      this.db,
      ctx.session.activeOrganizationId,
      serviceId,
      serviceType,
    );
    await this.permissions.checkServiceAccess(ctx, serviceId, action);
    return parent;
  }
}

export function toTracesView(row: TraceStore): TracesView {
  return row.serviceType === 'application'
    ? view('application', row.applicationId as string, row)
    : view('compose', row.composeId as string, row);
}

const view = (
  serviceType: TraceServiceType,
  serviceId: string,
  row: TraceStore,
): TracesView => ({
  serviceType,
  serviceId,
  enabled: row.enabled,
  retentionDays: row.retentionDays,
  hasCredential: row.credential.length > 0,
});
