import { Inject, Injectable } from '@nestjs/common';
import { FETCH_CLIENT } from '../../git-providers/fetch.provider';
import type { FetchClient } from '../../git-providers/fetch.provider';
import { formatEventTime } from '../events/event-time';
import {
  AGENT_RATE_LIMITED_TITLE,
  AGENT_ROW_LINK_LABEL,
  agentRateLimitedFacts,
  describeServerThreshold,
  describeStrandedMember,
  PREVIEW_TEARDOWN_STUCK_TITLE,
  previewTeardownStuckFacts,
  serverThresholdCloseFacts,
  serverThresholdTitle,
  SERVICE_HEALTH_LINK_LABEL,
  serviceIncidentFacts,
  serviceIncidentTitle,
  AI_MODEL_LINK_LABEL,
  AI_MODEL_NOT_ANSWERING_TITLE,
  aiModelNotAnsweringFacts,
} from '../events/notification-event';
import { capMessage } from './cap-message';
import { channelFailure } from './channel-failure';
import { TEST_MESSAGE, TEST_TITLE } from './channel.strategy';
import type { ChannelEvent } from './channel.strategy';
import type { NotificationChannelStrategy } from './channel.strategy';
import { escapeMarkdown } from './escape-markup';

/** A teams connection's fields. */
export interface TeamsChannelConnection {
  webhookUrl: string;
}

/** What `format` produces and `send` lays out as an adaptive card. */
interface TeamsMessage {
  title: string;
  facts?: { name: string; value: string }[];
  potentialAction?: { type: 'Action.OpenUrl'; title: string; url: string };
}

/**
 * Posts one adaptive card per event to the teams webhook: the title, a
 * FactSet of label/value facts, and an optional open-URL action.
 */
@Injectable()
export class TeamsChannelStrategy implements NotificationChannelStrategy<TeamsChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: TeamsChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const message = this.format(event);
    if (!message) return;
    try {
      const bodyElements: Record<string, unknown>[] = [
        {
          type: 'TextBlock',
          text: message.title,
          size: 'Medium',
          weight: 'Bolder',
          wrap: true,
        },
      ];
      if (message.facts && message.facts.length > 0) {
        bodyElements.push({
          type: 'FactSet',
          facts: message.facts.map((fact) => ({
            title: fact.name,
            value: fact.value,
          })),
        });
      }

      const cardContent: Record<string, unknown> = {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4',
        body: bodyElements,
      };
      if (message.potentialAction) {
        cardContent.actions = [
          {
            type: 'Action.OpenUrl',
            title: message.potentialAction.title,
            url: message.potentialAction.url,
          },
        ];
      }

      const response = await this.fetch(connection.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: cardContent,
            },
          ],
        }),
      });
      if (!response.ok) throw channelFailure('teams', response.statusText);
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('teams', err);
    }
  }

  private format(event: ChannelEvent): TeamsMessage | null {
    const date = new Date();
    switch (event.type) {
      case 'test':
        return {
          title: `🤚 ${TEST_TITLE}`,
          facts: [{ name: 'Message', value: TEST_MESSAGE }],
        };
      case 'app-deploy':
        return {
          title: '✅ Build Success',
          facts: [
            { name: 'Project', value: event.projectName },
            { name: 'Application', value: event.applicationName },
            { name: 'Environment', value: event.environmentName },
            { name: 'Type', value: event.applicationType },
            { name: 'Date', value: formatEventTime(date) },
          ],
          ...(event.buildLink && {
            potentialAction: {
              type: 'Action.OpenUrl' as const,
              title: 'View Build Details',
              url: event.buildLink,
            },
          }),
        };
      case 'app-build-error':
        return {
          title: '⚠️ Build Failed',
          facts: [
            { name: 'Project', value: event.projectName },
            { name: 'Application', value: event.applicationName },
            { name: 'Type', value: event.applicationType },
            { name: 'Date', value: formatEventTime(date) },
            {
              name: 'Error Message',
              value: capMessage(event.errorMessage, 800),
            },
          ],
          ...(event.buildLink && {
            potentialAction: {
              type: 'Action.OpenUrl' as const,
              title: 'View Build Details',
              url: event.buildLink,
            },
          }),
        };
      case 'database-backup': {
        const success = event.status === 'success';
        const facts = [
          { name: 'Project', value: event.projectName },
          { name: 'Application', value: event.applicationName },
          { name: 'Database Type', value: event.databaseType },
          { name: 'Database Name', value: event.databaseName },
          { name: 'Date', value: formatEventTime(date) },
          { name: 'Status', value: success ? 'Successful' : 'Failed' },
        ];
        if (event.status === 'error' && event.errorMessage) {
          facts.push({
            name: 'Error',
            value: capMessage(event.errorMessage, 500),
          });
        }
        return {
          title: success
            ? '✅ Database Backup Successful'
            : '❌ Database Backup Failed',
          facts,
        };
      }
      case 'volume-backup': {
        const success = event.status === 'success';
        const facts = [
          { name: 'Project', value: event.projectName },
          { name: 'Application', value: event.applicationName },
          { name: 'Volume Name', value: event.volumeName },
          { name: 'Service Type', value: event.serviceType },
          { name: 'Date', value: formatEventTime(date) },
          { name: 'Status', value: success ? 'Successful' : 'Failed' },
        ];
        if (event.backupSize) {
          facts.push({ name: 'Backup Size', value: event.backupSize });
        }
        if (event.status === 'error' && event.errorMessage) {
          facts.push({
            name: 'Error',
            value: capMessage(event.errorMessage, 500),
          });
        }
        return {
          title: success
            ? '✅ Volume Backup Successful'
            : '❌ Volume Backup Failed',
          facts,
        };
      }
      case 'docker-cleanup':
        return {
          title: '✅ Docker Cleanup',
          facts: [
            { name: 'Date', value: formatEventTime(date) },
            { name: 'Message', value: event.message },
          ],
        };
      case 'server-threshold': {
        const eventDate = new Date(event.timestamp);
        return {
          title: `${event.close ? '✅' : '⚠️'} ${serverThresholdTitle(event)}`,
          facts: [
            { name: 'Server Name', value: event.serverName },
            { name: 'Type', value: event.metric },
            { name: 'Current Value', value: `${event.value.toFixed(2)}%` },
            { name: 'Threshold', value: describeServerThreshold(event) },
            { name: 'Time', value: formatEventTime(eventDate) },
            { name: 'Message', value: event.message },
            ...serverThresholdCloseFacts(event).map(({ label, value }) => ({
              name: label,
              value,
            })),
          ],
        };
      }
      case 'instance-backup': {
        const success = event.status === 'success';
        return {
          title: `${success ? '✅' : '❌'} Cloudgate Backup ${success ? 'Successful' : 'Failed'}`,
          facts: [
            { name: 'Backup Type', value: 'Complete Cloudgate Instance' },
            ...(event.backupSize
              ? [{ name: 'Backup Size', value: event.backupSize }]
              : []),
            { name: 'Date', value: formatEventTime(date) },
            { name: 'Status', value: success ? 'Successful' : 'Failed' },
            ...(event.status === 'error' && event.errorMessage
              ? [
                  {
                    name: 'Error Message',
                    // 500, matching database-backup and volume-backup above:
                    // this is the third member of that family, and it was the
                    // only one of the three capped at nothing (H-124). Teams'
                    // build-error uses 800, and is a different family.
                    value: capMessage(event.errorMessage, 500),
                  },
                ]
              : []),
          ],
        };
      }
      case 'license-lapse': {
        const expiry = new Date(event.validUntil);
        const total = event.strandedMembers.length;
        return {
          title: '⚠️ Enterprise License Lapsed',
          facts: [
            { name: 'Organization', value: event.organizationName },
            { name: 'Expired', value: formatEventTime(expiry) },
            { name: 'Stopped', value: event.stopped.join('; ') },
            // One fact per member: a FactSet renders each on its own row, and
            // teams collapses the newlines a joined list would need.
            //
            // Which is also why discord's version of this list and
            // leaves this one alone. Discord joins every member into one embed
            // field with a documented 1024-character limit; here no single
            // value grows with the lapse at all — measured at 2, 100 and 300
            // stranded members, the widest string in the whole payload stays
            // ~50 units, the length of one member line. What grows is the
            // number of facts, which is a request-size question and not one a
            // cap on an element could answer.
            ...event.strandedMembers.map((person, index) => ({
              name: `Locked Out ${index + 1}/${total}`,
              value: describeStrandedMember(person),
            })),
            { name: 'Message', value: event.message },
          ],
        };
      }
      case 'license-expiring': {
        const expiry = new Date(event.validUntil);
        return {
          title: '⏳ Enterprise License Expiring',
          facts: [
            { name: 'Organization', value: event.organizationName },
            { name: 'Expires', value: formatEventTime(expiry) },
            { name: 'Days Left', value: String(event.daysLeft) },
            { name: 'Message', value: event.message },
          ],
        };
      }
      case 'instance-restart':
        return {
          title: '✅ Cloudgate Server Restarted',
          facts: [
            { name: 'Status', value: 'Successful' },
            { name: 'Restart Time', value: formatEventTime(date) },
          ],
        };
      case 'preview-teardown-stuck':
        return {
          title: `⚠️ ${PREVIEW_TEARDOWN_STUCK_TITLE}`,
          facts: [
            ...previewTeardownStuckFacts(event, escapeMarkdown).map(
              ({ label, value }) => ({
                name: label,
                value,
              }),
            ),
            { name: 'Message', value: event.message },
          ],
        };
      case 'service-incident':
        return {
          title: `${event.state === 'opened' ? '🔴' : '🟢'} ${serviceIncidentTitle(event)}`,
          facts: serviceIncidentFacts(event, escapeMarkdown).map(
            ({ label, value }) => ({ name: label, value }),
          ),
          ...(event.serviceLink && {
            potentialAction: {
              type: 'Action.OpenUrl' as const,
              title: SERVICE_HEALTH_LINK_LABEL,
              url: event.serviceLink,
            },
          }),
        };
      case 'ai-model-not-answering':
        return {
          title: `🔴 ${AI_MODEL_NOT_ANSWERING_TITLE}`,
          facts: [
            ...aiModelNotAnsweringFacts(event, escapeMarkdown).map(
              ({ label, value }) => ({ name: label, value }),
            ),
            { name: 'Message', value: event.message },
          ],
          ...(event.aiModelLink && {
            potentialAction: {
              type: 'Action.OpenUrl' as const,
              title: AI_MODEL_LINK_LABEL,
              url: event.aiModelLink,
            },
          }),
        };
      case 'agent-rate-limited':
        return {
          title: `⚠️ ${AGENT_RATE_LIMITED_TITLE}`,
          facts: [
            ...agentRateLimitedFacts(event).map(({ label, value, typed }) => ({
              name: label,
              value: typed ? escapeMarkdown(value) : value,
            })),
            { name: 'Message', value: event.message },
          ],
          ...(event.agentLink && {
            potentialAction: {
              type: 'Action.OpenUrl' as const,
              title: AGENT_ROW_LINK_LABEL,
              url: event.agentLink,
            },
          }),
        };
      default:
        return null;
    }
  }
}
