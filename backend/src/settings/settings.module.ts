import { Module } from '@nestjs/common';
import { DeploymentsModule } from '../deployments/deployments.module';
import { fetchClientProvider } from '../git-providers/fetch.provider';
import { NotificationsModule } from '../notifications/notifications.module';
import { InstanceUrlModule } from './instance-url.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { TraefikModule } from '../traefik/traefik.module';
import { AboutController } from './about.controller';
import { AboutService } from './about.service';
import { CleanupService } from './cleanup.service';
import { ConsoleOriginService } from './console-origin.service';
import { DnsChallengeService } from './dns-challenge.service';
import { DockerCleanupService } from './docker-cleanup.service';
import { DockerResourceService } from './docker-resource.service';
import { GPU_SETUP_PAUSE, GpuService, sleep } from './gpu.service';
import { InfraHealthService } from './infra-health.service';
import { UpdatesService } from './updates.service';
import { LogCleanupService } from './log-cleanup.service';
import { ServerAccessLogUpkeepService } from './server-access-log-upkeep.service';
import { RequestLoggingService } from './request-logging.service';
import { RequestMetricsService } from './request-metrics.service';
import { RuntimeInfoService } from './runtime-info.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import {
  MAIN_TRAEFIK_DIR,
  TraefikFilesService,
  mainTraefikDirectory,
} from './traefik-files.service';
import { TraefikSetupService } from './traefik-setup.service';

@Module({
  imports: [
    TraefikModule,
    SchedulingModule,
    DeploymentsModule,
    NotificationsModule,
    InstanceUrlModule,
  ],
  controllers: [SettingsController, AboutController],
  providers: [
    SettingsService,
    AboutService,
    ConsoleOriginService,
    TraefikFilesService,
    DockerResourceService,
    TraefikSetupService,
    DnsChallengeService,
    LogCleanupService,
    ServerAccessLogUpkeepService,
    CleanupService,
    DockerCleanupService,
    UpdatesService,
    GpuService,
    { provide: GPU_SETUP_PAUSE, useValue: sleep },
    InfraHealthService,
    RuntimeInfoService,
    RequestMetricsService,
    RequestLoggingService,
    fetchClientProvider,
    // The **function**, not its result: a root computed once at module
    // construction cannot answer which machine a Traefik file is on, and every
    // Server-scoped branch of `TraefikFilesService` asks. `useValue` rather
    // than the `useFactory` this was, and for the same reason it was a factory
    // — CLOUDGATE_DIRECTORY reaches process.env with the rest of the validated
    // env, after this module is imported — since providing the function
    // reads the env later still, at each call.
    { provide: MAIN_TRAEFIK_DIR, useValue: mainTraefikDirectory },
  ],
  exports: [
    InstanceUrlModule,
    SettingsService,
    TraefikFilesService,
    DockerResourceService,
    TraefikSetupService,
    LogCleanupService,
    ServerAccessLogUpkeepService,
    CleanupService,
    DockerCleanupService,
    UpdatesService,
    GpuService,
    InfraHealthService,
    RuntimeInfoService,
    RequestMetricsService,
    RequestLoggingService,
  ],
})
export class SettingsModule {}
