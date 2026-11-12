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
import { TEST_MESSAGE } from './channel.strategy';
import type { ChannelEvent } from './channel.strategy';
import type { NotificationChannelStrategy } from './channel.strategy';
import { escapeMarkdown } from './escape-markup';

/** A lark connection's fields. */
export interface LarkChannelConnection {
  webhookUrl: string;
}

/**
 * Posts one lark interactive card per event to the connection's webhook.
 *
 * **`send` reports a failed delivery rather than swallowing it, and the
 * swallow was not the mechanism.** It had a fire-and-forget `try/catch`, but
 * `send` never read `response.ok` — so a webhook that refused the card
 * *resolved* like a delivery and the `catch` was dead code on the path that
 * mattered. Nor did the `catch` do what the sentence it carried claimed: its
 * body was a comment and nothing else, no `this.logger.error`, so a rejected
 * `fetch` was silent as well. The finding is therefore **no trace at all**
 * rather than a log line nobody watches — which is the same shape measured
 * on telegram, one degree worse.
 *
 * That is why it is fixed here even though telegram's argument does not transfer.
 * That turned on telegram *refusing whole messages*, so a swallow there costs a
 * **delivery**; lark's documented breaches are the truncations `capMessage`
 * already handles, so a swallow here costs a **detail**. The half that is not a
 * detail is `NotificationsService.deliverTest`, which maps a throw to a 400
 * carrying the transport's message masked through `redactCredentials`: while
 * this resolved unconditionally, the console's "Test connection" answered
 * **200 OK for a lark webhook that cannot deliver**, which is a plain wrong
 * answer to a direct question rather than a missing detail.
 *
 * Nothing above needs to change to absorb the throw, and that was verified
 * rather than assumed: `NotificationDispatcherService.dispatch` wraps each
 * channel in its own `try/catch`, logs the row's `name` and `notificationType`
 * — which the swallowed `catch` here never did — and carries on to the next
 * row. This also makes the twelve channels uniform: slack, discord, teams,
 * gotify, ntfy, mattermost, pushover, custom and telegram throw on a non-ok
 * response, email and resend let the sender throw, and lark was the last one
 * out.
 *
 * *What each of them threw* was not uniform: this one composed
 * no prefix and had no `catch`, so a rejected `fetch` reached the console as
 * undici's bare "Fetch failed." Every strategy now throws `channelFailure`, on
 * both the non-ok and the rejected-`fetch` path.
 *
 * Only the HTTP status is read, and whether lark can also refuse inside a 200
 * body is left open rather than guessed at: none of the twelve strategies reads
 * a provider's in-body status code, and the sourcing rule is exactly why a
 * body shape is not asserted here from memory of a document nothing in this
 * tree has quoted.
 *
 * **The license-lapse locked-out list is not capped: no limit on a card
 * element was sourceable.** `discord.strategy.ts` puts the same list
 * into one embed field and that field has a documented 1024-character limit,
 * which is why it is capped there and this is not the same case.
 *
 * What was looked for: a maximum length on the `content` of a `markdown`
 * element, which is where this strategy joins the list. The card-JSON 2.0
 * rich-text (markdown) component reference and the `text` element reference
 * both declare `content` as bare text — *"Markdown text content"* — with no
 * maximum, no size and nothing in either description
 * (https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/rich-text,
 * https://open.larksuite.com/document/common-capabilities/message-card/message-cards-content/embedded-non-interactive-elements/text).
 * Nothing in the component overview states a per-element bound either.
 *
 * The one number Lark does publish is a **whole-request byte size**, and it is
 * the ntfy shape declined for the same reasons. The custom-bot guide this
 * strategy's `webhookUrl` belongs to says *"When sending messages, the request
 * body data size cannot exceed 20 KB"*
 * (https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot); the
 * app-bot `im/v1/messages` sibling states 30 KB for a card
 * (https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create).
 * `capMessage` cuts UTF-16 code units of one string, so it cannot express a
 * byte budget over a whole serialized card — every title here opens with an
 * emoji, three bytes of UTF-8 apiece — and cutting one element to a number
 * derived from the envelope would be inventing a figure no document states.
 * That is the retraction the sourcing rule exists to record, so it is not done here.
 */
@Injectable()
export class LarkChannelStrategy implements NotificationChannelStrategy<LarkChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: LarkChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const message = this.format(event);
    if (!message) return;
    try {
      const response = await this.fetch(connection.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!response.ok) throw channelFailure('lark', response.statusText);
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('lark', err);
    }
  }

  private format(event: ChannelEvent): Record<string, unknown> | null {
    const date = new Date();
    switch (event.type) {
      case 'test':
        return {
          msg_type: 'text',
          content: { text: TEST_MESSAGE },
        };
      case 'app-deploy':
        return this.buildStatusCard(event);
      case 'app-build-error': {
        const truncatedErrorMessage = capMessage(event.errorMessage, 800);
        return this.card({
          title: '⚠️ Build Failed',
          template: 'red',
          left: [
            `**Project:**\n${event.projectName}`,
            `**Type:**\n${event.applicationType}`,
            `**Error Message:**\n\`\`\`\n${truncatedErrorMessage}\n\`\`\``,
          ],
          right: [
            `**Application:**\n${event.applicationName}`,
            `**Date:**\n${formatEventTime(date)}`,
          ],
          button: event.buildLink
            ? {
                label: 'View Build Details',
                url: event.buildLink,
                type: 'danger',
              }
            : undefined,
        });
      }
      case 'database-backup': {
        const success = event.status === 'success';
        const truncated =
          event.errorMessage && event.errorMessage.length > 800
            ? capMessage(event.errorMessage, 800)
            : event.errorMessage;
        return this.card({
          title: success
            ? '✅ Database Backup Successful'
            : '❌ Database Backup Failed',
          template: success ? 'green' : 'red',
          left: [
            `**Project:**\n${event.projectName}`,
            `**Database Type:**\n${event.databaseType}`,
            `**Status:**\n${success ? 'Successful' : 'Failed'}`,
          ],
          right: [
            `**Application:**\n${event.applicationName}`,
            `**Database Name:**\n${event.databaseName}`,
            `**Date:**\n${formatEventTime(date)}`,
          ],
          extraElements:
            event.status === 'error' && truncated
              ? [
                  {
                    tag: 'markdown',
                    content: `**Error Message:**\n\`\`\`\n${truncated}\n\`\`\``,
                    text_align: 'left',
                    text_size: 'normal_v2',
                  },
                ]
              : [],
        });
      }
      case 'volume-backup': {
        const success = event.status === 'success';
        const truncated =
          event.errorMessage && event.errorMessage.length > 800
            ? capMessage(event.errorMessage, 800)
            : event.errorMessage;
        return this.card({
          title: success
            ? '✅ Volume Backup Successful'
            : '❌ Volume Backup Failed',
          template: success ? 'green' : 'red',
          left: [
            `**Project:**\n${event.projectName}`,
            `**Volume Name:**\n${event.volumeName}`,
            `**Status:**\n${success ? 'Successful' : 'Failed'}`,
          ],
          right: [
            `**Application:**\n${event.applicationName}`,
            `**Service Type:**\n${event.serviceType}`,
            `**Date:**\n${formatEventTime(date)}`,
          ],
          extraElements:
            event.status === 'error' && truncated
              ? [
                  {
                    tag: 'markdown',
                    content: `**Error Message:**\n\`\`\`\n${truncated}\n\`\`\``,
                    text_align: 'left',
                    text_size: 'normal_v2',
                  },
                ]
              : [],
        });
      }
      case 'docker-cleanup':
        return this.card({
          title: '✅ Docker Cleanup',
          template: 'green',
          left: [
            '**Status:**\nSuccessful',
            `**Cleanup Details:**\n${event.message}`,
          ],
          right: [`**Date:**\n${formatEventTime(date)}`],
        });
      case 'server-threshold': {
        const eventDate = new Date(event.timestamp);
        return this.card({
          title: `${event.close ? '✅' : '⚠️'} ${serverThresholdTitle(event)}`,
          template: event.close ? 'green' : 'red',
          left: [
            `**Server Name:**\n${event.serverName}`,
            `**Current Value:**\n${event.value.toFixed(2)}%`,
            `**Alert Message:**\n${event.message}`,
          ],
          right: [
            `**Type:**\n${event.metric === 'CPU' ? '🔲' : '💾'} ${event.metric}`,
            `**Threshold:**\n${describeServerThreshold(event)}`,
            `**Alert Time:**\n${formatEventTime(eventDate)}`,
            ...serverThresholdCloseFacts(event).map(
              ({ label, value }) => `**${label}:**\n${value}`,
            ),
          ],
        });
      }
      case 'instance-backup': {
        const success = event.status === 'success';
        const truncated =
          event.errorMessage && event.errorMessage.length > 800
            ? capMessage(event.errorMessage, 800)
            : event.errorMessage;
        return this.card({
          title: success
            ? '✅ Cloudgate Backup Successful'
            : '❌ Cloudgate Backup Failed',
          template: success ? 'green' : 'red',
          left: [
            '**Backup Type:**\nComplete Cloudgate Instance',
            `**Status:**\n${success ? 'Successful' : 'Failed'}`,
          ],
          right: [
            ...(event.backupSize
              ? [`**Backup Size:**\n${event.backupSize}`]
              : []),
            `**Date:**\n${formatEventTime(date)}`,
          ],
          extraElements:
            event.status === 'error' && truncated
              ? [
                  {
                    tag: 'markdown',
                    content: `**Error Message:**\n\`\`\`\n${truncated}\n\`\`\``,
                    text_align: 'left',
                    text_size: 'normal_v2',
                  },
                ]
              : [],
        });
      }
      case 'license-lapse': {
        const expiry = new Date(event.validUntil);
        const who = event.strandedMembers
          .map((person) => `- ${describeStrandedMember(person)}`)
          .join('\n');
        return this.card({
          title: '⚠️ Enterprise License Lapsed',
          template: 'red',
          left: [`**Organization:**\n${event.organizationName}`],
          right: [`**Expired:**\n${formatEventTime(expiry)}`],
          extraElements: [
            {
              tag: 'markdown',
              content: `**Stopped:**\n${event.stopped.map((line) => `- ${line}`).join('\n')}`,
              text_align: 'left',
              text_size: 'normal_v2',
            },
            ...(event.strandedMembers.length > 0
              ? [
                  {
                    tag: 'markdown',
                    content: `**Locked Out (${event.strandedMembers.length}):**\n${who}`,
                    text_align: 'left',
                    text_size: 'normal_v2',
                  },
                ]
              : []),
            {
              tag: 'markdown',
              content: event.message,
              text_align: 'left',
              text_size: 'normal_v2',
            },
          ],
        });
      }
      case 'license-expiring': {
        const expiry = new Date(event.validUntil);
        return this.card({
          title: '⏳ Enterprise License Expiring',
          template: 'orange',
          left: [`**Organization:**\n${event.organizationName}`],
          right: [
            `**Expires:**\n${formatEventTime(expiry)}`,
            `**Days Left:**\n${event.daysLeft}`,
          ],
          extraElements: [
            {
              tag: 'markdown',
              content: event.message,
              text_align: 'left',
              text_size: 'normal_v2',
            },
          ],
        });
      }
      case 'instance-restart':
        return this.card({
          title: '✅ Cloudgate Server Restarted',
          template: 'green',
          left: ['**Status:**\nSuccessful'],
          right: [`**Restart Time:**\n${formatEventTime(date)}`],
        });
      case 'preview-teardown-stuck': {
        const facts = previewTeardownStuckFacts(event, escapeMarkdown).map(
          ({ label, value }) => `**${label}:**\n${value}`,
        );
        return this.card({
          title: `⚠️ ${PREVIEW_TEARDOWN_STUCK_TITLE}`,
          template: 'red',
          left: facts.slice(0, 2),
          right: facts.slice(2),
          extraElements: [
            {
              tag: 'markdown',
              content: event.message,
              text_align: 'left',
              text_size: 'normal_v2',
            },
          ],
        });
      }
      case 'service-incident': {
        const facts = serviceIncidentFacts(event, escapeMarkdown).map(
          ({ label, value }) => `**${label}:**\n${value}`,
        );
        return this.card({
          title: `${event.state === 'opened' ? '🔴' : '🟢'} ${serviceIncidentTitle(event)}`,
          template: event.state === 'opened' ? 'red' : 'green',
          left: facts.slice(0, 3),
          right: facts.slice(3),
          button: event.serviceLink
            ? {
                label: SERVICE_HEALTH_LINK_LABEL,
                url: event.serviceLink,
                type: 'primary',
              }
            : undefined,
        });
      }
      case 'ai-model-not-answering': {
        const facts = aiModelNotAnsweringFacts(event, escapeMarkdown).map(
          ({ label, value }) => `**${label}:**\n${value}`,
        );
        return this.card({
          title: `🔴 ${AI_MODEL_NOT_ANSWERING_TITLE}`,
          template: 'red',
          left: facts.slice(0, 3),
          right: facts.slice(3),
          extraElements: [
            {
              tag: 'markdown',
              content: event.message,
              text_align: 'left',
              text_size: 'normal_v2',
            },
          ],
          button: event.aiModelLink
            ? {
                label: AI_MODEL_LINK_LABEL,
                url: event.aiModelLink,
                type: 'primary',
              }
            : undefined,
        });
      }
      case 'agent-rate-limited': {
        const facts = agentRateLimitedFacts(event).map(
          ({ label, value, typed }) =>
            `**${label}:**\n${typed ? escapeMarkdown(value) : value}`,
        );
        return this.card({
          title: `⚠️ ${AGENT_RATE_LIMITED_TITLE}`,
          template: 'red',
          left: facts.slice(0, 2),
          right: facts.slice(2),
          extraElements: [
            {
              tag: 'markdown',
              content: event.message,
              text_align: 'left',
              text_size: 'normal_v2',
            },
          ],
          button: event.agentLink
            ? {
                label: AGENT_ROW_LINK_LABEL,
                url: event.agentLink,
                type: 'primary',
              }
            : undefined,
        });
      }
      default:
        return null;
    }
  }

  /** The card most events share: header, two markdown columns, a button. */
  private card(options: {
    title: string;
    template: 'green' | 'orange' | 'red';
    left: string[];
    right: string[];
    extraElements?: Record<string, unknown>[];
    button?: { label: string; url: string; type: 'primary' | 'danger' };
  }): Record<string, unknown> {
    const markdown = (content: string) => ({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal_v2',
    });
    return {
      msg_type: 'interactive',
      card: {
        schema: '2.0',
        config: {
          update_multi: true,
          style: {
            text_size: {
              normal_v2: {
                default: 'normal',
                pc: 'normal',
                mobile: 'heading',
              },
            },
          },
        },
        header: {
          title: { tag: 'plain_text', content: options.title },
          subtitle: { tag: 'plain_text', content: '' },
          template: options.template,
          padding: '12px 12px 12px 12px',
        },
        body: {
          direction: 'vertical',
          padding: '12px 12px 12px 12px',
          elements: [
            {
              tag: 'column_set',
              columns: [
                {
                  tag: 'column',
                  width: 'weighted',
                  elements: options.left.map(markdown),
                  vertical_align: 'top',
                  weight: 1,
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  elements: options.right.map(markdown),
                  vertical_align: 'top',
                  weight: 1,
                },
              ],
            },
            ...(options.extraElements ?? []),
            ...(options.button
              ? [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: options.button.label },
                    type: options.button.type,
                    width: 'default',
                    size: 'medium',
                    behaviors: [
                      {
                        type: 'open_url',
                        default_url: options.button.url,
                        pc_url: '',
                        ios_url: '',
                        android_url: '',
                      },
                    ],
                    margin: '0px 0px 0px 0px',
                  },
                ]
              : []),
          ],
        },
      },
    };
  }

  /** The build-success interactive card. */
  private buildStatusCard(event: {
    projectName: string;
    applicationName: string;
    applicationType: string;
    environmentName: string;
    buildLink?: string;
  }): Record<string, unknown> {
    const date = new Date();
    return {
      msg_type: 'interactive',
      card: {
        schema: '2.0',
        config: {
          update_multi: true,
          style: {
            text_size: {
              normal_v2: {
                default: 'normal',
                pc: 'normal',
                mobile: 'heading',
              },
            },
          },
        },
        header: {
          title: { tag: 'plain_text', content: '✅ Build Success' },
          subtitle: { tag: 'plain_text', content: '' },
          template: 'green',
          padding: '12px 12px 12px 12px',
        },
        body: {
          direction: 'vertical',
          padding: '12px 12px 12px 12px',
          elements: [
            {
              tag: 'column_set',
              columns: [
                {
                  tag: 'column',
                  width: 'weighted',
                  elements: [
                    {
                      tag: 'markdown',
                      content: `**Project:**\n${event.projectName}`,
                      text_align: 'left',
                      text_size: 'normal_v2',
                    },
                    {
                      tag: 'markdown',
                      content: `**Environment:**\n${event.environmentName}`,
                      text_align: 'left',
                      text_size: 'normal_v2',
                    },
                    {
                      tag: 'markdown',
                      content: `**Type:**\n${event.applicationType}`,
                      text_align: 'left',
                      text_size: 'normal_v2',
                    },
                  ],
                  vertical_align: 'top',
                  weight: 1,
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  elements: [
                    {
                      tag: 'markdown',
                      content: `**Application:**\n${event.applicationName}`,
                      text_align: 'left',
                      text_size: 'normal_v2',
                    },
                    {
                      tag: 'markdown',
                      content: `**Date:**\n${formatEventTime(date)}`,
                      text_align: 'left',
                      text_size: 'normal_v2',
                    },
                  ],
                  vertical_align: 'top',
                  weight: 1,
                },
              ],
            },
            ...(event.buildLink
              ? [
                  {
                    tag: 'button',
                    text: {
                      tag: 'plain_text',
                      content: 'View Build Details',
                    },
                    type: 'primary',
                    width: 'default',
                    size: 'medium',
                    behaviors: [
                      {
                        type: 'open_url',
                        default_url: event.buildLink,
                        pc_url: '',
                        ios_url: '',
                        android_url: '',
                      },
                    ],
                    margin: '0px 0px 0px 0px',
                  },
                ]
              : []),
          ],
        },
      },
    };
  }
}
