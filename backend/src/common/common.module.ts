import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { EncryptionService } from './encryption/encryption.service';
import { OwnerOnlyTreesService } from './files/owner-only-trees.service';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { loggerConfig } from './logging/logger.config';

@Global()
@Module({
  imports: [LoggerModule.forRoot(loggerConfig)],
  providers: [
    EncryptionService,
    OwnerOnlyTreesService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [EncryptionService, LoggerModule],
})
export class CommonModule {}
