import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { ServiceType } from '../applications/application.schema';
import { findParentService } from '../common/service-parent';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { domain, uptimeCheck } from '../db/schema';
import type { Domain } from '../domains/domain.schema';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { HTTP_ONLY_FIELDS } from './dto/uptime-check.dto';
import type {
  CreateUptimeCheckDto,
  UpdateUptimeCheckDto,
} from './dto/uptime-check.dto';
import { IncidentsService } from './incidents.service';
import type { Transition } from './incidents.service';
import type { UptimeCheck } from './service-health.schema';
import { ownerIdOf, UPTIME_CHECK_OWNER_FIELD } from './service-owner';
import { publishedPortsOf, tcpHostOf } from './published-ports';
import type { PublishedPorts } from './published-ports';
import { httpTargetUrl, tcpAddress } from './uptime-check-target';

/** What an HTTP check is aimed at, as every read answers it. */
export interface UptimeCheckTarget {
  domainId: string;
  host: string;
  path: string;
  https: boolean;
  /** The URL a Probe requests. */
  url: string;
}

/** What a TCP check dials: a published port on its Server's address. */
export interface UptimeCheckTcpTarget {
  host: string;
  port: number;
  /** `host:port`, as the console and a Notification name it. */
  address: string;
}

/**
 * An Uptime check as the API answers it. **The header value is never in it**:
 * `hasHeaderValue` says whether one is stored, and nothing else about
 * it leaves the backend.
 */
export interface UptimeCheckView {
  uptimeCheckId: string;
  serviceType: ServiceType;
  serviceId: string;
  kind: UptimeCheck['kind'];
  /** An HTTP check's Domain; null for a TCP check. */
  target: UptimeCheckTarget | null;
  /** A TCP check's published port; null for an HTTP check. */
  tcpTarget: UptimeCheckTcpTarget | null;
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedStatuses: string[];
  downAfter: number;
  enabled: boolean;
  /**
   * Why Cloudgate turned the check off — that its port is no longer
   * published, or that its Service has no Server address to dial it on; null
   * when it is on or the operator turned it off.
   */
  disabledReason: string | null;
  createdAt: string;
  keyword: string | null;
  headerName: string | null;
  hasHeaderValue: boolean;
}

/** The Domain column an owner kind's Domains hang off; only these two have any. */
const DOMAIN_OWNER = {
  application: domain.applicationId,
  compose: domain.composeId,
} as const;

/**
 * Adding, editing, turning off and deleting a Service's Uptime checks. Every
 * write is `service: ['update']` on the owning Service and every
 * read `service: ['read']` — both through `checkServiceAccess`, after
 * `findParentService` has answered a Service in another Organization as not
 * found. `monitoring: ['read']` is not involved: a check is part of the
 * Service's definition, not a Server's metrics.
 *
 * **A check is only ever aimed at its own Service's targets**: an HTTP check
 * at one of its Domains ({@link ownDomain}), a TCP check at one of its
 * published TCP ports ({@link ownPort}), so neither a create nor an edit
 * can point one at a URL or a port the Service does not serve, or at another
 * Organization's host.
 *
 * **The header value is write-only**: a create or an update takes it,
 * `null` removes it, and no answer carries it — {@link toView} says only
 * `hasHeaderValue`.
 *
 * Every write is audited by the route (`uptime-checks` in `KIND_BY_SEGMENT`),
 * which is why none of them writes its own audit row.
 */
@Injectable()
export class UptimeChecksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly incidents: IncidentsService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /** A Service's checks, oldest first; any caller who may read the Service. */
  async list(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
  ): Promise<UptimeCheckView[]> {
    await this.authorize(ctx, serviceType, serviceId, 'read');
    return this.viewsOf(serviceType, serviceId);
  }

  /**
   * The TCP ports a check on this Service may dial and the address it dials
   * them on, or why there are none; any caller who may read it.
   */
  async publishedPorts(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
  ): Promise<PublishedPorts> {
    await this.authorize(ctx, serviceType, serviceId, 'read');
    return publishedPortsOf(this.db, serviceType, serviceId, this.instanceMode);
  }

  /**
   * Adds a check to a Service; a caller who may update the Service. An HTTP
   * check is aimed at one of its own Domains, which only an Application or a
   * Compose has; a TCP check at one of its published TCP ports, and a Service
   * without one is refused with the reason and the way to publish one. A
   * Service with no Server to dial (`tcpPlaceOf`) has no published port to
   * offer, so it is refused a TCP check the same way.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateUptimeCheckDto,
  ): Promise<UptimeCheckView> {
    await this.authorize(ctx, data.serviceType, data.serviceId, 'update');
    if (data.kind === 'tcp') {
      await this.ownPort(data.serviceType, data.serviceId, data.port!);
    } else {
      await this.ownDomain(data.serviceType, data.serviceId, data.domainId!);
    }
    const http = data.kind !== 'tcp';

    const owner = (type: ServiceType) =>
      data.serviceType === type ? data.serviceId : null;
    const [created] = await this.db
      .insert(uptimeCheck)
      .values({
        serviceType: data.serviceType,
        applicationId: owner('application'),
        composeId: owner('compose'),
        libsqlId: owner('libsql'),
        mariadbId: owner('mariadb'),
        mongoId: owner('mongo'),
        mysqlId: owner('mysql'),
        postgresId: owner('postgres'),
        redisId: owner('redis'),
        kind: http ? 'http' : 'tcp',
        domainId: http ? data.domainId : null,
        port: http ? null : data.port,
        intervalSeconds: data.intervalSeconds ?? 60,
        timeoutSeconds: data.timeoutSeconds ?? 10,
        expectedStatuses: data.expectedStatuses ?? ['2xx'],
        downAfter: data.downAfter ?? 3,
        enabled: data.enabled ?? true,
        keyword: http ? (data.keyword ?? null) : null,
        headerName: http ? (data.headerName ?? null) : null,
        headerValue:
          http && data.headerName ? (data.headerValue ?? null) : null,
      })
      .returning();
    return this.viewOf(created);
  }

  /**
   * Edits a check; a caller who may update its Service. **Turning it off
   * closes its open Incident with `turned-off`** and announces that once;
   * every other edit leaves an open Incident open, to be judged by the new
   * rule at the next Probe. Turning it back on opens nothing by
   * itself.
   *
   * **A TCP check is turned on only at a published port**: turning
   * one on runs the same {@link ownPort} an edit of its port does, on the
   * port it will dial, so a check Cloudgate turned off for a lost port cannot
   * be turned back on without being re-aimed. Any write of `enabled` or
   * `port` clears Cloudgate's `disabledReason`: from then on the check's
   * state is the operator's.
   */
  async update(
    ctx: PermissionCtx,
    uptimeCheckId: string,
    data: UpdateUptimeCheckDto,
  ): Promise<UptimeCheckView> {
    const current = await this.findOwned(ctx, uptimeCheckId, 'update');
    if (Object.values(data).every((value) => value === undefined)) {
      return this.viewOf(current);
    }
    const serviceId = ownerIdOf(current);
    refuseOtherKindsFields(current.kind, data);
    if (data.domainId !== undefined) {
      await this.ownDomain(current.serviceType, serviceId, data.domainId);
    }
    const turningOn = !current.enabled && data.enabled === true;
    if (data.port !== undefined) {
      await this.ownPort(current.serviceType, serviceId, data.port);
    } else if (turningOn && current.kind === 'tcp' && current.port !== null) {
      await this.ownPort(current.serviceType, serviceId, current.port);
    }
    // `headerName: null` removes the header, value and all; a value is only
    // ever stored under a name (`uptime_check_header_value_has_name`).
    const headerName =
      data.headerName === undefined ? current.headerName : data.headerName;
    if (data.headerValue && !headerName) {
      throw new BadRequestException(
        'A header value is sent under a header name; set the name too',
      );
    }
    const headerValue = data.headerName === null ? null : data.headerValue;
    const intervalSeconds = data.intervalSeconds ?? current.intervalSeconds;
    const timeoutSeconds = data.timeoutSeconds ?? current.timeoutSeconds;
    if (timeoutSeconds > intervalSeconds) {
      throw new BadRequestException(
        'The timeout cannot be longer than the interval',
      );
    }

    const { updated, transitions } = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(uptimeCheck)
        .set({
          domainId: data.domainId,
          port: data.port,
          intervalSeconds: data.intervalSeconds,
          timeoutSeconds: data.timeoutSeconds,
          expectedStatuses: data.expectedStatuses,
          downAfter: data.downAfter,
          enabled: data.enabled,
          keyword: data.keyword,
          headerName: data.headerName,
          headerValue,
          ...((data.enabled !== undefined || data.port !== undefined) && {
            disabledReason: null,
          }),
        })
        .where(eq(uptimeCheck.uptimeCheckId, uptimeCheckId))
        .returning();
      const closed: Transition[] =
        current.enabled && data.enabled === false
          ? await this.incidents.closeForChecks(
              tx,
              [uptimeCheckId],
              'turned-off',
            )
          : [];
      // Turning it back on starts a fresh run too (US26): the downs from
      // before it was off do not count towards N.
      if (turningOn) {
        await this.incidents.startRuns(tx, [uptimeCheckId]);
      }
      return { updated: row, transitions: closed };
    });
    await this.incidents.announce(transitions);
    return this.viewOf(updated);
  }

  /**
   * Deletes a check with its Probes and Incidents; a caller who may update its
   * Service. **Announces nothing**, open Incident or not: the Incident
   * goes with its check, and a cleanup must not page anyone.
   */
  async remove(
    ctx: PermissionCtx,
    uptimeCheckId: string,
  ): Promise<UptimeCheckView> {
    const current = await this.findOwned(ctx, uptimeCheckId, 'update');
    const view = await this.viewOf(current);
    await this.db
      .delete(uptimeCheck)
      .where(eq(uptimeCheck.uptimeCheckId, uptimeCheckId));
    return view;
  }

  /** Every check of one Service as the API answers them, oldest first. */
  async viewsOf(
    serviceType: ServiceType,
    serviceId: string,
  ): Promise<UptimeCheckView[]> {
    // A Bucket has no uptime check, and no column to hold one.
    if (serviceType === 'bucket') return [];
    const rows = await this.db
      .select({ check: uptimeCheck, target: domain })
      .from(uptimeCheck)
      .leftJoin(domain, eq(domain.domainId, uptimeCheck.domainId))
      .where(eq(uptimeCheck[UPTIME_CHECK_OWNER_FIELD[serviceType]], serviceId))
      .orderBy(asc(uptimeCheck.createdAt), asc(uptimeCheck.uptimeCheckId));
    const tcpHost = rows.some(({ check }) => check.kind === 'tcp')
      ? await tcpHostOf(this.db, serviceType, serviceId, this.instanceMode)
      : null;
    return rows.map(({ check, target }) => toView(check, target, tcpHost));
  }

  /**
   * The owning Service in the caller's Organization, and the caller's right to
   * `action` it. A Service elsewhere reads as not found, before any role is
   * consulted (§2.2, ADR-0008).
   */
  async authorize(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
    action: 'read' | 'update',
  ): Promise<void> {
    await findParentService(
      this.db,
      ctx.session.activeOrganizationId,
      serviceId,
      serviceType,
    );
    await this.permissions.checkServiceAccess(ctx, serviceId, action);
  }

  private async findOwned(
    ctx: PermissionCtx,
    uptimeCheckId: string,
    action: 'read' | 'update',
  ): Promise<UptimeCheck> {
    const [row] = await this.db
      .select()
      .from(uptimeCheck)
      .where(eq(uptimeCheck.uptimeCheckId, uptimeCheckId))
      .limit(1);
    if (!row) throw new NotFoundException('Uptime check not found');
    try {
      await findParentService(
        this.db,
        ctx.session.activeOrganizationId,
        ownerIdOf(row),
        row.serviceType,
      );
    } catch {
      // Another Organization's check reads exactly as no check at all.
      throw new NotFoundException('Uptime check not found');
    }
    await this.permissions.checkServiceAccess(ctx, ownerIdOf(row), action);
    return row;
  }

  /**
   * Refuses a Domain that is not one of this Service's own. The same 400 for
   * a Domain that exists elsewhere and one that exists nowhere, so the
   * refusal says nothing about other Services' Domains.
   */
  private async ownDomain(
    serviceType: ServiceType,
    serviceId: string,
    domainId: string,
  ): Promise<void> {
    if (serviceType !== 'application' && serviceType !== 'compose') {
      throw new BadRequestException(
        'An HTTP Uptime check is aimed at one of its Service’s Domains, and only an Application or a Compose has Domains',
      );
    }
    const [found] = await this.db
      .select({ domainId: domain.domainId })
      .from(domain)
      .where(
        and(
          eq(domain.domainId, domainId),
          eq(DOMAIN_OWNER[serviceType], serviceId),
        ),
      )
      .limit(1);
    if (!found) {
      throw new BadRequestException(
        'The Domain is not one of this Service’s Domains',
      );
    }
  }

  /**
   * Refuses a port the Service does not publish over TCP now, with the
   * reason there is none when there is none — for a database, that it has no
   * external port and where to publish one (spec story 18) — and any port at
   * all on a Service with no Server address to dial it on: one in a Cloud
   * account, or one with no Server on the Hosted instance (`tcpPlaceOf`).
   * So such a check is neither created nor turned back on.
   */
  private async ownPort(
    serviceType: ServiceType,
    serviceId: string,
    port: number,
  ): Promise<void> {
    const published = await publishedPortsOf(
      this.db,
      serviceType,
      serviceId,
      this.instanceMode,
    );
    if (published.unavailableReason) {
      throw new BadRequestException(published.unavailableReason);
    }
    if (!published.ports.some((entry) => entry.port === port)) {
      const ports = published.ports.map((entry) => entry.port).join(', ');
      throw new BadRequestException(
        `Port ${port} is not one of this Service’s published TCP ports (${ports})`,
      );
    }
  }

  private async viewOf(check: UptimeCheck): Promise<UptimeCheckView> {
    const [target] = check.domainId
      ? await this.db
          .select()
          .from(domain)
          .where(eq(domain.domainId, check.domainId))
          .limit(1)
      : [];
    const tcpHost =
      check.kind === 'tcp'
        ? await tcpHostOf(
            this.db,
            check.serviceType,
            ownerIdOf(check),
            this.instanceMode,
          )
        : null;
    return toView(check, target ?? null, tcpHost);
  }
}

/**
 * Refuses a field the stored check's kind does not have: a Domain, statuses,
 * a keyword or a header on a TCP check, a port on an HTTP one.
 */
function refuseOtherKindsFields(
  kind: UptimeCheck['kind'],
  data: UpdateUptimeCheckDto,
): void {
  if (kind === 'http') {
    if (data.port !== undefined) {
      throw new BadRequestException(
        'An HTTP check is aimed at a Domain, not a port',
      );
    }
    return;
  }
  const foreign = HTTP_ONLY_FIELDS.filter(
    (field) => data[field] !== undefined && data[field] !== null,
  );
  if (foreign.length > 0) {
    throw new BadRequestException(
      `A TCP check has no ${foreign.join(', ')}; it only connects to its port`,
    );
  }
}

/**
 * One check, its Domain and (for TCP) its Service's address, as every read
 * answers them. Built field by field and never spread from the row, so the
 * header value cannot ride along.
 */
export function toView(
  check: UptimeCheck,
  target: Domain | null,
  tcpHost: string | null = null,
): UptimeCheckView {
  return {
    uptimeCheckId: check.uptimeCheckId,
    serviceType: check.serviceType,
    serviceId: ownerIdOf(check),
    kind: check.kind,
    target: target
      ? {
          domainId: target.domainId,
          host: target.host,
          path: target.path ?? '/',
          https: target.https,
          url: httpTargetUrl(target).toString(),
        }
      : null,
    tcpTarget:
      check.kind === 'tcp' && check.port !== null && tcpHost !== null
        ? {
            host: tcpHost,
            port: check.port,
            address: tcpAddress(tcpHost, check.port),
          }
        : null,
    intervalSeconds: check.intervalSeconds,
    timeoutSeconds: check.timeoutSeconds,
    expectedStatuses: check.expectedStatuses,
    downAfter: check.downAfter,
    enabled: check.enabled,
    disabledReason: check.disabledReason,
    createdAt: check.createdAt,
    keyword: check.keyword,
    headerName: check.headerName,
    hasHeaderValue: Boolean(check.headerValue),
  };
}
