import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApplicationsModule } from './applications/applications.module';
import { BucketsModule } from './buckets/buckets.module';
import { CronServicesModule } from './cron-services/cron-services.module';
import { AuthModule } from './auth/auth.module';
import { BuildersModule } from './builders/builders.module';
import { CommonModule } from './common/common.module';
import { validateEnv } from './common/config/env.schema';
import { InstanceModeModule } from './instance-mode/instance-mode.module';
import { ComposeModule } from './compose/compose.module';
import { LibsqlModule } from './databases/libsql/libsql.module';
import { MariadbModule } from './databases/mariadb/mariadb.module';
import { MongoModule } from './databases/mongo/mongo.module';
import { RedisModule } from './databases/redis/redis.module';
import { MysqlModule } from './databases/mysql/mysql.module';
import { PostgresModule } from './databases/postgres/postgres.module';
import { DrizzleModule } from './db/drizzle.module';
import { BackupsModule } from './backups/backups.module';
import { DeploymentEngineModule } from './deployment-engine/deployment-engine.module';
import { CertificatesModule } from './certificates/certificates.module';
import { BillingModule } from './cloud/billing/billing.module';
import { CloudAccountsModule } from './cloud-accounts/cloud-accounts.module';
import { DomainsModule } from './domains/domains.module';
import { PortsModule } from './networking/ports/ports.module';
import { RedirectsModule } from './networking/redirects/redirects.module';
import { SecurityModule } from './networking/security/security.module';
import { DeploymentsModule } from './deployments/deployments.module';
import { DestinationsModule } from './destinations/destinations.module';
import { QueueModule } from './deployment-queue/queue.module';
import { DockerModule } from './docker/docker.module';
import { DockerOpsModule } from './docker-ops/docker-ops.module';
import { EnvironmentsModule } from './environments/environments.module';
import { GitProvidersModule } from './git-providers/git-providers.module';
import { MailModule } from './mail/mail.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { MountsModule } from './mounts/mounts.module';
import { NotificationsModule } from './notifications/notifications.module';
import { VolumeBackupsModule } from './volume-backups/volume-backups.module';
import { CdnModule } from './cdn/cdn.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PatchModule } from './patch/patch.module';
import { PreviewDeploymentsModule } from './preview-deployments/preview-deployments.module';
import { ProjectsModule } from './projects/projects.module';
import { ProjectConfigModule } from './project-config/project-config.module';
import { OutboundModule } from './outbound/outbound.module';
import { RbacModule } from './rbac/rbac.module';
import { AdminModule } from './admin/admin.module';
import { OperatorModule } from './operator/operator.module';
import { BoughtServersModule } from './bought-servers/bought-servers.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SettingsModule } from './settings/settings.module';
import { RegistriesModule } from './registries/registries.module';
import { RemoteModule } from './remote/remote.module';
import { RollbacksModule } from './rollbacks/rollbacks.module';
import { SchedulesModule } from './scheduling/schedules/schedules.module';
import { ServersModule } from './servers/servers.module';
import { StackVmModule } from './stack-vm/stack-vm.module';
import { ServiceHealthModule } from './service-health/service-health.module';
import { SshKeysModule } from './ssh-keys/ssh-keys.module';
import { TagsModule } from './tags/tags.module';
import { TraefikModule } from './traefik/traefik.module';
import { TemplatesModule } from './templates/templates.module';
import { TracesModule } from './traces/traces.module';
import { UsersModule } from './users/users.module';
import { AgentsModule } from './agents/agents.module';
import { McpModule } from './mcp/mcp.module';
import { GatewayModule } from './gateway/gateway.module';
import { TokenSpendModule } from './token-spend/token-spend.module';
import { AiModule } from './ai/ai.module';
import { AuditLogsModule } from './enterprise/audit-logs/audit-logs.module';
import { CustomRolesModule } from './enterprise/custom-roles/custom-roles.module';
import { ForwardAuthModule } from './enterprise/forward-auth/forward-auth.module';
import { LicenseModule } from './enterprise/license/license.module';
import { ScimModule } from './enterprise/scim/scim.module';
import { SsoModule } from './enterprise/sso/sso.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    InstanceModeModule,
    CommonModule,
    DrizzleModule,
    // Before AuthModule: the session hooks record the login/logout trail.
    AuditLogsModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    AgentsModule,
    // Before RbacModule: PermissionService consults the license to resolve
    // custom roles.
    LicenseModule,
    RbacModule,
    OutboundModule,
    // Before ServersModule: creating a server checks the plan's quota. After
    // AuthModule and RbacModule: its FrozenGuard reads the session AuthGuard
    // sets, so it must be registered after theirs.
    BillingModule,
    RemoteModule,
    DockerModule,
    ProjectsModule,
    ProjectConfigModule,
    EnvironmentsModule,
    TagsModule,
    SshKeysModule,
    ServersModule,
    RegistriesModule,
    CloudAccountsModule,
    // How a Stack VM is reached: its tunnel and its SSH connection.
    StackVmModule,
    GitProvidersModule,
    BuildersModule,
    TraefikModule,
    ApplicationsModule,
    DeploymentEngineModule,
    DeploymentsModule,
    DestinationsModule,
    RollbacksModule,
    PreviewDeploymentsModule,
    ServiceHealthModule,
    TracesModule,
    QueueModule,
    PostgresModule,
    BucketsModule,
    MysqlModule,
    MariadbModule,
    MongoModule,
    RedisModule,
    LibsqlModule,
    ComposeModule,
    DomainsModule,
    CertificatesModule,
    RedirectsModule,
    PortsModule,
    SecurityModule,
    MountsModule,
    PatchModule,
    CdnModule,
    NotificationsModule,
    BackupsModule,
    VolumeBackupsModule,
    CronServicesModule,
    SchedulesModule,
    MailModule,
    DockerOpsModule,
    MonitoringModule,
    RealtimeModule,
    SettingsModule,
    AdminModule,
    // The hosted-only Operator page (ADR-0050).
    OperatorModule,
    // Bought Servers, hosted only (ADR-0071).
    BoughtServersModule,
    TemplatesModule,
    AiModule,
    CustomRolesModule,
    ForwardAuthModule,
    ScimModule,
    SsoModule,
    // The MCP endpoint; its tools call the services above (ADR-0025).
    McpModule,
    // The Gateway into AI models; the Agent key's second surface.
    GatewayModule,
    // Token spend: the nightly rollup and prune, and the REST read.
    TokenSpendModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_PIPE, useClass: ZodValidationPipe }],
})
export class AppModule {}
