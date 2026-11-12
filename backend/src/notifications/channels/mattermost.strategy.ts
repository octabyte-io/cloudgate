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
import { escapeMarkdown } from './escape-markup';

/** A mattermost connection's fields. */
export interface MattermostChannelConnection {
  webhookUrl: string;
  channel?: string | null;
  username?: string | null;
}

/**
 * Posts one mattermost message per event to the connection's incoming
 * webhook; the username defaults to Cloudgate.
 *
 * **No message cap, and the sourced behaviour is the reason not to add one.**
 * The unbounded value is `text`. Mattermost's incoming-webhook
 * documentation says what happens when it is too long: *"If the `text` is
 * longer than the allowable character limit per post, the message is split into
 * multiple consecutive posts, each within the character limit. From Mattermost
 * Server v5.0, posts up to 16383 characters are supported."*
 * (https://developers.mattermost.com/integrate/webhooks/incoming/). An
 * over-long post is therefore neither refused nor truncated — it arrives, in
 * several pieces. A cap here would delete the tail of a build failure that the
 * platform would otherwise have delivered in full.
 *
 * The per-post number is a server setting rather than a platform constant in
 * any case — *"Maximum Post Size: The maximum number of characters allowed in a
 * single message post. Default: 4000 characters"*, `ServiceSettings.MaxPostSize`
 * (https://docs.mattermost.com/administration-guide/configure/site-configuration-settings.html#maximum-post-size)
 * — and `webhookUrl` points at whichever self-hosted server the operator runs,
 * so there is no one number to encode even before the splitting rule settles
 * it.
 */
@Injectable()
export class MattermostChannelStrategy implements NotificationChannelStrategy<MattermostChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: MattermostChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const message = this.format(connection, event);
    if (!message) return;

    // Username and channel only when non-empty, the channel always #-prefixed.
    const payload = {
      ...message,
      ...(message.username?.trim() && { username: message.username }),
      ...(message.channel?.trim() && {
        channel: `#${message.channel.replace('#', '')}`,
      }),
    };

    try {
      const response = await this.fetch(connection.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw channelFailure('mattermost', response.statusText);
      }
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('mattermost', err);
    }
  }

  private format(
    connection: MattermostChannelConnection,
    event: ChannelEvent,
  ): {
    text: string;
    channel?: string | null;
    username?: string | null;
  } | null {
    const date = new Date();
    const channel = connection.channel;
    const username = connection.username || 'Cloudgate';
    switch (event.type) {
      case 'test':
        return { text: TEST_MESSAGE, channel, username };
      case 'app-deploy':
        return {
          text:
            `**✅ Build Success**\n\n**Project:** ${event.projectName}\n` +
            `**Application:** ${event.applicationName}\n**Type:** ${event.applicationType}\n` +
            `**Time:** ${formatEventTime(date)}` +
            (event.buildLink
              ? `\n\n[View Build Details](${event.buildLink})`
              : ''),
          channel,
          username,
        };
      case 'app-build-error':
        return {
          text:
            `:warning: **Build Failed**\n\n**Project:** ${event.projectName}\n` +
            `**Application:** ${event.applicationName}\n**Type:** ${event.applicationType}\n` +
            `**Time:** ${formatEventTime(date)}\n\n**Error:**\n\`\`\`\n${event.errorMessage}\n\`\`\`` +
            (event.buildLink
              ? `\n\n[View Build Details](${event.buildLink})`
              : ''),
          channel,
          username: connection.username || 'Cloudgate Bot',
        };
      case 'database-backup': {
        const statusEmoji = event.status === 'success' ? '✅' : '❌';
        const typeStatus = event.status === 'success' ? 'Successful' : 'Failed';
        const errorMsg =
          event.status === 'error' && event.errorMessage
            ? `\n\n**Error:**\n\`\`\`\n${event.errorMessage}\n\`\`\``
            : '';
        return {
          text:
            `**${statusEmoji} Database Backup ${typeStatus}**\n\n` +
            `**Project:** ${event.projectName}\n**Application:** ${event.applicationName}\n` +
            `**Type:** ${event.databaseType}\n**Database Name:** ${event.databaseName}\n` +
            `**Time:** ${formatEventTime(date)}${errorMsg}`,
          channel,
          username,
        };
      }
      case 'volume-backup': {
        const statusEmoji = event.status === 'success' ? '✅' : '❌';
        const typeStatus = event.status === 'success' ? 'Successful' : 'Failed';
        const errorMsg =
          event.status === 'error' && event.errorMessage
            ? `\n\n**Error:**\n\`\`\`\n${event.errorMessage}\n\`\`\``
            : '';
        const sizeInfo = event.backupSize
          ? `\n**Backup Size:** ${event.backupSize}`
          : '';
        return {
          text:
            `**${statusEmoji} Volume Backup ${typeStatus}**\n\n` +
            `**Project:** ${event.projectName}\n**Application:** ${event.applicationName}\n` +
            `**Volume Name:** ${event.volumeName}\n**Service Type:** ${event.serviceType}${sizeInfo}\n` +
            `**Time:** ${formatEventTime(date)}${errorMsg}`,
          channel,
          username,
        };
      }
      case 'docker-cleanup':
        return {
          text:
            `**✅ Docker Cleanup**\n\n**Message:** ${event.message}\n` +
            `**Time:** ${formatEventTime(date)}`,
          channel,
          username,
        };
      case 'server-threshold': {
        const eventDate = new Date(event.timestamp);
        return {
          text:
            `**${event.close ? '✅' : '⚠️'} ${serverThresholdTitle(event)}**\n\n**Server Name:** ${event.serverName}\n` +
            `**Type:** ${event.metric}\n**Current Value:** ${event.value.toFixed(2)}%\n` +
            `**Threshold:** ${describeServerThreshold(event)}\n**Message:** ${event.message}\n` +
            `**Time:** ${formatEventTime(eventDate)}` +
            serverThresholdCloseFacts(event)
              .map(({ label, value }) => `\n**${label}:** ${value}`)
              .join(''),
          channel,
          username,
        };
      }
      case 'instance-backup': {
        const statusEmoji =
          event.status === 'success' ? ':white_check_mark:' : ':x:';
        const typeStatus = event.status === 'success' ? 'Successful' : 'Failed';
        return {
          text:
            `${statusEmoji} **Cloudgate Backup ${typeStatus}**\n\n` +
            `**Backup Type:** Complete Cloudgate Instance${event.backupSize ? `\n**Backup Size:** ${event.backupSize}` : ''}\n` +
            `**Date:** ${formatEventTime(date)}\n**Status:** ${typeStatus}` +
            (event.status === 'error' && event.errorMessage
              ? `\n\n**Error:**\n\`\`\`\n${event.errorMessage}\n\`\`\``
              : ''),
          channel,
          username: connection.username || 'Cloudgate Bot',
        };
      }
      case 'license-lapse': {
        const expiry = new Date(event.validUntil);
        const who = event.strandedMembers
          .map((person) => `- ${describeStrandedMember(person)}`)
          .join('\n');
        return {
          text:
            `**⚠️ Enterprise License Lapsed**\n\n` +
            `**Organization:** ${event.organizationName}\n` +
            `**Expired:** ${formatEventTime(expiry)}\n` +
            `**Stopped:**\n${event.stopped.map((line) => `- ${line}`).join('\n')}\n` +
            (event.strandedMembers.length > 0
              ? `**Locked Out (${event.strandedMembers.length}):**\n${who}\n`
              : '') +
            `\n${event.message}`,
          channel,
          username,
        };
      }
      case 'license-expiring': {
        const expiry = new Date(event.validUntil);
        return {
          text:
            `**⏳ Enterprise License Expiring**\n\n` +
            `**Organization:** ${event.organizationName}\n` +
            `**Expires:** ${formatEventTime(expiry)}\n` +
            `**Days Left:** ${event.daysLeft}\n` +
            `\n${event.message}`,
          channel,
          username,
        };
      }
      case 'instance-restart':
        return {
          text:
            `**✅ Cloudgate Server Restarted**\n\n` +
            `**Time:** ${formatEventTime(date)}`,
          channel,
          username,
        };
      case 'preview-teardown-stuck':
        return {
          text:
            `**⚠️ ${PREVIEW_TEARDOWN_STUCK_TITLE}**\n\n` +
            previewTeardownStuckFacts(event, escapeMarkdown)
              .map(({ label, value }) => `**${label}:** ${value}`)
              .join('\n') +
            `\n\n${event.message}`,
          channel,
          username,
        };
      case 'service-incident':
        return {
          text:
            `**${event.state === 'opened' ? '🔴' : '🟢'} ${serviceIncidentTitle(event)}**\n\n` +
            serviceIncidentFacts(event, escapeMarkdown)
              .map(({ label, value }) => `**${label}:** ${value}`)
              .join('\n') +
            (event.serviceLink
              ? `\n\n[${SERVICE_HEALTH_LINK_LABEL}](${event.serviceLink})`
              : ''),
          channel,
          username,
        };
      case 'ai-model-not-answering':
        return {
          text:
            `**🔴 ${AI_MODEL_NOT_ANSWERING_TITLE}**\n\n` +
            aiModelNotAnsweringFacts(event, escapeMarkdown)
              .map(({ label, value }) => `**${label}:** ${value}`)
              .join('\n') +
            `\n\n${event.message}` +
            (event.aiModelLink
              ? `\n\n[${AI_MODEL_LINK_LABEL}](${event.aiModelLink})`
              : ''),
          channel,
          username,
        };
      case 'agent-rate-limited':
        return {
          text:
            `**⚠️ ${AGENT_RATE_LIMITED_TITLE}**\n\n` +
            agentRateLimitedFacts(event)
              .map(
                ({ label, value, typed }) =>
                  `**${label}:** ${typed ? escapeMarkdown(value) : value}`,
              )
              .join('\n') +
            `\n\n${event.message}` +
            (event.agentLink
              ? `\n\n[${AGENT_ROW_LINK_LABEL}](${event.agentLink})`
              : ''),
          channel,
          username,
        };
      default:
        return null;
    }
  }
}
