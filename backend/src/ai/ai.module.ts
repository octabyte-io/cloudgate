import { Module } from '@nestjs/common';
import { ComposeModule } from '../compose/compose.module';
import { DomainsModule } from '../domains/domains.module';
import { fetchClientProvider } from '../git-providers/fetch.provider';
import { MountsModule } from '../mounts/mounts.module';
import { ServersModule } from '../servers/servers.module';
import { SettingsModule } from '../settings/settings.module';
import { addressResolverProvider } from './ai-destination';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { textGeneratorProvider } from './llm.provider';

@Module({
  imports: [
    ComposeModule,
    DomainsModule,
    MountsModule,
    ServersModule,
    SettingsModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    textGeneratorProvider,
    fetchClientProvider,
    // Name resolution is a system boundary like the two above it, and the
    // destination check is the only thing in this module that reaches it.
    addressResolverProvider,
  ],
  exports: [AiService],
})
export class AiModule {}
