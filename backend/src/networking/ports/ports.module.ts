import { Module } from '@nestjs/common';
import { PortsController } from './ports.controller';
import { PortsService } from './ports.service';

// Feature module copied from the Phase 07 projects template.
@Module({
  controllers: [PortsController],
  providers: [PortsService],
  exports: [PortsService],
})
export class PortsModule {}
