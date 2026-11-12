import { Module } from '@nestjs/common';
import { TraefikModule } from '../../traefik/traefik.module';
import { RedirectsController } from './redirects.controller';
import { RedirectsService } from './redirects.service';

// Feature module copied from the Phase 07 projects template.
@Module({
  imports: [TraefikModule],
  controllers: [RedirectsController],
  providers: [RedirectsService],
  exports: [RedirectsService],
})
export class RedirectsModule {}
