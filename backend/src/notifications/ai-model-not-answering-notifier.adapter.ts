import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { aiModelFacet } from '../ai-models/ai-model.schema';
import { application } from '../applications/application.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment } from '../environments/environment.schema';
import type {
  AiModelNotAnsweringNotifier,
  NotAnswering,
} from '../gateway/not-answering-episodes';
import { project } from '../projects/project.schema';
import { server } from '../servers/server.schema';
import { InstanceUrlService } from '../settings/instance-url.service';
import { NotificationDispatcherService } from './dispatcher.service';
import {
  AI_MODEL_NOT_ANSWERING_ADVICE,
  PLATFORM_HOST_NAME,
} from './events/notification-event';

/** The console path of an AI model's Model tab. A page, never a write. */
export const aiModelTabPath = (applicationId: string): string =>
  `/applications/${applicationId}/model`;

/**
 * The "AI model not answering" notifier over the dispatcher: turns an
 * AI model whose episode just opened into the event for the AI model's own
 * Organization, filling in its names, its model and the machine it runs on
 * from the rows.
 *
 * Swallows its failures, as `AgentRateLimitNotifierAdapter` does: the episode
 * is already marked, so a delivery problem is logged and never retried into
 * noise. An AI model deleted in between is told to nobody.
 */
@Injectable()
export class AiModelNotAnsweringNotifierAdapter implements AiModelNotAnsweringNotifier {
  private readonly logger = new Logger(AiModelNotAnsweringNotifierAdapter.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly instanceUrl: InstanceUrlService,
  ) {}

  async aiModelNotAnswering(episode: NotAnswering): Promise<void> {
    try {
      const [row] = await this.db
        .select({
          aiModelName: application.name,
          model: aiModelFacet.model,
          environmentName: environment.name,
          projectName: project.name,
          organizationId: project.organizationId,
          serverName: server.name,
        })
        .from(application)
        .innerJoin(
          aiModelFacet,
          eq(aiModelFacet.applicationId, application.applicationId),
        )
        .innerJoin(
          environment,
          eq(environment.environmentId, application.environmentId),
        )
        .innerJoin(project, eq(project.projectId, environment.projectId))
        .leftJoin(server, eq(server.serverId, application.serverId))
        .where(eq(application.applicationId, episode.applicationId))
        .limit(1);
      if (!row) return;
      const url = await this.instanceUrl.getInstanceUrl();

      await this.dispatcher.dispatch(row.organizationId, {
        type: 'ai-model-not-answering',
        organizationId: row.organizationId,
        aiModelName: row.aiModelName,
        projectName: row.projectName,
        environmentName: row.environmentName,
        model: row.model,
        serverName: row.serverName ?? PLATFORM_HOST_NAME,
        failedAt: episode.failedAt.toISOString(),
        ...(url && {
          aiModelLink: `${url}${aiModelTabPath(episode.applicationId)}`,
        }),
        message: AI_MODEL_NOT_ANSWERING_ADVICE,
      });
    } catch (error) {
      this.logger.error(
        `Could not tell the channels that AI model ${episode.applicationId} is not answering`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
