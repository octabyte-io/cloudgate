import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { ClusterController } from './cluster.controller';
import { ClusterService } from './cluster.service';
import { DockerOpsController } from './docker-ops.controller';
import { DockerOpsService } from './docker-ops.service';
import { SwarmController } from './swarm.controller';
import { SwarmService } from './swarm.service';

/**
 * Phase 40 — operational Docker/Swarm/Cluster endpoints.
 */
@Module({
  // RealtimeModule for its ContainerAccessService: the container-addressed
  // routes are authorized against the Service that owns the container, the same
  // gate ADR-0008 put on the sockets, rather than a second resolver that could
  // drift from it.
  imports: [RealtimeModule],
  controllers: [DockerOpsController, SwarmController, ClusterController],
  providers: [DockerOpsService, SwarmService, ClusterService],
  exports: [DockerOpsService, SwarmService, ClusterService],
})
export class DockerOpsModule {}
