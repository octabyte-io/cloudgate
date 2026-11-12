import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * Agents: Members that are not people (ADR-0023). PermissionService and
 * AuditLogService are both `@Global()`, so this imports nothing.
 */
@Module({
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
