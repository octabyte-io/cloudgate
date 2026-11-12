import { Module } from '@nestjs/common';
import { TraefikModule } from '../../traefik/traefik.module';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';

// Feature module copied from the Phase 07 projects template.
@Module({
  imports: [TraefikModule],
  controllers: [SecurityController],
  providers: [SecurityService],
  exports: [SecurityService],
})
export class SecurityModule {}
