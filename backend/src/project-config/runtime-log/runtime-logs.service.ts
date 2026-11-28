import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ComposeType } from '../../compose/compose.schema';
import { findParentService } from '../../common/service-parent';
import type { ServiceParent } from '../../common/service-parent';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { rethrowIfHostUnreachable } from '../../docker-ops/host-reachability';
import { ContainerAccessService } from '../../realtime/container-access.service';
import { buildContainerLogsCommand } from '../../realtime/ws.utils';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import {
  isMaxBufferExceeded,
  RemoteExecService,
} from '../../remote/remote-exec.service';
import { runTargetOn } from '../../remote/run-target';
import type { RunTarget } from '../../remote/run-target';
import { stackVmRemoteId } from '../../remote/stack-vm-remote';
import { CloudRuntimeLogs } from './cloud-runtime-logs.service';
import { RUNTIME_LOG_LINES, RUNTIME_LOG_WINDOW_MS } from './runtime-log';
import type { RuntimeLog, RuntimeLogLine } from './runtime-log';
import { copyLinesOf, mergedWindow } from './server-runtime-log';

/** The two kinds that write a Runtime log; a database writes none. */
export type RuntimeLogServiceType = 'application' | 'compose';

/** What a window is asked for: `read_runtime_log`'s arguments, capped by the tool. */
export interface RuntimeLogWindowQuery {
  serviceType: RuntimeLogServiceType;
  count: number;
  since?: number;
  /**
   * The most bytes one copy's read may answer on its machine; past it the
   * read is a 413. The MCP log window sets it; the HTTP route leaves it to
   * the exec defaults.
   */
  maxBuffer?: number;
}

/** One window of a Service's Runtime log: its last lines, oldest first. */
export interface RuntimeLogWindow {
  serviceType: RuntimeLogServiceType;
  serviceId: string;
  lines: RuntimeLogLine[];
}

/** A cloud Service's reads, at most, for one window: each is a CloudWatch page. */
const CLOUD_WINDOW_PAGES = 5;

/** A Swarm service's or a container's owner label, as the Shell tab lists by. */
const STACK_LABEL = 'com.docker.stack.namespace';
const COMPOSE_LABEL = 'com.docker.compose.project';

/** One copy-holding thing to read: a Swarm service, or a container. */
interface LogSource {
  /** What `docker … logs` is given: a service name or a container id. */
  readonly target: string;
  /** The copy a container's lines name; a Swarm service's name their own. */
  readonly copy: string;
  readonly swarm: boolean;
}

/**
 * **A Service's Runtime log, wherever it runs** (CONTEXT.md "Runtime log").
 *
 * - **A Server, the platform host or a Stack VM** (ADR-0070): a one-shot
 *   read of Docker's output, the command `/docker-container-logs` builds with
 *   `follow=false` ({@link buildContainerLogsCommand}), run on the Service's
 *   own machine through its run target, for every copy it has — an
 *   Application's Swarm service with its task prefix, a Compose stack's Swarm
 *   services or containers — merged by time, each line naming its copy.
 *   Authorized through `ContainerAccessService.authorizeService`, the gate the
 *   container sockets' Shell tab listing asks; only copies carrying the
 *   Service's own owner label are read, so each is one that gate maps back.
 * - **A Cloud account**: {@link CloudRuntimeLogs.read}.
 *
 * Both are gated by `service: read`, like the Service's own read, after which
 * an id that names neither an Application nor a Compose of this Organization
 * — a database, another Organization's — is the same 404.
 */
@Injectable()
export class RuntimeLogs {
  private readonly logger = new Logger(RuntimeLogs.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly containerAccess: ContainerAccessService,
    private readonly remoteExec: RemoteExecService,
    private readonly cloud: CloudRuntimeLogs,
  ) {}

  /**
   * `GET /applications/:id/runtime-log`: one read from `since` (or the last
   * few minutes), every copy's lines merged by time, and where the next read
   * starts. A cloud Service is read exactly as it was; a Server Service
   * answers its lines from `since` on (from the last few minutes when not
   * given), at most {@link RUNTIME_LOG_LINES}, and `more` when it read that
   * many, so the next read can come at once.
   */
  async read(
    ctx: PermissionCtx,
    serviceId: string,
    since: number | undefined,
  ): Promise<RuntimeLog> {
    await this.permissions.checkServiceAccess(ctx, serviceId, 'read');
    const found = await this.serviceOf(ctx, serviceId, [
      'application',
      'compose',
    ]);
    if (found.serviceType === 'application' && found.cloudAccountId) {
      return this.cloud.read(ctx, serviceId, since);
    }
    // Docker reads as far back as asked; only an unasked read opens on the
    // last few minutes, as a cloud one does.
    const startTime = since ?? Date.now() - RUNTIME_LOG_WINDOW_MS;
    const lines = await this.onMachine(ctx, found, {
      count: RUNTIME_LOG_LINES,
      since: startTime,
    });
    return {
      lines,
      next: lines.at(-1)?.at ?? startTime,
      more: lines.length >= RUNTIME_LOG_LINES,
    };
  }

  /**
   * The last `count` lines the `serviceType` Service `serviceId` names
   * wrote, only those at or after `since` when given — `read_runtime_log`'s
   * window (ADR-0095); an id of the other kind is the same 404. A cloud
   * Service's log is read as the Cloudgate CLI reads it: its last few
   * minutes, and when that holds fewer than `count`, as far back as a read
   * goes (an hour) — see {@link inCloud}.
   */
  async window(
    ctx: PermissionCtx,
    serviceId: string,
    query: RuntimeLogWindowQuery,
  ): Promise<RuntimeLogWindow> {
    await this.permissions.checkServiceAccess(ctx, serviceId, 'read');
    const found = await this.serviceOf(ctx, serviceId, [query.serviceType]);
    const lines =
      found.serviceType === 'application' && found.cloudAccountId
        ? await this.inCloud(ctx, serviceId, query)
        : await this.onMachine(ctx, found, query);
    return { serviceType: found.serviceType, serviceId, lines };
  }

  /** The Service of one of `kinds` that `serviceId` names in this Organization, or a 404. */
  private async serviceOf(
    ctx: PermissionCtx,
    serviceId: string,
    kinds: readonly RuntimeLogServiceType[],
  ): Promise<ServiceParent & { serviceType: RuntimeLogServiceType }> {
    const organizationId = ctx.session.activeOrganizationId;
    for (const serviceType of kinds) {
      try {
        const found = await findParentService(
          this.db,
          organizationId,
          serviceId,
          serviceType,
        );
        return { ...found, serviceType };
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    throw new NotFoundException('Service not found');
  }

  /**
   * A cloud Service's window. Each start is read forward a page at a time,
   * for at most {@link CLOUD_WINDOW_PAGES} pages ({@link cloudPass}): the
   * last few minutes first, or `since` when given. When the last few minutes
   * hold fewer than `count`, the hour before is read too and merged with them
   * by id. An hour holding more than those pages reach ends before the last
   * few minutes, so its lines would be old ones with a gap before the newest:
   * the window is then the later start's lines alone. A first start that
   * itself holds more never reaches its last lines, and is refused asking for
   * a later `since` rather than answering old ones.
   */
  private async inCloud(
    ctx: PermissionCtx,
    serviceId: string,
    query: RuntimeLogWindowQuery,
  ): Promise<RuntimeLogLine[]> {
    const later = await this.cloudPass(ctx, serviceId, query.since);
    if (later === null) {
      throw new UnprocessableEntityException(
        'More of the Runtime log was written after since than one read reaches',
      );
    }
    const window = mergedWindow([later], query.count, query.since);
    if (query.since !== undefined || window.length >= query.count) {
      return window;
    }
    // `0` asks for as far back as a read goes (`startOf`'s lookback).
    const hour = await this.cloudPass(ctx, serviceId, 0);
    if (hour === null) return window;
    const byId = new Map<string, RuntimeLogLine>();
    for (const line of [...hour, ...later]) byId.set(line.id, line);
    return mergedWindow([[...byId.values()]], query.count);
  }

  /**
   * Every line from `start` on, by id, reading page after page while more is
   * left; `null` when more is still left after the last page allowed.
   */
  private async cloudPass(
    ctx: PermissionCtx,
    serviceId: string,
    start: number | undefined,
  ): Promise<RuntimeLogLine[] | null> {
    const seen = new Map<string, RuntimeLogLine>();
    let read = await this.cloud.read(ctx, serviceId, start);
    for (const line of read.lines) seen.set(line.id, line);
    for (let page = 1; read.more && page < CLOUD_WINDOW_PAGES; page += 1) {
      read = await this.cloud.read(ctx, serviceId, read.next);
      for (const line of read.lines) seen.set(line.id, line);
    }
    return read.more ? null : [...seen.values()];
  }

  private async onMachine(
    ctx: PermissionCtx,
    found: ServiceParent & { serviceType: RuntimeLogServiceType },
    query: { count: number; since?: number; maxBuffer?: number },
  ): Promise<RuntimeLogLine[]> {
    // The container sockets' own gate. It has already been answered above
    // for this caller, so a refusal here would be a race, not a decision.
    const service = await this.containerAccess.authorizeService(
      ctx,
      { serviceType: found.serviceType, serviceId: found.serviceId },
      'read',
    );
    // A stack in a Cloud account runs on its own Stack VM (ADR-0070).
    const remoteId =
      found.serviceType === 'compose' && service.inCloud
        ? stackVmRemoteId(found.serviceId)
        : service.serverId;
    const target = runTargetOn(remoteId, { remoteExec: this.remoteExec });
    try {
      const sources = await this.sourcesOf(
        target,
        service.appName,
        found.serviceType === 'compose' ? service.composeType : null,
      );
      const copies: RuntimeLogLine[][] = [];
      for (const source of sources) {
        const { stdout, stderr } = await target.exec(
          buildContainerLogsCommand({
            containerId: source.target,
            tail: String(query.count),
            since:
              query.since === undefined
                ? 'all'
                : String(Math.floor(query.since / 1000)),
            search: '',
            runType: source.swarm ? 'swarm' : null,
            follow: false,
            taskPrefix: source.swarm,
          }),
          query.maxBuffer === undefined ? {} : { maxBuffer: query.maxBuffer },
        );
        // Docker replays what the app wrote to stderr on its own stderr.
        copies.push(
          copyLinesOf(`${stdout}\n${stderr}`, source.copy, source.swarm),
        );
      }
      return mergedWindow(copies, query.count, query.since);
    } catch (error) {
      if (isMaxBufferExceeded(error)) {
        throw new PayloadTooLargeException('Runtime log window is too large');
      }
      rethrowIfHostUnreachable(this.logger, remoteId, error);
      throw error;
    }
  }

  /**
   * What holds the Service's copies on its machine, by the owner label the
   * container gate resolves it by: an Application's Swarm service (named its
   * `appName`), a `stack`'s Swarm services, a `docker-compose` stack's
   * containers, running or not — a crashed container's last lines are the
   * ones worth reading. Nothing deployed yet is no source and an empty log.
   */
  private async sourcesOf(
    target: RunTarget,
    appName: string,
    composeType: ComposeType | null,
  ): Promise<LogSource[]> {
    if (composeType === 'docker-compose') {
      const { stdout } = await target.exec([
        'docker',
        'ps',
        '-a',
        '--filter',
        `label=${COMPOSE_LABEL}=${appName}`,
        '--format',
        '{{.ID}}|{{.Names}}',
      ]);
      return linesOf(stdout).map((line) => {
        const [id, name] = line.split('|');
        return { target: id, copy: name || id, swarm: false };
      });
    }
    const { stdout } = await target.exec([
      'docker',
      'service',
      'ls',
      '--filter',
      composeType === 'stack'
        ? `label=${STACK_LABEL}=${appName}`
        : `name=${appName}`,
      '--format',
      '{{.Name}}',
    ]);
    // `name=` matches a prefix, so an Application's is the exact name.
    return linesOf(stdout)
      .filter((name) => composeType === 'stack' || name === appName)
      .map((name) => ({ target: name, copy: name, swarm: true }));
  }
}

function linesOf(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}
