import { Module } from '@nestjs/common';
import { TraefikAppConfigService } from './app-config.service';
import { TraefikConfigStatusService } from './config-status.service';
import { TraefikController } from './traefik.controller';
import { TraefikService } from './traefik.service';
import { TraefikWriterService } from './traefik-writer.service';

/**
 * Dynamic Traefik config generation. The generators in ./config are pure
 * functions (object → config); TraefikAppConfigService rebuilds a per-app
 * config from its current rows, and the writer persists it
 * (RemoteExecService comes from the global RemoteModule).
 *
 * TraefikConfigStatusService is the other direction (H-38): after the
 * write it reads what Traefik made of the file, so a config Traefik refuses is
 * reported against the Cloudgate row that caused it instead of being visible
 * only in Traefik's own log. Its controller is here rather than in `settings`
 * because the question is about one Application, not about the instance's
 * Traefik installation.
 */
@Module({
  controllers: [TraefikController],
  providers: [
    TraefikWriterService,
    TraefikAppConfigService,
    TraefikConfigStatusService,
    TraefikService,
  ],
  exports: [
    TraefikWriterService,
    TraefikAppConfigService,
    TraefikConfigStatusService,
  ],
})
export class TraefikModule {}
