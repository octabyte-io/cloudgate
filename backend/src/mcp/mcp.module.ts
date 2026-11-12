import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { ComposeModule } from '../compose/compose.module';
import { LibsqlModule } from '../databases/libsql/libsql.module';
import { MariadbModule } from '../databases/mariadb/mariadb.module';
import { MongoModule } from '../databases/mongo/mongo.module';
import { MysqlModule } from '../databases/mysql/mysql.module';
import { PostgresModule } from '../databases/postgres/postgres.module';
import { RedisModule } from '../databases/redis/redis.module';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { DomainsModule } from '../domains/domains.module';
import { lastRateLimited } from '../enterprise/audit-logs/rate-limit-refusals';
import { EnvironmentsModule } from '../environments/environments.module';
import { AgentRateLimitNotifierAdapter } from '../notifications/agent-rate-limit-notifier.adapter';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProjectConfigModule } from '../project-config';
import { PreviewDeploymentsModule } from '../preview-deployments/preview-deployments.module';
import { ProjectsModule } from '../projects/projects.module';
import { ServiceHealthModule } from '../service-health/service-health.module';
import { McpAuthenticator } from './mcp-authenticator';
import { McpController } from './mcp.controller';
import { McpDispatcher } from './mcp-dispatcher';
import {
  InMemoryAgentRateBucket,
  MCP_RATE_BUCKET,
  MCP_RATE_BUCKET_CLOCK,
  MCP_RATE_LIMIT_LISTENER,
  systemRateBucketClock,
} from './rate-bucket';
import type { RateBucketClock } from './rate-bucket';
import {
  EPISODE_CLOCK,
  RateLimitEpisodeTracker,
  systemEpisodeClock,
} from './rate-limit-episodes';
import type { EpisodeClock, RateLimitHistory } from './rate-limit-episodes';
import { SecretMask } from './secret-mask';
import { ToolRegistry } from './tool-registry';
import { MCP_TOOLS } from './tools';

/**
 * The MCP endpoint (ADR-0025): a route group inside the Nest process,
 * because every tool calls a service method with a `PermissionCtx` and every
 * call writes an audit row in-process (ADR-0023).
 *
 * `imports` names each module whose service a tool calls — `ToolDefinition`'s
 * `target.service` is resolved from them. PermissionService and
 * AuditLogService are `@Global()`.
 *
 * `ToolRegistry` is built here from `MCP_TOOLS`, so a malformed tool fails the
 * boot. `MCP_RATE_BUCKET` is the per-Agent bucket, on a clock a test
 * replaces. `MCP_RATE_LIMIT_LISTENER` is the loop signal's episode tracker,
 * reading the audit trail once per Agent after a restart and raising
 * the "Agent rate limited" Notification through NotificationsModule's adapter.
 */
@Module({
  imports: [
    ProjectsModule,
    EnvironmentsModule,
    ApplicationsModule,
    ComposeModule,
    PostgresModule,
    MysqlModule,
    MariadbModule,
    MongoModule,
    RedisModule,
    LibsqlModule,
    DeploymentsModule,
    DomainsModule,
    NotificationsModule,
    // The Requested-preview tools.
    PreviewDeploymentsModule,
    // get_service_health and get_service's open Incidents.
    ServiceHealthModule,
    // get_project_config, get_plan and request_plan.
    ProjectConfigModule,
  ],
  controllers: [McpController],
  providers: [
    McpDispatcher,
    McpAuthenticator,
    SecretMask,
    { provide: ToolRegistry, useFactory: () => new ToolRegistry(MCP_TOOLS) },
    { provide: MCP_RATE_BUCKET_CLOCK, useValue: systemRateBucketClock },
    {
      provide: MCP_RATE_BUCKET,
      useFactory: (clock: RateBucketClock) =>
        new InMemoryAgentRateBucket(clock),
      inject: [MCP_RATE_BUCKET_CLOCK],
    },
    { provide: EPISODE_CLOCK, useValue: systemEpisodeClock },
    {
      provide: MCP_RATE_LIMIT_LISTENER,
      useFactory: (
        db: DrizzleDB,
        notifier: AgentRateLimitNotifierAdapter,
        clock: EpisodeClock,
      ) => {
        const history: RateLimitHistory = {
          lastRateLimited: (agentUserId, since, before) =>
            lastRateLimited(db, agentUserId, since, before),
        };
        return new RateLimitEpisodeTracker(history, notifier, clock);
      },
      inject: [DRIZZLE, AgentRateLimitNotifierAdapter, EPISODE_CLOCK],
    },
  ],
})
export class McpModule {}
