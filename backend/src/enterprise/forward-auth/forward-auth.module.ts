import { Module } from '@nestjs/common';
import { DomainsModule } from '../../domains/domains.module';
import { TraefikModule } from '../../traefik/traefik.module';
import { ForwardAuthController } from './forward-auth.controller';
import { ForwardAuthProxyService } from './forward-auth-proxy.service';
import { ForwardAuthService } from './forward-auth.service';

/**
 * Forward-auth SSO gateway: the per-server auth domain, the oauth2-proxy that
 * answers on it, and the per-domain Traefik gate that sends requests through it.
 */
@Module({
  imports: [TraefikModule, DomainsModule],
  controllers: [ForwardAuthController],
  providers: [ForwardAuthService, ForwardAuthProxyService],
  exports: [ForwardAuthService],
})
export class ForwardAuthModule {}
