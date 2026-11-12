import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { ComposeModule } from '../compose/compose.module';
import { GitProvidersModule } from '../git-providers/git-providers.module';
import { ServersModule } from '../servers/servers.module';
import { PatchRepoService } from './patch-repo.service';
import { PatchController } from './patch.controller';
import { PatchService } from './patch.service';

@Module({
  imports: [
    ApplicationsModule,
    ComposeModule,
    GitProvidersModule,
    ServersModule,
  ],
  controllers: [PatchController],
  providers: [PatchService, PatchRepoService],
  exports: [PatchService, PatchRepoService],
})
export class PatchModule {}
