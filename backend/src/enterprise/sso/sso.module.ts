import { Module } from '@nestjs/common';
import { SettingsModule } from '../../settings/settings.module';
import { SsoController } from './sso.controller';
import {
  ProvenDomainsService,
  txtResolverProvider,
} from './proven-domains.service';
import { SsoService } from './sso.service';

/**
 * Enterprise SSO/OIDC: identity providers per organization, and on the Hosted
 * instance the domains they may act for.
 */
@Module({
  imports: [SettingsModule],
  controllers: [SsoController],
  providers: [SsoService, ProvenDomainsService, txtResolverProvider],
  exports: [SsoService],
})
export class SsoModule {}
