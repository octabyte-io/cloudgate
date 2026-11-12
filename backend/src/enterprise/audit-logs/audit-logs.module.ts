import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';

/**
 * Global so any module can record audit entries without importing this one —
 * the trail is cross-cutting, and the auth/organization/user modules that
 * write to it are themselves depended on by half the app.
 *
 * `AuditInterceptor` is registered app-wide from here: it records every other
 * successful mutating request, per `audit-routes.ts`.
 */
@Global()
@Module({
  controllers: [AuditLogController],
  providers: [
    AuditLogService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditLogService],
})
export class AuditLogsModule {}
