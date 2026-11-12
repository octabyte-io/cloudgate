import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { apikey, member, organization, user } from '../db/schema';
import type { AgentRateLimited } from '../mcp/rate-bucket';
import { AGENT_RATE_BUDGETS } from '../mcp/rate-bucket';
import type { AgentRateLimitNotifier } from '../mcp/rate-limit-episodes';
import { InstanceUrlService } from '../settings/instance-url.service';
import { NotificationDispatcherService } from './dispatcher.service';
import { AGENT_RATE_LIMITED_ADVICE } from './events/notification-event';

/**
 * The console path of the Agents section and the anchor of one Agent's row
 * on it. A page, never a write: the link opens the row the operator acts from.
 * `test/notifications/agent-row-link.spec.ts` reads both off `frontend/src`.
 */
export const AGENTS_SECTION_PATH = '/settings/agents';
export const agentRowAnchor = (agentUserId: string) => `agent-${agentUserId}`;

/**
 * The loop signal's notifier over the dispatcher: turns an episode's
 * first 429 into the "Agent rate limited" event for the Agent's Organization,
 * filling in what the dispatcher's 429 did not carry — the Agent's and
 * Organization's names and the key's prefix — from the rows.
 *
 * Swallows its failures, as `LicenseLapseService.notifyChannels` does: the 429
 * has gone out and the episode is marked, so a delivery problem is logged and
 * never retried into noise. An Agent deleted in between is told to nobody.
 */
@Injectable()
export class AgentRateLimitNotifierAdapter implements AgentRateLimitNotifier {
  private readonly logger = new Logger(AgentRateLimitNotifierAdapter.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly instanceUrl: InstanceUrlService,
  ) {}

  async agentRateLimited(event: AgentRateLimited): Promise<void> {
    try {
      const [agent] = await this.db
        .select({ name: user.firstName, organizationName: organization.name })
        .from(user)
        .innerJoin(member, eq(member.userId, user.id))
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(
          and(
            eq(user.id, event.agentUserId),
            eq(member.organizationId, event.organizationId),
          ),
        )
        .limit(1);
      if (!agent) return;

      const [key] = await this.db
        .select({ start: apikey.start })
        .from(apikey)
        .where(eq(apikey.id, event.keyId))
        .limit(1);
      const url = await this.instanceUrl.getInstanceUrl();
      const { perMinute, burst } = AGENT_RATE_BUDGETS[event.budget];

      await this.dispatcher.dispatch(event.organizationId, {
        type: 'agent-rate-limited',
        organizationId: event.organizationId,
        organizationName: agent.organizationName,
        agentName: agent.name,
        budget: { kind: event.budget, perMinute, burst },
        keyPrefix: key?.start ?? null,
        ...(url && {
          agentLink: `${url}${AGENTS_SECTION_PATH}#${agentRowAnchor(event.agentUserId)}`,
        }),
        message: AGENT_RATE_LIMITED_ADVICE,
      });
    } catch (error) {
      this.logger.error(
        `Could not notify the channels of organization ${event.organizationId} that Agent ${event.agentUserId} is rate limited`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
