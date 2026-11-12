import { Module } from '@nestjs/common';
import { MountsController } from './mounts.controller';
import { MountsService } from './mounts.service';

// Feature module copied from the Phase 07 projects template.
@Module({
  controllers: [MountsController],
  providers: [MountsService],
  exports: [MountsService],
})
export class MountsModule {}
