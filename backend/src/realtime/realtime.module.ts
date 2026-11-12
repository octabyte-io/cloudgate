import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { DockerModule } from '../docker/docker.module';
import { RemoteModule } from '../remote/remote.module';
import { ServersModule } from '../servers/servers.module';
import { LocalProcessChannelService } from './channels/local-process-channel.service';
import { PtyChannelService } from './channels/pty-channel.service';
import { SshChannelService } from './channels/ssh-channel.service';
import { ContainerAccessService } from './container-access.service';
import { ContainerLogsGateway } from './gateways/container-logs.gateway';
import { ContainerTerminalGateway } from './gateways/container-terminal.gateway';
import { DeploymentLogsGateway } from './gateways/deployment-logs.gateway';
import { DockerStatsGateway } from './gateways/docker-stats.gateway';
import { ServerSetupGateway } from './gateways/server-setup.gateway';
import { ServerTerminalGateway } from './gateways/server-terminal.gateway';
import { HostStatsService } from './host-stats.service';
import { LegacyStatsSeriesPurge } from './legacy-stats-series';
import { LocalServerSetupService } from './local-server-setup.service';
import {
  LEASE_RENEWAL_INTERVAL,
  LEASE_RENEWAL_INTERVAL_MS,
} from './socket-access';
import { WsAuthGuard } from './ws-auth.guard';

/**
 * Real-time streaming over WebSockets: container logs, container terminal,
 * live docker stats, deployment logs and the server SSH terminal — plus the
 * server setup run.
 */
@Module({
  imports: [
    AuthModule,
    ServersModule,
    RemoteModule,
    DockerModule,
    // ADR-0007: /listen-deployment resolves its log file and build server
    // from the deployment row it is addressed by.
    DeploymentsModule,
  ],
  providers: [
    // How often an open socket re-runs its own authorization (ADR-0012). A
    // token rather than a constant read at the call site so a test module can
    // shorten it; nothing reads `process.env`, so weakening it on a real
    // install still means editing source and rebuilding.
    { provide: LEASE_RENEWAL_INTERVAL, useValue: LEASE_RENEWAL_INTERVAL_MS },
    WsAuthGuard,
    ContainerAccessService,
    SshChannelService,
    PtyChannelService,
    LocalProcessChannelService,
    // Removes the series directories the live stream wrote in older versions.
    LegacyStatsSeriesPurge,
    HostStatsService,
    LocalServerSetupService,
    ContainerLogsGateway,
    DeploymentLogsGateway,
    DockerStatsGateway,
    ContainerTerminalGateway,
    ServerTerminalGateway,
    ServerSetupGateway,
  ],
  // ContainerAccessService is exported: the HTTP surface that
  // lists container ids and acts on them has to ask the same question the
  // sockets ask, and a second copy of the resolver in docker-ops is how the
  // listing and the acting came to disagree.
  exports: [WsAuthGuard, ContainerAccessService],
})
export class RealtimeModule {}
