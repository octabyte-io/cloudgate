import { Module } from '@nestjs/common';
import { McpAuthenticator } from '../mcp/mcp-authenticator';
import { AiModelNotAnsweringNotifierAdapter } from '../notifications/ai-model-not-answering-notifier.adapter';
import { NotificationsModule } from '../notifications/notifications.module';
import { TRAEFIK_PORT } from '../servers/server-setup';
import { GatewayController } from './gateway.controller';
import { GATEWAY_TRAEFIK_PORT, GatewayService } from './gateway.service';
import {
  AI_MODEL_NOT_ANSWERING_NOTIFIER,
  AiModelNotAnsweringEpisodes,
} from './not-answering-episodes';
import type { AiModelNotAnsweringNotifier } from './not-answering-episodes';

/**
 * The Gateway (the gateway ADR): its route, and the service that
 * authenticates, authorizes, forwards and meters each call.
 *
 * `McpAuthenticator` is provided here rather than imported from `McpModule`,
 * which would bring every module a tool calls: it needs only the database, and
 * an Agent key is the same key at both of its surfaces (ADR-0023).
 * `PermissionService` is `@Global()`.
 *
 * "AI model not answering": one episode tracker for the process, told
 * of each settled call, reaching the channels through the notifier port, as
 * `PreviewDeploymentsModule` binds its stuck-teardown notifier.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [GatewayController],
  providers: [
    GatewayService,
    McpAuthenticator,
    { provide: GATEWAY_TRAEFIK_PORT, useValue: TRAEFIK_PORT },
    {
      provide: AI_MODEL_NOT_ANSWERING_NOTIFIER,
      useExisting: AiModelNotAnsweringNotifierAdapter,
    },
    {
      provide: AiModelNotAnsweringEpisodes,
      inject: [AI_MODEL_NOT_ANSWERING_NOTIFIER],
      useFactory: (notifier: AiModelNotAnsweringNotifier) =>
        new AiModelNotAnsweringEpisodes(notifier),
    },
  ],
})
export class GatewayModule {}
