import { Module } from '@nestjs/common';
import { TraefikModule } from '../traefik/traefik.module';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';

// Feature module copied from the Phase 07 projects template.
@Module({
  imports: [TraefikModule],
  controllers: [DomainsController],
  providers: [DomainsService],
  exports: [DomainsService],
})
export class DomainsModule {}
