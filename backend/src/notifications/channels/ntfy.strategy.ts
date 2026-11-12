import { Inject, Injectable } from '@nestjs/common';
import { FETCH_CLIENT } from '../../git-providers/fetch.provider';
import type { FetchClient } from '../../git-providers/fetch.provider';
import { formatEventTime } from '../events/event-time';
import {
  AGENT_RATE_LIMITED_TITLE,
  AGENT_ROW_LINK_LABEL,
  agentRateLimitedFacts,
  describeStrandedMember,
  PREVIEW_TEARDOWN_STUCK_TITLE,
  previewTeardownStuckFacts,
  SERVICE_HEALTH_LINK_LABEL,
  SERVICE_INCIDENT_PRIORITY,
  serviceIncidentFacts,
  serviceIncidentTitle,
  AI_MODEL_LINK_LABEL,
  AI_MODEL_NOT_ANSWERING_TITLE,
  aiModelNotAnsweringFacts,
} from '../events/notification-event';
import { channelFailure } from './channel-failure';
import { TEST_MESSAGE, TEST_TITLE } from './channel.strategy';
import type { ChannelEvent } from './channel.strategy';
import type { NotificationChannelStrategy } from './channel.strategy';

/** An ntfy connection's fields. */
export interface NtfyChannelConnection {
  serverUrl: string;
  topic: string;
  accessToken?: string | null;
  priority?: number | null;
}

interface NtfyMessage {
  title: string;
  tags: string;
  actions: string;
  message: string;
}

/**
 * Publishes one ntfy message per event — title, tags, actions and body — to
 * the connection's topic.
 *
 * **No message cap: the one limit ntfy publishes is not one `capMessage` can
 * express.** ntfy states a maximum message size, and the wording carries
 * both reasons: *"If a message is greater than the maximum message size (4,096
 * bytes) or consists of non UTF-8 characters, the ntfy server will
 * automatically detect the mime type and size, and send the message as an
 * attachment file"* (https://docs.ntfy.sh/publish/).
 *
 * It is a limit in **bytes**, and `capMessage` cuts UTF-16 code units — one
 * unit is up to three bytes of UTF-8, and every line of every message here
 * opens with an emoji, so a body is over 4,096 bytes long before it is over
 * 4,096 units. Cutting at 4,096 units would therefore not deliver the bound;
 * cutting at a third of it would, and no document states that number. And going
 * over does not lose the notification: the server sends the body as an
 * attachment instead, which is a change of shape rather than a dropped
 * delivery.
 *
 * The limit is per-server besides — `message-size-limit` in server.yml, where
 * the only guidance is that *"message sizes >4K are not recommended, and
 * largely untested"* (https://docs.ntfy.sh/config/) — and `serverUrl` is
 * operator-supplied, so the number in force is the operator's.
 */
@Injectable()
export class NtfyChannelStrategy implements NotificationChannelStrategy<NtfyChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: NtfyChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const message = this.format(event);
    if (!message) return;

    try {
      const response = await this.fetch(
        `${connection.serverUrl}/${connection.topic}`,
        {
          method: 'POST',
          headers: {
            ...(connection.accessToken && {
              Authorization: `Bearer ${connection.accessToken}`,
            }),
            // An Incident is high and never urgent, whatever the
            // connection says.
            'X-Priority':
              event.type === 'service-incident'
                ? String(SERVICE_INCIDENT_PRIORITY.ntfy)
                : connection.priority?.toString() || '3',
            'X-Title': message.title,
            'X-Tags': message.tags,
            'X-Actions': message.actions,
          },
          body: message.message,
        },
      );
      if (!response.ok) throw channelFailure('ntfy', response.statusText);
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('ntfy', err);
    }
  }

  private format(event: ChannelEvent): NtfyMessage | null {
    const date = new Date();
    switch (event.type) {
      case 'test':
        return {
          title: TEST_TITLE,
          tags: '',
          // No action button: the one this carried opened the project's
          // repository, which an operator cannot open.
          actions: '',
          message: TEST_MESSAGE,
        };
      case 'app-deploy':
        return {
          title: 'Build Success',
          tags: 'white_check_mark',
          actions: event.buildLink
            ? `view, Build details, ${event.buildLink}, clear=true;`
            : '',
          message:
            `🛠Project: ${event.projectName}\n` +
            `⚙️Application: ${event.applicationName}\n` +
            `🌍Environment: ${event.environmentName}\n` +
            `❔Type: ${event.applicationType}\n` +
            `🕒Date: ${formatEventTime(date)}`,
        };
      case 'app-build-error':
        return {
          title: 'Build Failed',
          tags: 'warning',
          actions: event.buildLink
            ? `view, Build details, ${event.buildLink}, clear=true;`
            : '',
          message:
            `🛠️Project: ${event.projectName}\n` +
            `⚙️Application: ${event.applicationName}\n` +
            `❔Type: ${event.applicationType}\n` +
            `🕒Date: ${formatEventTime(date)}\n` +
            `⚠️Error:\n${event.errorMessage}`,
        };
      case 'database-backup':
        return {
          title: `Database Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          tags: `${event.status === 'success' ? 'white_check_mark' : 'x'}`,
          actions: '',
          // No newline after the database name: the date runs on from it.
          message:
            `🛠Project: ${event.projectName}\n` +
            `⚙️Application: ${event.applicationName}\n` +
            `❔Type: ${event.databaseType}\n` +
            `📂Database Name: ${event.databaseName}` +
            `🕒Date: ${formatEventTime(date)}\n` +
            `${event.status === 'error' && event.errorMessage ? `❌Error:\n${event.errorMessage}` : ''}`,
        };
      case 'volume-backup':
        return {
          title: `Volume Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          tags: `${event.status === 'success' ? 'white_check_mark' : 'x'}`,
          actions: '',
          message:
            `🛠️Project: ${event.projectName}\n` +
            `⚙️Application: ${event.applicationName}\n` +
            `💾Volume Name: ${event.volumeName}\n` +
            `🔧Service Type: ${event.serviceType}\n` +
            `${event.backupSize ? `📊Backup Size: ${event.backupSize}\n` : ''}` +
            `🕒Date: ${formatEventTime(date)}\n` +
            `${event.status === 'error' && event.errorMessage ? `❌Error:\n${event.errorMessage}` : ''}`,
        };
      case 'docker-cleanup':
        return {
          title: 'Docker Cleanup',
          tags: 'white_check_mark',
          actions: '',
          message:
            `🕒Date: ${formatEventTime(date)}\n` +
            `📜Message:\n${event.message}`,
        };
      case 'instance-backup':
        return {
          title: `Cloudgate Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          tags: `${event.status === 'success' ? 'white_check_mark' : 'x'}`,
          actions: '',
          message:
            '📦Backup Type: Complete Cloudgate Instance\n' +
            `${event.backupSize ? `💾Backup Size: ${event.backupSize}\n` : ''}` +
            `🕒Date: ${formatEventTime(date)}\n` +
            `${event.status === 'error' && event.errorMessage ? `❌Error:\n${event.errorMessage}` : ''}`,
        };
      case 'instance-restart':
        return {
          title: 'Cloudgate Server Restarted',
          tags: 'white_check_mark',
          actions: '',
          message: `🕒Date: ${formatEventTime(date)}`,
        };
      case 'license-lapse':
        // The title rides an HTTP header (X-Title), so it stays ASCII while
        // the emoji live in the body — as every title here already does.
        return {
          title: 'Enterprise License Lapsed',
          tags: 'warning',
          actions: '',
          message:
            `🏢Organization: ${event.organizationName}\n` +
            `🕒Expired: ${formatEventTime(event.validUntil)}\n` +
            `⛔Stopped:\n${event.stopped.join('\n')}\n` +
            (event.strandedMembers.length > 0
              ? `🔒Locked Out (${event.strandedMembers.length}):\n` +
                `${event.strandedMembers.map(describeStrandedMember).join('\n')}\n`
              : '') +
            `📜${event.message}`,
        };
      case 'license-expiring':
        // ASCII title for the X-Title header, as the lapse's.
        return {
          title: 'Enterprise License Expiring',
          tags: 'hourglass',
          actions: '',
          message:
            `🏢Organization: ${event.organizationName}\n` +
            `🕒Expires: ${formatEventTime(event.validUntil)}\n` +
            `⏳Days Left: ${event.daysLeft}\n` +
            `📜${event.message}`,
        };
      case 'preview-teardown-stuck':
        return {
          title: PREVIEW_TEARDOWN_STUCK_TITLE,
          tags: 'warning',
          actions: '',
          message:
            previewTeardownStuckFacts(event)
              .map(({ label, value }) => `${label}: ${value}`)
              .join('\n') + `\n${event.message}`,
        };
      case 'service-incident':
        return {
          title: serviceIncidentTitle(event),
          tags: event.state === 'opened' ? 'red_circle' : 'green_circle',
          actions: event.serviceLink
            ? `view, ${SERVICE_HEALTH_LINK_LABEL}, ${event.serviceLink}, clear=true;`
            : '',
          message: serviceIncidentFacts(event)
            .map(({ label, value }) => `${label}: ${value}`)
            .join('\n'),
        };
      case 'ai-model-not-answering':
        return {
          title: AI_MODEL_NOT_ANSWERING_TITLE,
          tags: 'red_circle',
          actions: event.aiModelLink
            ? `view, ${AI_MODEL_LINK_LABEL}, ${event.aiModelLink}, clear=true;`
            : '',
          message:
            aiModelNotAnsweringFacts(event)
              .map(({ label, value }) => `${label}: ${value}`)
              .join('\n') + `\n${event.message}`,
        };
      case 'agent-rate-limited':
        return {
          title: AGENT_RATE_LIMITED_TITLE,
          tags: 'warning',
          actions: event.agentLink
            ? `view, ${AGENT_ROW_LINK_LABEL}, ${event.agentLink}, clear=true;`
            : '',
          message:
            agentRateLimitedFacts(event)
              .map(({ label, value }) => `${label}: ${value}`)
              .join('\n') + `\n${event.message}`,
        };
      default:
        // No ntfy message for server-threshold.
        return null;
    }
  }
}
