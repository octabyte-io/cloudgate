import { Module } from '@nestjs/common';
import { CdnController } from './cdn.controller';
import { CdnService, dnsResolverProvider } from './cdn.service';

@Module({
  controllers: [CdnController],
  providers: [CdnService, dnsResolverProvider],
  exports: [CdnService],
})
export class CdnModule {}
