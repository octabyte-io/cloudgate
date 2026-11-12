import { Module } from '@nestjs/common';
import { RegistriesController } from './registries.controller';
import { RegistriesService } from './registries.service';

@Module({
  controllers: [RegistriesController],
  providers: [RegistriesService],
  exports: [RegistriesService],
})
export class RegistriesModule {}
