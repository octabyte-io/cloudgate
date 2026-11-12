import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { addressResolverProvider } from '../outbound/outbound-address';
import { ServerAddressGuard } from '../servers/server-address-guard';
import { InstanceUrlModule } from '../settings/instance-url.module';
import { ErrorRateService } from './error-rate.service';
import { ErrorRateThresholdsController } from './error-rate-thresholds.controller';
import { ErrorRateThresholdsService } from './error-rate-thresholds.service';
import { IncidentsService } from './incidents.service';
import { ProbeScheduler } from './probe-scheduler.service';
import { directProbeTarget, PROBE_TARGET } from './probe-target.port';
import { RequestMetricsCollector } from './request-metrics-collector.service';
import { requestMetricsStateProvider } from './request-metrics-state.port';
import {
  SERVICE_HEALTH_CLOCK,
  systemServiceHealthClock,
} from './service-health.clock';
import { ServiceHealthController } from './service-health.controller';
import { ServiceHealthService } from './service-health.service';
import { UptimeChecksController } from './uptime-checks.controller';
import { UptimeChecksService } from './uptime-checks.service';

/**
 * Service health: Uptime checks (HTTP, TCP, keyword, header), their Probes and
 * Incidents, the `service-incident` Notification, the Error rate and the
 * Error-rate threshold. The batched Environment
 * read lives here but is provided by `EnvironmentsModule`.
 *
 * `ServiceHealthService` is exported for the MCP reads:
 * `get_service_health` is its `forAgent` and `get_service`'s open Incidents
 * its `openIncidents`, both under the summary's own gate. No MCP tool reaches
 * a check's or a threshold's write.
 *
 * **It imports no Service module**, so the Service modules can import it for
 * the Stop hook (`IncidentsService.closeForService`) without a cycle: it reads
 * Service rows through the schema, never through a Service's own service.
 *
 * The Error rate (ADR-0027) is `RequestMetricsCollector` writing
 * samples and `ErrorRateService` reading them; each collection is judged
 * against the Error-rate thresholds (`ErrorRateThresholdsService`).
 *
 * `PROBE_TARGET` and `SERVICE_HEALTH_CLOCK` are providers only so a suite can
 * replace them (the probe-target stub and a clock that stands still); the
 * product binds the identity and the system clock.
 */
@Module({
  imports: [NotificationsModule, InstanceUrlModule, SchedulingModule],
  controllers: [
    UptimeChecksController,
    ErrorRateThresholdsController,
    ServiceHealthController,
  ],
  providers: [
    IncidentsService,
    UptimeChecksService,
    ServiceHealthService,
    ProbeScheduler,
    ErrorRateService,
    ErrorRateThresholdsService,
    RequestMetricsCollector,
    requestMetricsStateProvider,
    { provide: PROBE_TARGET, useValue: directProbeTarget },
    { provide: SERVICE_HEALTH_CLOCK, useValue: systemServiceHealthClock },
    // The TCP Probe checks its Server's address as an SSH connect does. Provided
    // here rather than by importing `ServersModule`, for the no-Service-module
    // rule above; it reads only the mode, names and the settings row.
    ServerAddressGuard,
    addressResolverProvider,
  ],
  exports: [IncidentsService, ErrorRateService, ServiceHealthService],
})
export class ServiceHealthModule {}
