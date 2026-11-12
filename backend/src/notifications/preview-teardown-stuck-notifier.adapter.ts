import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type {
  PreviewTeardownStuckNotifier,
  StuckServer,
} from '../preview-deployments/teardown-stuck-episodes';
import { server } from '../servers/server.schema';
import { NotificationDispatcherService } from './dispatcher.service';
import {
  PLATFORM_HOST_NAME,
  PREVIEW_TEARDOWN_STUCK_ADVICE,
} from './events/notification-event';
import type { StuckApplicationSummary } from './events/notification-event';

/**
 * The stuck-teardown notifier over the dispatcher: turns a Server
 * whose episode just opened into the "Preview teardown stuck" event, for the
 * **Server's own Organization** — `DockerCleanupService.runServerCleanup`'s
 * shape, the standing precedent for a per-Server event finding its
 * recipients. The platform host has no Server row, so its event goes to the
 * Organization whose previews are stuck on it, and to no other.
 *
 * Swallows its failures, as `AgentRateLimitNotifierAdapter` does: the episode
 * is already marked, so a delivery problem is logged and never retried into
 * noise. A Server deleted in between is told to nobody.
 */
@Injectable()
export class PreviewTeardownStuckNotifierAdapter implements PreviewTeardownStuckNotifier {
  private readonly logger = new Logger(
    PreviewTeardownStuckNotifierAdapter.name,
  );

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly dispatcher: NotificationDispatcherService,
  ) {}

  async previewTeardownStuck(stuck: StuckServer): Promise<void> {
    try {
      let recipient = stuck.organizationId;
      let serverName = PLATFORM_HOST_NAME;
      if (stuck.serverId !== null) {
        const [row] = await this.db
          .select({ name: server.name, organizationId: server.organizationId })
          .from(server)
          .where(eq(server.serverId, stuck.serverId))
          .limit(1);
        if (!row) return;
        recipient = row.organizationId;
        serverName = row.name;
      }

      await this.dispatcher.dispatch(recipient, {
        type: 'preview-teardown-stuck',
        organizationId: recipient,
        serverId: stuck.serverId,
        serverName,
        stuckCount: stuck.previews.length,
        applications: stuckApplications(stuck),
        stuckSince: stuck.stuckSince.toISOString(),
        message: PREVIEW_TEARDOWN_STUCK_ADVICE,
      });
    } catch (error) {
      this.logger.error(
        `Could not tell the channels that requested-preview teardown is stuck on ${
          stuck.serverId ?? PLATFORM_HOST_NAME
        }`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/** Each Application once, in the order its first stuck preview came. */
function stuckApplications(stuck: StuckServer): StuckApplicationSummary[] {
  const byApplication = new Map<string, StuckApplicationSummary>();
  for (const preview of stuck.previews) {
    const seen = byApplication.get(preview.applicationId);
    if (seen) seen.stuck += 1;
    else {
      byApplication.set(preview.applicationId, {
        name: preview.applicationName,
        stuck: 1,
      });
    }
  }
  return [...byApplication.values()];
}
