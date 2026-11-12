import { Inject, Injectable } from '@nestjs/common';
import { FETCH_CLIENT } from '../../git-providers/fetch.provider';
import type { FetchClient } from '../../git-providers/fetch.provider';
import { formatEventTime } from '../events/event-time';
import {
  AGENT_RATE_LIMITED_TITLE,
  PREVIEW_TEARDOWN_STUCK_TITLE,
  previewTeardownStuckFacts,
  serverThresholdTitle,
  serviceIncidentFacts,
  serviceIncidentTitle,
  AI_MODEL_NOT_ANSWERING_TITLE,
  aiModelNotAnsweringFacts,
} from '../events/notification-event';
import { channelFailure } from './channel-failure';
import { TEST_MESSAGE, TEST_TITLE } from './channel.strategy';
import type { ChannelEvent } from './channel.strategy';
import type { NotificationChannelStrategy } from './channel.strategy';

/** A custom webhook connection's fields. */
export interface CustomChannelConnection {
  endpoint: string;
  headers?: Record<string, string> | null;
}

/**
 * POSTs one JSON payload per event to the operator's endpoint, with the
 * connection's headers.
 *
 * **No payload cap, and there is provably nothing to source.** The
 * receiver is operator-supplied — an arbitrary URL in `connection.endpoint`
 * with arbitrary headers — so there is no provider, no provider documentation
 * and therefore no limit that could be fetched: whatever body limit is in
 * force is the operator's own, and only they can know it. Of the nine channels
 * whose limits were sourced, this is the one where "no cap" is not an empty
 * search but the right answer, and it is written down so the next reader does
 * not repeat the search to find that out.
 *
 * It is also the channel where a cap would do the most damage. The payload is
 * structured JSON for a machine, so a truncated field is not a shorter string
 * but a wrong value: an `errorMessage` a consumer pattern-matches on, or a
 * `date` or `backupSize` a consumer parses. A receiver that needs a bound
 * enforces it at its own edge, where it knows what each field means.
 */
@Injectable()
export class CustomChannelStrategy implements NotificationChannelStrategy<CustomChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: CustomChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const payload = this.format(event);
    if (!payload) return;

    try {
      const response = await this.fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(connection.headers || {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw channelFailure('custom', response.statusText);
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('custom', err);
    }
  }

  private format(event: ChannelEvent): Record<string, unknown> | null {
    const date = new Date();
    switch (event.type) {
      case 'test':
        return {
          title: TEST_TITLE,
          message: TEST_MESSAGE,
          timestamp: date.toISOString(),
        };
      case 'app-deploy':
        return {
          title: 'Build Success',
          message: 'Build completed successfully',
          projectName: event.projectName,
          applicationName: event.applicationName,
          applicationType: event.applicationType,
          buildLink: event.buildLink,
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          domains: (event.domains ?? [])
            .map((domain) => domain.host)
            .join(', '),
          status: 'success',
          type: 'build',
        };
      case 'app-build-error':
        return {
          title: 'Build Error',
          message: 'Build failed with errors',
          projectName: event.projectName,
          applicationName: event.applicationName,
          applicationType: event.applicationType,
          errorMessage: event.errorMessage,
          buildLink: event.buildLink,
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: 'error',
          type: 'build',
        };
      case 'database-backup':
        return {
          title: `Database Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          message:
            event.status === 'success'
              ? 'Database backup completed successfully'
              : 'Database backup failed',
          projectName: event.projectName,
          applicationName: event.applicationName,
          databaseType: event.databaseType,
          databaseName: event.databaseName,
          type: event.status,
          errorMessage: event.errorMessage || '',
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: event.status,
        };
      case 'volume-backup':
        return {
          title: `Volume Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          message:
            event.status === 'success'
              ? 'Volume backup completed successfully'
              : 'Volume backup failed',
          projectName: event.projectName,
          applicationName: event.applicationName,
          volumeName: event.volumeName,
          serviceType: event.serviceType,
          type: event.status,
          errorMessage: event.errorMessage ?? '',
          backupSize: event.backupSize ?? '',
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: event.status,
        };
      case 'docker-cleanup':
        return {
          title: 'Docker Cleanup',
          message: 'Docker cleanup completed successfully',
          cleanupMessage: event.message,
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: 'success',
          type: 'docker-cleanup',
        };
      case 'server-threshold':
        // The sample's own time, not this message's: an alert dispatched late
        // still says when the value was read.
        return {
          title: serverThresholdTitle(event),
          message: event.message,
          serverName: event.serverName,
          type: event.metric,
          currentValue: event.value,
          threshold: event.threshold,
          timestamp: event.timestamp,
          date: formatEventTime(event.timestamp),
          // A close's status is its reason; the opening stays `alert`.
          status: event.close?.reason ?? 'alert',
          alertType: 'server-threshold',
          ...(event.close ? { breachedSince: event.close.breachedSince } : {}),
        };
      case 'instance-backup':
        return {
          title: `Cloudgate Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          message: `Cloudgate instance backup ${event.status === 'success' ? 'completed successfully' : 'failed'}`,
          backupType: 'Complete Cloudgate Instance',
          ...(event.backupSize ? { backupSize: event.backupSize } : {}),
          ...(event.status === 'error' && event.errorMessage
            ? { errorMessage: event.errorMessage }
            : {}),
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: event.status,
          type: 'instance-backup',
        };
      case 'license-lapse':
        // The one machine-facing channel, so the members stay structured here
        // rather than rendered into a line — a webhook consumer wants to act on
        // the addresses, not parse them back out of prose.
        return {
          title: 'Enterprise License Lapsed',
          message: event.message,
          organizationId: event.organizationId,
          organizationName: event.organizationName,
          validUntil: event.validUntil,
          stopped: event.stopped,
          strandedMembers: event.strandedMembers,
          strandedMemberCount: event.strandedMembers.length,
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: 'alert',
          type: 'license-lapse',
        };
      case 'license-expiring':
        // Structured, like the lapse: a webhook consumer acts on the fields.
        return {
          title: 'Enterprise License Expiring',
          message: event.message,
          organizationId: event.organizationId,
          organizationName: event.organizationName,
          validUntil: event.validUntil,
          daysLeft: event.daysLeft,
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: 'alert',
          type: 'license-expiring',
        };
      case 'instance-restart':
        return {
          title: 'Cloudgate Server Restarted',
          message: 'Cloudgate server has been restarted successfully',
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: 'success',
          type: 'instance-restart',
        };
      case 'preview-teardown-stuck':
        // Structured, like the lapse: a webhook consumer acts on the fields,
        // and `summary` is the line a person reads.
        return {
          title: PREVIEW_TEARDOWN_STUCK_TITLE,
          message: event.message,
          summary: previewTeardownStuckFacts(event)
            .map(({ label, value }) => `${label}: ${value}`)
            .join('; '),
          organizationId: event.organizationId,
          serverId: event.serverId,
          serverName: event.serverName,
          stuckCount: event.stuckCount,
          applications: event.applications,
          stuckSince: event.stuckSince,
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: 'alert',
          type: 'preview-teardown-stuck',
        };
      case 'service-incident':
        // Structured, like the lapse: a webhook consumer acts on the fields,
        // and `summary` is the line a person reads.
        return {
          title: serviceIncidentTitle(event),
          summary: serviceIncidentFacts(event)
            .map(({ label, value }) => `${label}: ${value}`)
            .join('; '),
          organizationId: event.organizationId,
          state: event.state,
          source: event.source,
          serviceName: event.serviceName,
          projectName: event.projectName,
          environmentName: event.environmentName,
          target: event.target,
          openingError: event.openingError,
          ...(event.worstRate ? { worstRate: event.worstRate } : {}),
          openedAt: event.openedAt,
          ...(event.closedAt ? { closedAt: event.closedAt } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
          ...(event.serviceLink ? { serviceLink: event.serviceLink } : {}),
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: event.state === 'opened' ? 'alert' : 'success',
          type: 'service-incident',
        };
      case 'ai-model-not-answering':
        // Structured, like the lapse: a webhook consumer acts on the fields,
        // and `summary` is the line a person reads.
        return {
          title: AI_MODEL_NOT_ANSWERING_TITLE,
          message: event.message,
          summary: aiModelNotAnsweringFacts(event)
            .map(({ label, value }) => `${label}: ${value}`)
            .join('; '),
          organizationId: event.organizationId,
          aiModelName: event.aiModelName,
          projectName: event.projectName,
          environmentName: event.environmentName,
          model: event.model,
          serverName: event.serverName,
          failedAt: event.failedAt,
          ...(event.aiModelLink ? { aiModelLink: event.aiModelLink } : {}),
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: 'alert',
          type: 'ai-model-not-answering',
        };
      case 'agent-rate-limited':
        // Structured, like the lapse: a webhook consumer acts on the fields.
        return {
          title: AGENT_RATE_LIMITED_TITLE,
          message: event.message,
          organizationId: event.organizationId,
          organizationName: event.organizationName,
          agentName: event.agentName,
          budget: event.budget,
          keyPrefix: event.keyPrefix,
          ...(event.agentLink ? { agentLink: event.agentLink } : {}),
          timestamp: date.toISOString(),
          date: formatEventTime(date),
          status: 'alert',
          type: 'agent-rate-limited',
        };
      default:
        return null;
    }
  }
}
