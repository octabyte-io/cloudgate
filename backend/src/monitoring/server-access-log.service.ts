import * as path from 'node:path';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import { compose } from '../compose/compose.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { domain } from '../domains/domain.schema';
import { environment } from '../environments/environment.schema';
import { project } from '../projects/project.schema';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import {
  ForwardExecAbortedError,
  SshForwardService,
} from '../remote/ssh-forward.service';
import { server } from '../servers/server.schema';
import { accessLogPathUnder } from '../settings/access-log-rotation';
import {
  accessLogOn,
  mainTraefikDirectory,
} from '../settings/traefik-files.service';
import { AccessLogService } from './access-log.service';
import type { ReadStatsLogsInput } from './access-log.service';
import {
  bucketByHour,
  filterLogEntries,
  parseRawConfig,
  sortAndPage,
} from './access-log.parser';
import type { HourlyData } from './access-log.parser';
import { platformHostRows } from './platform-host-requests';
import type { PlatformHostService } from './platform-host-requests';
import {
  SERVER_ACCESS_LOG_READ_BYTES,
  SERVER_ACCESS_LOG_READ_TIMEOUT_MS,
  rowsTheCallerSees,
  serviceIdForLine,
  windowFromTail,
} from './server-access-log';
import type {
  DomainRoute,
  RequestRow,
  RequestService,
  ServiceChoice,
  TailWindow,
} from './server-access-log';
import type {
  ReadRequestsQueryDto,
  ReadServiceRequestsQueryDto,
} from './dto/monitoring.dto';

export type { RequestRow, RequestService } from './server-access-log';

/**
 * How a read went. `ok` is the only one that carries lines; every other is
 * answered instead of an empty read, so no lines is never "0 requests"
 * (ADR-0056):
 *
 * - `unreachable`: SSH failed.
 * - `logging-off`: the Server's traefik.yml has no `accessLog` block (or
 *   there is no traefik.yml at all).
 * - `awaiting-restart`: the block is there but there is no log file, so the
 *   running Traefik has not read it yet.
 * - `empty`: the file has no lines.
 * - `too-slow`: the read stopped at the time limit.
 *
 * A file with lines, none of them in the window or the filters, is `ok` with
 * a count of zero: logging works, and the page says so with its own words.
 */
export type RequestsReadState =
  | 'ok'
  | 'unreachable'
  | 'logging-off'
  | 'awaiting-restart'
  | 'empty'
  | 'too-slow';

/** The states answered instead of lines. */
type UnreadState = Exclude<RequestsReadState, 'ok'>;

/** One answer of `GET /monitoring/requests`. */
export interface RequestsRead {
  state: RequestsReadState;
  /** Which log was read: a Server, or the platform host (`serverId: null`). */
  target: { serverId: string | null; name: string };
  /**
   * Whether the caller may turn this log on or off — owner or admin of the
   * Server's Organization, the gate `POST /settings/traefik/requests` takes
   *; instance authority on the platform host. The page chooses
   * between the settings link and "ask an owner or admin" by it.
   */
  canSwitchLogging: boolean;
  /** When the read happened ("Read from … at"). */
  readAt: string;
  /** One page of the rows the caller may see, newest first. */
  data: RequestRow[];
  /** Every row the caller may see in the window and filters. */
  totalCount: number;
  /** Those same rows per UTC hour of their start; empty hours left out. */
  hours: HourlyData[];
  /** How far back the read reached, when it fell short of the window. */
  retainedFrom?: string;
  /**
   * The Service filter's options: the Services on this Server, or on the
   * platform host, that the caller may read in their active Organization, by
   * name.
   */
  services: RequestService[];
  /**
   * Whether "No Service" is an option: `server: ['read']` on this Server;
   * instance authority on the platform host.
   */
  noService: boolean;
  /**
   * Whether the caller sees every line on this Server — `server: ['read']`
   * and every Service on it — whatever the filter: the filter's "All", or
   * "All yours" when false.
   */
  wholeServer: boolean;
  /**
   * What the totals count: the whole Server (`server`), only the
   * Services the caller may read because some lines are not theirs
   * (`your-services`, "N requests to your Services"), or the Services picked
   * in the filter (`chosen-services`, "to the chosen Services").
   */
  covers: RequestsCoverage;
  /**
   * Lines withheld from the caller because their host, which one of the
   * Services this read covers holds on the platform host, is held there by
   * another Organization too, so they match no Service (ADR-0061). Counted
   * in the window and filters; always 0 on a Server.
   */
  withheldShared: number;
}

/**
 * What a read's totals count; see {@link RequestsRead.covers}. `service` is a
 * Service's own Requests tab: one Service, fixed by the address.
 */
export type RequestsCoverage =
  'server' | 'your-services' | 'chosen-services' | 'service';

/**
 * One answer of `GET /monitoring/requests/services/:serviceId`, a Service's
 * Requests tab: its Server's read, or the platform host's (ADR-0061), with
 * the Service filter fixed to it — or `cloud-account` for a Service in a
 * Cloud account, which runs on no Traefik of ours, so its requests are in
 * that cloud's own load balancer or CDN logs (ADR-0035).
 */
export type ServiceRequestsRead = RequestsRead | ServiceWithoutRead;

/** A Service whose requests no Traefik of this instance logs. */
export interface ServiceWithoutRead {
  state: 'cloud-account';
  /** The Service the tab is on. */
  service: RequestService;
}

/** An entry of the Requests page's Server picker. */
export interface RequestsTarget {
  serverId: string;
  name: string;
}

/** `GET /monitoring/requests/servers`. */
export interface RequestsTargets {
  servers: RequestsTarget[];
  /**
   * Whether the platform host is one more entry: instance authority, or a
   * Service there the caller may read (ADR-0061).
   */
  platformHost: boolean;
  /**
   * Whether the caller can read a Service of the Organization that runs in a
   * Cloud account, so a page with no Servers can point them to that cloud's
   * own load balancer or CDN logs. A Cloud account Service has no
   * Server and no Traefik, so its requests are never here.
   */
  cloudAccountServices: boolean;
}

/** A page of the table, when the caller names none: the console's own size. */
const DEFAULT_PAGE_SIZE = 50;

/** A read's window, filters and page, as the shared parser takes them. */
function inputOf(query: ReadServiceRequestsQueryDto): ReadStatsLogsInput {
  return {
    search: query.search,
    status: query.status,
    method: query.method,
    dateRange: { start: query.start, end: query.end },
    page: {
      pageIndex: query.pageIndex ?? 0,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
    },
  };
}

/** The platform host's name in the picker and the footer. */
export const PLATFORM_HOST_NAME = 'Platform host';

/** What the caller may read on the Requests page; see `accessOf`. */
interface RequestsAccess {
  readsServer: boolean;
  readsService: (serviceId: string) => boolean;
  /** Owner or admin: the Request logging switch's own role gate. */
  switchesLogging: boolean;
}

/** An Application or a Compose stack: a Service that can have a Domain. */
interface DomainService extends PlatformHostService {
  serverId: string | null;
  kind: 'app' | 'compose';
}

/**
 * Where the Services `domainServices` lists run: one Server, any Server, or
 * the platform host — on no Server and in no Cloud account.
 */
type DomainServicePlace = { serverId: string } | 'any-server' | 'platform-host';

/**
 * The Services the caller may read among these: `service: ['read']` on each,
 * and only those of their active Organization — `serviceAccess` answers for
 * an id, not for whose it is.
 */
function readableBy(
  services: DomainService[],
  organizationId: string,
  access: RequestsAccess,
): DomainService[] {
  return services.filter(
    (service) =>
      service.organizationId === organizationId &&
      access.readsService(service.serviceId),
  );
}

/** What a read's totals count; see {@link RequestsRead.covers}. */
function coverageOf(
  chosen: ServiceChoice | null,
  whole: boolean,
): RequestsCoverage {
  if (chosen?.fixed) return 'service';
  if (chosen) return 'chosen-services';
  return whole ? 'server' : 'your-services';
}

/**
 * The Service filter's options, by name. A Service's tab offers no Service
 * filter: its one option is itself.
 */
function filterOptions(
  chosen: ServiceChoice | null,
  readable: DomainService[],
): RequestService[] {
  if (chosen?.fixed) return [chosen.fixed];
  return readable
    .map(({ serviceId, name }) => ({ serviceId, name }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.serviceId.localeCompare(b.serviceId),
    );
}

/** What one read answers whatever it found: the target and the caller's view. */
type ReadFrame = Pick<
  RequestsRead,
  | 'target'
  | 'canSwitchLogging'
  | 'services'
  | 'noService'
  | 'wholeServer'
  | 'covers'
>;

/**
 * One read's answers, stamped when the read began: a state, and the rows
 * already in the window and filters, paged and bucketed here.
 */
function answerFor(input: ReadStatsLogsInput, frame: ReadFrame) {
  const readAt = new Date().toISOString();
  return (
    state: RequestsReadState,
    rows: RequestRow[] = [],
    extra: { retainedFrom?: string; withheldShared?: number } = {},
  ): RequestsRead => ({
    state,
    ...frame,
    readAt,
    data: sortAndPage(rows, input.page, input.sort),
    totalCount: rows.length,
    hours: bucketByHour(rows),
    ...(extra.retainedFrom ? { retainedFrom: extra.retainedFrom } : {}),
    withheldShared: extra.withheldShared ?? 0,
  });
}

/**
 * The Requests page's reads: one Server's Access log, read live over SSH and
 * split by Service (ADR-0055, ADR-0056), or the platform host's, read from
 * this machine by `AccessLogService` and split the same way, with matching
 * that fails closed across Organizations (ADR-0061).
 *
 * **Who sees what is decided per line, here, before anything is counted.** A
 * line goes to a caller holding `service: ['read']` on the Service whose
 * Domain it matched — the same role-plus-`accessedServices` question
 * `checkServiceAccess` asks of an Uptime check or a Trace store. A line that
 * matched no Domain goes only to a `server: ['read']` holder.
 * `monitoring: ['read']` is never consulted: it is a Server's own metrics,
 * and the base member role holds it.
 *
 * **Never the Instance organization's authority over a Server** (ADR-0050):
 * a Server is read only through the caller's own Organization. And no route
 * here is open to an Agent — the auth guard refuses an Agent key on every
 * REST route, and no MCP tool reads this.
 *
 * Nothing read is written anywhere: no table, no file, no cache.
 */
@Injectable()
export class ServerAccessLogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly forward: SshForwardService,
    private readonly platformHost: AccessLogService,
  ) {}

  /**
   * The Server picker: every Server of the caller's Organization where they
   * can read at least one Service that can have a Domain, or hold
   * `server: ['read']` — whether or not its logging is on, which takes no
   * SSH to list. The platform host is one more entry for instance authority
   * and for anyone who can read a Service there (ADR-0061).
   */
  async listTargets(ctx: PermissionCtx): Promise<RequestsTargets> {
    const access = await this.accessOf(ctx);
    const servers = await this.db
      .select({ serverId: server.serverId, name: server.name })
      .from(server)
      .where(eq(server.organizationId, ctx.session.activeOrganizationId))
      .orderBy(asc(server.name), asc(server.serverId));

    const organizationId = ctx.session.activeOrganizationId;
    let visible = servers;
    if (!access.readsServer) {
      const services = await this.domainServices('any-server', organizationId);
      const withReadable = new Set(
        readableBy(services, organizationId, access).map(
          (service) => service.serverId,
        ),
      );
      visible = servers.filter((row) => withReadable.has(row.serverId));
    }

    const inClouds = await this.db
      .select({ serviceId: application.applicationId })
      .from(application)
      .innerJoin(
        environment,
        eq(environment.environmentId, application.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(project.organizationId, ctx.session.activeOrganizationId),
          isNotNull(application.cloudAccountId),
        ),
      );

    const onPlatformHost =
      readableBy(
        await this.domainServices('platform-host'),
        organizationId,
        access,
      ).length > 0;
    return {
      servers: visible,
      platformHost:
        onPlatformHost || (await this.permissions.holdsInstanceAuthority(ctx)),
      cloudAccountServices: inClouds.some((row) =>
        access.readsService(row.serviceId),
      ),
    };
  }

  /**
   * One read: a Server's log when `serverId` is given, the platform host's
   * otherwise. A Server outside the caller's Organization, or one where they
   * can read nothing, is the usual "Server not found".
   */
  async read(
    ctx: PermissionCtx,
    query: ReadRequestsQueryDto,
  ): Promise<RequestsRead> {
    const input = inputOf(query);
    const chosen: ServiceChoice | null =
      (query.serviceId?.length ?? 0) > 0 || query.noService === 'true'
        ? {
            serviceIds: new Set(query.serviceId ?? []),
            noService: query.noService === 'true',
          }
        : null;
    return query.serverId
      ? this.readServer(ctx, query.serverId, input, chosen)
      : this.readPlatformHost(ctx, input, chosen);
  }

  /**
   * A Service's Requests tab: needs no Server. It finds the
   * Service's own place itself and reads its Server's log, or the platform
   * host's, with the Service filter fixed to this one Service. Only an Application or a
   * Compose stack — the Services that can have a Domain — has one; any other
   * id, a Database's included, is "Service not found", as is a Service the
   * caller may not read (`service: ['read']`, the page's own gate) or one in
   * another Organization.
   */
  async readService(
    ctx: PermissionCtx,
    serviceId: string,
    query: ReadServiceRequestsQueryDto,
  ): Promise<ServiceRequestsRead> {
    const access = await this.accessOf(ctx);
    const placed = await this.placeOf(
      ctx.session.activeOrganizationId,
      serviceId,
    );
    if (!placed || !access.readsService(serviceId)) {
      throw new NotFoundException('Service not found');
    }
    const service = { serviceId, name: placed.name };
    if (placed.cloudAccountId !== null) {
      return { state: 'cloud-account', service };
    }
    const fixed: ServiceChoice = {
      serviceIds: new Set([serviceId]),
      noService: false,
      fixed: service,
    };
    return placed.serverId === null
      ? this.readPlatformHost(ctx, inputOf(query), fixed)
      : this.readServer(ctx, placed.serverId, inputOf(query), fixed);
  }

  private async readServer(
    ctx: PermissionCtx,
    serverId: string,
    input: ReadStatsLogsInput,
    chosen: ServiceChoice | null,
  ): Promise<RequestsRead> {
    const access = await this.accessOf(ctx);
    const [target] = await this.db
      .select({ serverId: server.serverId, name: server.name })
      .from(server)
      .where(
        and(
          eq(server.serverId, serverId),
          eq(server.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!target) throw new NotFoundException('Server not found');

    const organizationId = ctx.session.activeOrganizationId;
    const services = await this.domainServices({ serverId }, organizationId);
    const readable = readableBy(services, organizationId, access);
    if (!access.readsServer && readable.length === 0) {
      throw new NotFoundException('Server not found');
    }

    // Totals fall short of the whole Server when some of its lines are not
    // the caller's: a Service they cannot read, or — without
    // `server: ['read']` — the lines that matched none.
    const wholeServer =
      access.readsServer && readable.length === services.length;
    const answer = answerFor(input, {
      target,
      canSwitchLogging: access.switchesLogging,
      services: filterOptions(chosen, readable),
      noService: chosen?.fixed ? false : access.readsServer,
      wholeServer,
      covers: coverageOf(chosen, wholeServer),
    });

    const tail = await this.readTail(serverId, input);
    if (typeof tail === 'string') return answer(tail);

    const routes = await this.routesFor(services);
    const rows = rowsTheCallerSees(
      tail.rows.map((line) => ({
        line,
        serviceId: serviceIdForLine(line, routes),
      })),
      (serviceId) =>
        serviceId === null
          ? access.readsServer
          : access.readsService(serviceId),
      chosen,
      new Map(services.map((service) => [service.serviceId, service.name])),
    );
    return answer('ok', filterLogEntries(rows, input), {
      retainedFrom: tail.retainedFrom,
    });
  }

  /**
   * One bounded read of the end of the live file over the Server's pooled
   * connection: `cat` of its traefik.yml, `wc -c` for the log's size, then
   * `tail -c` of at most {@link SERVER_ACCESS_LOG_READ_BYTES}. Argv only,
   * with no `jq` or anything else assumed on the Server. Stopped after
   * {@link SERVER_ACCESS_LOG_READ_TIMEOUT_MS}, all three together.
   *
   * **Each step that finds nothing answers why**, in order:
   *
   * - traefik.yml with no `accessLog` block, read the way rotation reads it
   *   (`accessLogOn`), is `logging-off` — whatever file an earlier "on" left
   *   behind, which is not read. No traefik.yml at all (`cat` exits non-zero
   *   on a Server that answered) is a Server with logging off too.
   * - The block with no file (`wc` exits non-zero) is `awaiting-restart`:
   *   `accessLog` is static configuration, and a running Traefik writes the
   *   file it names only once it starts with it.
   * - A file of no bytes is `empty`.
   *
   * A connection that fails is `unreachable`; one that has not finished in
   * time is `too-slow`.
   */
  private async readTail(
    serverId: string,
    input: ReadStatsLogsInput,
  ): Promise<TailWindow | UnreadState> {
    const traefikRoot = mainTraefikDirectory(serverId);
    // The file `TraefikFilesService` reads and writes as this Server's
    // traefik.yml (`mainConfigPath`), beside the `dynamic/` the log is in.
    const configPath = path.join(traefikRoot, 'traefik.yml');
    const logPath = accessLogPathUnder(traefikRoot);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SERVER_ACCESS_LOG_READ_TIMEOUT_MS,
    );
    const { signal } = controller;
    const timedOut = new Promise<'too-slow'>((resolve) =>
      signal.addEventListener('abort', () => resolve('too-slow'), {
        once: true,
      }),
    );

    const work = (async (): Promise<TailWindow | UnreadState> => {
      const config = await this.forward.exec(serverId, ['cat', configPath], {
        signal,
      });
      if (config.code !== 0 || !accessLogOn(config.stdout)) {
        return 'logging-off';
      }
      const sized = await this.forward.exec(serverId, ['wc', '-c', logPath], {
        signal,
      });
      if (sized.code !== 0) return 'awaiting-restart';
      const size = Number.parseInt(sized.stdout.trim(), 10) || 0;
      if (size === 0) return 'empty';
      const bytes = Math.min(size, SERVER_ACCESS_LOG_READ_BYTES);
      const tailed = await this.forward.exec(
        serverId,
        ['tail', '-c', String(bytes), logPath],
        { signal },
      );
      if (tailed.code !== 0) return 'unreachable';
      return windowFromTail(
        {
          text: tailed.stdout,
          fromStart: size <= SERVER_ACCESS_LOG_READ_BYTES,
        },
        input.dateRange,
      );
    })().catch((error: unknown) =>
      error instanceof ForwardExecAbortedError || signal.aborted
        ? ('too-slow' as const)
        : ('unreachable' as const),
    );

    try {
      return await Promise.race([work, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The platform host's read (ADR-0061), in a Server read's shape and split
   * per line as one is, against every Organization's Domains there
   * ({@link platformHostMatcher}):
   *
   * - A line that matched a Service goes to a caller holding
   *   `service: ['read']` on it, and only while it is a Service of their
   *   active Organization: `serviceAccess` answers for an id, not for whose
   *   it is.
   * - A line that matched no Service — no Domain, or a host more than one
   *   Organization holds here — goes only to the Instance organization's
   *   authority. `server: ['read']` does not reach it: the platform host has
   *   no `server` row.
   * - The Instance organization's authority reads every line, each matched
   *   one naming its Service, whichever Organization's — a shared host's
   *   line included, named by the route Traefik took (`routedTo`).
   *
   * A caller with neither instance authority nor a readable Service here gets
   * the instance-authority refusal this read always answered. Query values
   * are hidden for every reader by `parseRawConfig`, before the search runs
   * (#1342). The logging switch stays with instance authority; anyone else is
   * told it is off.
   */
  private async readPlatformHost(
    ctx: PermissionCtx,
    input: ReadStatsLogsInput,
    chosen: ServiceChoice | null,
  ): Promise<RequestsRead> {
    const instance = await this.permissions.holdsInstanceAuthority(ctx);
    const access = await this.accessOf(ctx);
    const services = await this.domainServices('platform-host');
    const readable = readableBy(
      services,
      ctx.session.activeOrganizationId,
      access,
    );
    if (!instance && readable.length === 0) {
      await this.permissions.checkInstanceAuthority(ctx);
    }

    const answer = answerFor(input, {
      target: { serverId: null, name: PLATFORM_HOST_NAME },
      canSwitchLogging: instance,
      services: filterOptions(chosen, readable),
      noService: chosen?.fixed ? false : instance,
      wholeServer: instance,
      covers: coverageOf(chosen, instance),
    });

    if (!this.platformHost.loggingOn()) return answer('logging-off');
    const window = await this.platformHost.readWindow(input.dateRange);
    if (window === null) return answer('awaiting-restart');

    const { data: lines } = parseRawConfig(
      window.raw,
      undefined,
      undefined,
      input.search,
      input.status,
      input.dateRange,
      input.method,
    );
    const { rows, withheldShared } = platformHostRows(
      lines,
      services,
      await this.routesFor(services),
      {
        instance,
        readableIds: new Set(readable.map((service) => service.serviceId)),
        chosen,
      },
    );
    return answer('ok', rows, {
      withheldShared,
      retainedFrom: window.retainedFrom,
    });
  }

  /**
   * What the caller may read on the Requests page, from their role and their
   * member row: `server: ['read']`, and which Services `checkServiceAccess`
   * would let them read (`PermissionService.serviceAccess`, its rule as a
   * predicate).
   */
  private async accessOf(ctx: PermissionCtx): Promise<RequestsAccess> {
    const memberRow = await this.permissions.findMember(ctx);
    return {
      readsServer: await this.permissions.holdsPermission(ctx, {
        server: ['read'],
      }),
      readsService: await this.permissions.serviceAccess(ctx),
      switchesLogging: memberRow.role === 'owner' || memberRow.role === 'admin',
    };
  }

  /**
   * Where one of the Organization's Applications or Compose stacks runs: its
   * Server, its Cloud account (an Application only: a Compose stack never
   * runs in one), or neither, the platform host. Null for any other id, a
   * Database's included, which has no Domain and so no Requests.
   */
  private async placeOf(
    organizationId: string,
    serviceId: string,
  ): Promise<{
    name: string;
    serverId: string | null;
    cloudAccountId: string | null;
  } | null> {
    const [app] = await this.db
      .select({
        name: application.name,
        serverId: application.serverId,
        cloudAccountId: application.cloudAccountId,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(environment.environmentId, application.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(application.applicationId, serviceId),
          eq(project.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (app) return app;
    const [stack] = await this.db
      .select({ name: compose.name, serverId: compose.serverId })
      .from(compose)
      .innerJoin(
        environment,
        eq(environment.environmentId, compose.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(compose.composeId, serviceId),
          eq(project.organizationId, organizationId),
        ),
      )
      .limit(1);
    return stack ? { ...stack, cloudAccountId: null } : null;
  }

  /**
   * The Applications and Compose stacks — the Services that can have a
   * Domain, so the ones a line can belong to; a Database has none — that run
   * in `place`, with whose they are. Narrowed to one Organization when
   * `organizationId` is given; the platform host's line match is against
   * every Organization's Domains there (ADR-0061), so its read gives none. A
   * Cloud account Application is in no place here: its Domains never count.
   */
  private async domainServices(
    place: DomainServicePlace,
    organizationId?: string,
  ): Promise<DomainService[]> {
    const inOrganization = organizationId
      ? eq(project.organizationId, organizationId)
      : undefined;
    const placed = (
      serverIdColumn: typeof application.serverId | typeof compose.serverId,
    ): SQL =>
      place === 'platform-host'
        ? isNull(serverIdColumn)
        : place === 'any-server'
          ? isNotNull(serverIdColumn)
          : eq(serverIdColumn, place.serverId);

    const applications = await this.db
      .select({
        serviceId: application.applicationId,
        name: application.name,
        serverId: application.serverId,
        organizationId: project.organizationId,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(environment.environmentId, application.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          inOrganization,
          placed(application.serverId),
          place === 'platform-host'
            ? isNull(application.cloudAccountId)
            : undefined,
        ),
      );
    const stacks = await this.db
      .select({
        serviceId: compose.composeId,
        name: compose.name,
        serverId: compose.serverId,
        organizationId: project.organizationId,
      })
      .from(compose)
      .innerJoin(
        environment,
        eq(environment.environmentId, compose.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(and(inOrganization, placed(compose.serverId)));
    return [
      ...applications.map((row) => ({ ...row, kind: 'app' as const })),
      ...stacks.map((row) => ({ ...row, kind: 'compose' as const })),
    ];
  }

  /** Every Domain of these Services, as the line match reads them. */
  private async routesFor(
    services: { serviceId: string; kind: 'app' | 'compose' }[],
  ): Promise<DomainRoute[]> {
    const appIds = services
      .filter((service) => service.kind === 'app')
      .map((service) => service.serviceId);
    const composeIds = services
      .filter((service) => service.kind === 'compose')
      .map((service) => service.serviceId);
    if (appIds.length === 0 && composeIds.length === 0) return [];

    const owners = [
      ...(appIds.length > 0 ? [inArray(domain.applicationId, appIds)] : []),
      ...(composeIds.length > 0 ? [inArray(domain.composeId, composeIds)] : []),
    ];
    const rows = await this.db
      .select({
        host: domain.host,
        path: domain.path,
        applicationId: domain.applicationId,
        composeId: domain.composeId,
      })
      .from(domain)
      .where(or(...owners));
    return rows.map((row) => ({
      serviceId: (row.applicationId ?? row.composeId) as string,
      host: row.host,
      path: row.path,
    }));
  }
}
