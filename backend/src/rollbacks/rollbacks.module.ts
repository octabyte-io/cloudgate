import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { ROLLBACK_RECORDER } from '../deployment-engine/ports/rollback-recorder';
import { RollbacksController } from './rollbacks.controller';
import { RollbacksService } from './rollbacks.service';

/** Feature module copied from the Phase 07 projects template. */
@Module({
  imports: [ApplicationsModule],
  controllers: [RollbacksController],
  providers: [
    RollbacksService,
    // The Phase 24 port the deployment engine captures snapshots through.
    { provide: ROLLBACK_RECORDER, useExisting: RollbacksService },
  ],
  exports: [RollbacksService, ROLLBACK_RECORDER],
})
export class RollbacksModule {}
