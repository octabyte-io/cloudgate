import { Module } from '@nestjs/common';
import { TraefikModule } from '../traefik/traefik.module';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

// Feature module copied from the Phase 07 projects template.
@Module({
  imports: [TraefikModule],
  controllers: [CertificatesController],
  providers: [CertificatesService],
  exports: [CertificatesService],
})
export class CertificatesModule {}
