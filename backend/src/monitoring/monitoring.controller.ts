import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { AccessLogService } from './access-log.service';
import {
  ContainerMetricsQueryDto,
  MetricsQueryDto,
  ReadRequestsQueryDto,
  ReadServiceRequestsQueryDto,
  ReadStatsBodyDto,
  ReadStatsLogsBodyDto,
  ServerIdParamsDto,
  ServiceIdParamsDto,
  SetupMonitoringBodyDto,
} from './dto/monitoring.dto';
import { MonitoringService } from './monitoring.service';
import { ServerAccessLogService } from './server-access-log.service';

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

// Permission mapping: setup rides server:create, metric reads ride
// monitoring:read plus, when they name no Server, the instance authority
// `MonitoringService.findReadableTarget` asks for of the host's own metrics;
// container series there are decided per series instead, a managed one by
// entitlement to its Service (ADR-0067); both request queries gate in
// `AccessLogService` on that same instance authority, because the access log is
// one file the whole instance shares (H-64). The Requests page's own two routes
// gate per line in `ServerAccessLogService` instead (ADR-0055), so they carry
// no statement here: the picker lists, and the read answers, only what the
// caller's Services and `server: ['read']` reach.
@Controller('monitoring')
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly accessLog: AccessLogService,
    private readonly requests: ServerAccessLogService,
  ) {}

  @Post('servers/:serverId/setup')
  @HttpCode(200)
  @RequirePermission('server', 'create')
  setupMonitoring(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ServerIdParamsDto,
    @Body() body: SetupMonitoringBodyDto,
  ) {
    return this.monitoring.setupMonitoring(
      toCtx(user, session),
      params.serverId,
      body.metricsConfig,
    );
  }

  @Get('metrics')
  @RequirePermission('monitoring', 'read')
  getServerMetrics(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: MetricsQueryDto,
  ) {
    return this.monitoring.getServerMetrics(toCtx(user, session), query);
  }

  @Get('metrics/containers')
  @RequirePermission('monitoring', 'read')
  getContainerMetrics(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ContainerMetricsQueryDto,
  ) {
    return this.monitoring.getContainerMetrics(toCtx(user, session), query);
  }

  @Post('requests/logs')
  @HttpCode(200)
  readStatsLogs(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ReadStatsLogsBodyDto,
  ) {
    return this.accessLog.getStatsLogs(toCtx(user, session), body);
  }

  @Post('requests/stats')
  @HttpCode(200)
  readStats(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ReadStatsBodyDto,
  ) {
    return this.accessLog.getStats(toCtx(user, session), body);
  }

  /** The Requests page's Server picker. No SSH: logging-off Servers are listed. */
  @Get('requests/servers')
  listRequestTargets(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.requests.listTargets(toCtx(user, session));
  }

  /**
   * One read of a Server's access log over SSH (or the platform host's),
   * split by Service. A `GET`, so a Frozen Organization keeps it.
   */
  @Get('requests')
  readRequests(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ReadRequestsQueryDto,
  ) {
    return this.requests.read(toCtx(user, session), query);
  }

  /**
   * A Service's Requests tab: its Server's read, found from the
   * Service, with the Service filter fixed to it — or `cloud-account` for a
   * Service in a Cloud account. Only an Application or a Compose stack has
   * one. A `GET`, so a Frozen Organization keeps it.
   */
  @Get('requests/services/:serviceId')
  readServiceRequests(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ServiceIdParamsDto,
    @Query() query: ReadServiceRequestsQueryDto,
  ) {
    return this.requests.readService(
      toCtx(user, session),
      params.serviceId,
      query,
    );
  }
}
