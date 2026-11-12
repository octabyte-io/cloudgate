import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { channelRelations, notification } from '../db/schema';
import { NotificationChannelRegistry } from './channels/channel-registry';
import { EVENT_FLAG_COLUMNS } from './events/notification-event';
import type { NotificationEvent } from './events/notification-event';

/**
 * The fan-out core shared by every notification trigger: load the channels
 * whose flag matches the event type (org-scoped, or instance-wide for the
 * org-less instance backup/restart triggers) and push the event through each
 * channel's strategy. A failing channel is logged and never blocks the others
 * (a try/catch per channel).
 */
@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly registry: NotificationChannelRegistry,
  ) {}

  async dispatch(
    organizationId: string | null,
    event: NotificationEvent,
  ): Promise<void> {
    const flag = notification[EVENT_FLAG_COLUMNS[event.type]];
    const rows = await this.db.query.notification.findMany({
      where: organizationId
        ? and(eq(flag, true), eq(notification.organizationId, organizationId))
        : eq(flag, true),
      with: channelRelations,
    });

    for (const row of rows) {
      // Built for the row's own Organization: an instance-wide event
      // fans out to every Organization's channels, and each dials only
      // where its own may (`NotificationChannelRegistry`).
      const strategy = this.registry.get(
        row.notificationType,
        row.organizationId,
      );
      const connection = row[row.notificationType];
      if (!strategy || !connection) continue;
      try {
        await strategy.send(connection as never, event);
      } catch (error) {
        this.logger.error(
          `Failed to deliver ${event.type} notification "${row.name}" (${row.notificationType})`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
