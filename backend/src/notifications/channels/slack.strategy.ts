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
import { channelFailure } from './channel-failure';
import { TEST_MESSAGE } from './channel.strategy';
import type { ChannelEvent } from './channel.strategy';
import type { NotificationChannelStrategy } from './channel.strategy';
import { escapeSlack } from './escape-markup';

/** A slack connection's fields (test payloads carry no row id). */
export interface SlackChannelConnection {
  webhookUrl: string;
  channel?: string | null;
}

interface SlackField {
  title: string;
  value: string;
  short: boolean;
}

/**
 * Posts one slack message per event to the connection's incoming webhook:
 * plain text for the test probe, a colour-coded attachment of fields for the
 * rest.
 *
 * **No message cap, because no limit for the field this posts was sourceable.**
 * The unbounded value here is `attachments[].fields[].value` — the
 * error message, inside a legacy secondary attachment. Slack's own reference
 * for those attachments documents a length for exactly one field, and it is a
 * different one: *"footer — Limited to 300 characters"*. Its only remark about
 * `text` is a display note — it *"will automatically collapse if it contains
 * 700+ characters or 5+ line breaks"* — which is a fold in the client, not a
 * bound on the value
 * (https://docs.slack.dev/legacy/legacy-messaging/legacy-secondary-message-attachments/).
 *
 * `chat.postMessage` publishes two more numbers, and neither is a limit on this
 * field either: *"For best results, limit the number of characters in the
 * `text` field to 4,000 characters"* — a recommendation, about `text`, which
 * only the test event here sends — and *"Slack will truncate messages
 * containing more than 40,000 characters"*, a whole-message truncation Slack
 * performs itself (https://docs.slack.dev/reference/methods/chat.postMessage).
 * So the worst case is Slack shortening its own render, not refusing the
 * delivery, and cutting at 300, 700, 4,000 or 40,000 would each be encoding a
 * limit that this field does not have.
 */
@Injectable()
export class SlackChannelStrategy implements NotificationChannelStrategy<SlackChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: SlackChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const message = this.format(connection, event);
    if (!message) return;
    try {
      const response = await this.fetch(connection.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!response.ok) throw channelFailure('slack', response.statusText);
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('slack', err);
    }
  }

  private format(
    connection: SlackChannelConnection,
    event: ChannelEvent,
  ): Record<string, unknown> | null {
    const date = new Date();
    const { channel } = connection;
    switch (event.type) {
      case 'test':
        return { channel, text: TEST_MESSAGE };
      case 'app-deploy':
        return {
          channel,
          attachments: [
            {
              color: '#00FF00',
              pretext: ':white_check_mark: *Build Success*',
              fields: [
                { title: 'Project', value: event.projectName, short: true },
                {
                  title: 'Application',
                  value: event.applicationName,
                  short: true,
                },
                {
                  title: 'Environment',
                  value: event.environmentName,
                  short: true,
                },
                {
                  title: 'Type',
                  value: event.applicationType,
                  short: true,
                },
                {
                  title: 'Time',
                  value: formatEventTime(date),
                  short: true,
                },
                ...(event.buildLink
                  ? [
                      {
                        title: 'Details',
                        value: `<${event.buildLink}|View Build Details>`,
                        short: false,
                      },
                    ]
                  : []),
              ] satisfies SlackField[],
              mrkdwn_in: ['fields'],
            },
          ],
        };
      case 'app-build-error':
        return {
          channel,
          attachments: [
            {
              color: '#FF0000',
              pretext: ':warning: *Build Failed*',
              fields: [
                { title: 'Project', value: event.projectName, short: true },
                {
                  title: 'Application',
                  value: event.applicationName,
                  short: true,
                },
                { title: 'Type', value: event.applicationType, short: true },
                { title: 'Time', value: formatEventTime(date), short: true },
                {
                  title: 'Error',
                  value: `\`\`\`${event.errorMessage}\`\`\``,
                  short: false,
                },
                ...(event.buildLink
                  ? [
                      {
                        title: 'Details',
                        value: `<${event.buildLink}|View Build Details>`,
                        short: false,
                      },
                    ]
                  : []),
              ],
              mrkdwn_in: ['fields'],
            },
          ],
        };
      case 'database-backup': {
        const success = event.status === 'success';
        return {
          channel,
          attachments: [
            {
              color: success ? '#00FF00' : '#FF0000',
              pretext: success
                ? ':white_check_mark: *Database Backup Successful*'
                : ':x: *Database Backup Failed*',
              fields: [
                ...(event.status === 'error' && event.errorMessage
                  ? [
                      {
                        title: 'Error Message',
                        value: event.errorMessage,
                        short: false,
                      },
                    ]
                  : []),
                { title: 'Project', value: event.projectName, short: true },
                {
                  title: 'Application',
                  value: event.applicationName,
                  short: true,
                },
                { title: 'Type', value: event.databaseType, short: true },
                { title: 'Database Name', value: event.databaseName },
                { title: 'Time', value: formatEventTime(date), short: true },
                { title: 'Type', value: event.status },
                { title: 'Status', value: success ? 'Successful' : 'Failed' },
              ],
            },
          ],
        };
      }
      case 'volume-backup': {
        const success = event.status === 'success';
        return {
          channel,
          attachments: [
            {
              color: success ? '#00FF00' : '#FF0000',
              pretext: success
                ? ':white_check_mark: *Volume Backup Successful*'
                : ':x: *Volume Backup Failed*',
              fields: [
                ...(event.status === 'error' && event.errorMessage
                  ? [
                      {
                        title: 'Error Message',
                        value: event.errorMessage,
                        short: false,
                      },
                    ]
                  : []),
                { title: 'Project', value: event.projectName, short: true },
                {
                  title: 'Application',
                  value: event.applicationName,
                  short: true,
                },
                { title: 'Volume Name', value: event.volumeName, short: true },
                {
                  title: 'Service Type',
                  value: event.serviceType,
                  short: true,
                },
                ...(event.backupSize
                  ? [
                      {
                        title: 'Backup Size',
                        value: event.backupSize,
                        short: true,
                      },
                    ]
                  : []),
                { title: 'Time', value: formatEventTime(date), short: true },
                { title: 'Type', value: event.status, short: true },
                {
                  title: 'Status',
                  value: success ? 'Successful' : 'Failed',
                  short: true,
                },
              ],
            },
          ],
        };
      }
      case 'docker-cleanup':
        return {
          channel,
          attachments: [
            {
              color: '#00FF00',
              pretext: ':white_check_mark: *Docker Cleanup*',
              fields: [
                { title: 'Message', value: event.message },
                { title: 'Time', value: formatEventTime(date), short: true },
              ],
            },
          ],
        };
      case 'server-threshold': {
        const eventDate = new Date(event.timestamp);
        return {
          channel,
          attachments: [
            {
              color: event.close ? '#00FF00' : '#FF0000',
              pretext: `${event.close ? ':white_check_mark:' : ':warning:'} *${serverThresholdTitle(event)}*`,
              fields: [
                { title: 'Server Name', value: event.serverName, short: true },
                { title: 'Type', value: event.metric, short: true },
                {
                  title: 'Current Value',
                  value: `${event.value.toFixed(2)}%`,
                  short: true,
                },
                {
                  title: 'Threshold',
                  value: describeServerThreshold(event),
                  short: true,
                },
                { title: 'Message', value: event.message },
                {
                  title: 'Time',
                  value: formatEventTime(eventDate),
                  short: true,
                },
                // Only a close has these; the opening alert is as it was.
                ...serverThresholdCloseFacts(event).map(({ label, value }) => ({
                  title: label,
                  value,
                  short: true,
                })),
              ],
            },
          ],
        };
      }
      case 'instance-backup': {
        const success = event.status === 'success';
        return {
          channel,
          attachments: [
            {
              color: success ? '#00FF00' : '#FF0000',
              pretext: success
                ? ':white_check_mark: *Cloudgate Backup Successful*'
                : ':x: *Cloudgate Backup Failed*',
              fields: [
                ...(event.status === 'error' && event.errorMessage
                  ? [
                      {
                        title: 'Error Message',
                        value: event.errorMessage,
                        short: false,
                      },
                    ]
                  : []),
                {
                  title: 'Backup Type',
                  value: 'Complete Cloudgate Instance',
                  short: true,
                },
                ...(event.backupSize
                  ? [
                      {
                        title: 'Backup Size',
                        value: event.backupSize,
                        short: true,
                      },
                    ]
                  : []),
                { title: 'Time', value: formatEventTime(date), short: true },
                {
                  title: 'Status',
                  value: success ? 'Successful' : 'Failed',
                  short: true,
                },
              ],
            },
          ],
        };
      }
      case 'license-lapse': {
        const expiry = new Date(event.validUntil);
        return {
          channel,
          attachments: [
            {
              color: '#FF0000',
              pretext: ':warning: *Enterprise License Lapsed*',
              fields: [
                {
                  title: 'Organization',
                  value: event.organizationName,
                  short: true,
                },
                {
                  title: 'Expired',
                  value: formatEventTime(expiry),
                  short: true,
                },
                { title: 'Stopped', value: event.stopped.join('\n') },
                ...(event.strandedMembers.length > 0
                  ? [
                      {
                        title: `Locked Out (${event.strandedMembers.length})`,
                        value: event.strandedMembers
                          .map(describeStrandedMember)
                          .join('\n'),
                      },
                    ]
                  : []),
                { title: 'Message', value: event.message },
              ],
              mrkdwn_in: ['fields'],
            },
          ],
        };
      }
      case 'license-expiring': {
        const expiry = new Date(event.validUntil);
        return {
          channel,
          attachments: [
            {
              color: '#FFA500',
              pretext: ':hourglass: *Enterprise License Expiring*',
              fields: [
                {
                  title: 'Organization',
                  value: event.organizationName,
                  short: true,
                },
                {
                  title: 'Expires',
                  value: formatEventTime(expiry),
                  short: true,
                },
                {
                  title: 'Days Left',
                  value: String(event.daysLeft),
                  short: true,
                },
                { title: 'Message', value: event.message },
              ],
              mrkdwn_in: ['fields'],
            },
          ],
        };
      }
      case 'instance-restart':
        return {
          channel,
          attachments: [
            {
              color: '#00FF00',
              pretext: ':white_check_mark: *Cloudgate Server Restarted*',
              fields: [
                { title: 'Time', value: formatEventTime(date), short: true },
              ],
            },
          ],
        };
      case 'preview-teardown-stuck':
        return {
          channel,
          attachments: [
            {
              color: '#FF0000',
              pretext: `:warning: *${PREVIEW_TEARDOWN_STUCK_TITLE}*`,
              fields: [
                ...previewTeardownStuckFacts(event, escapeSlack).map(
                  ({ label, value }) => ({
                    title: label,
                    value,
                    short: true,
                  }),
                ),
                { title: 'Message', value: event.message },
              ],
              mrkdwn_in: ['fields'],
            },
          ],
        };
      case 'service-incident':
        // Red when it opens, green when it closes.
        return {
          channel,
          attachments: [
            {
              color: event.state === 'opened' ? '#FF0000' : '#00FF00',
              pretext: `${event.state === 'opened' ? ':red_circle:' : ':large_green_circle:'} *${serviceIncidentTitle(event)}*`,
              fields: [
                ...serviceIncidentFacts(event, escapeSlack).map(
                  ({ label, value }) => ({
                    title: label,
                    value,
                    short: true,
                  }),
                ),
                ...(event.serviceLink
                  ? [
                      {
                        title: 'Health',
                        value: `<${event.serviceLink}|${SERVICE_HEALTH_LINK_LABEL}>`,
                      },
                    ]
                  : []),
              ],
              mrkdwn_in: ['fields'],
            },
          ],
        };
      case 'ai-model-not-answering':
        return {
          channel,
          attachments: [
            {
              color: '#FF0000',
              pretext: `:red_circle: *${AI_MODEL_NOT_ANSWERING_TITLE}*`,
              fields: [
                ...aiModelNotAnsweringFacts(event, escapeSlack).map(
                  ({ label, value }) => ({ title: label, value, short: true }),
                ),
                { title: 'Message', value: event.message },
                ...(event.aiModelLink
                  ? [
                      {
                        title: 'AI model',
                        value: `<${event.aiModelLink}|${AI_MODEL_LINK_LABEL}>`,
                      },
                    ]
                  : []),
              ],
              mrkdwn_in: ['fields'],
            },
          ],
        };
      case 'agent-rate-limited':
        return {
          channel,
          attachments: [
            {
              color: '#FFA500',
              pretext: `:warning: *${AGENT_RATE_LIMITED_TITLE}*`,
              fields: [
                ...agentRateLimitedFacts(event).map(
                  ({ label, value, typed }) => ({
                    title: label,
                    value: typed ? escapeSlack(value) : value,
                    short: true,
                  }),
                ),
                { title: 'Message', value: event.message },
                ...(event.agentLink
                  ? [
                      {
                        title: 'Agent',
                        value: `<${event.agentLink}|${AGENT_ROW_LINK_LABEL}>`,
                      },
                    ]
                  : []),
              ],
              mrkdwn_in: ['fields'],
            },
          ],
        };
      default:
        return null;
    }
  }
}
