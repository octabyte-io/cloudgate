import { Module } from '@nestjs/common';
import { TraefikModule } from '../traefik/traefik.module';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import {
  ServedCertificateService,
  servedCertificateReaderProvider,
} from './served-certificate.service';

// Feature module copied from the Phase 07 projects template.
@Module({
  imports: [TraefikModule],
  controllers: [DomainsController],
  providers: [
    DomainsService,
    ServedCertificateService,
    servedCertificateReaderProvider,
  ],
  exports: [DomainsService],
})
export class DomainsModule {}
