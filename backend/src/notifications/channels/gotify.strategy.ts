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

/** A gotify connection's fields. */
export interface GotifyChannelConnection {
  serverUrl: string;
  appToken: string;
  priority?: number | null;
  decoration?: boolean | null;
}

/**
 * Pushes one gotify title/message pair per event with the connection's app
 * token and priority.
 *
 * **No message cap: no limit was sourceable.** What was looked for: a
 * length on `message` or `title` in gotify's own API documentation. The
 * OpenAPI specification behind https://gotify.net/api-docs (gotify/server's
 * `docs/spec.json`) declares both as bare strings — *"message: The message.
 * Markdown (excluding html) is allowed. type: string"* — with no `maxLength`,
 * no `maximum` and nothing in either description. Nothing elsewhere on
 * gotify.net states one, and the question has been asked upstream and closed
 * without the docs gaining an answer (gotify/server#441, whose author reports
 * the same empty search).
 *
 * A number for gotify does circulate in issue threads. It is not in any gotify
 * document, so it is not here: carrying it would be the retraction the sourcing
 * rule exists to record, repeated.
 */
@Injectable()
export class GotifyChannelStrategy implements NotificationChannelStrategy<GotifyChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: GotifyChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const message = this.format(connection, event);
    if (!message) return;

    try {
      const response = await this.fetch(`${connection.serverUrl}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gotify-Key': connection.appToken,
        },
        body: JSON.stringify({
          title: message.title,
          message: message.message,
          // An Incident is high and never emergency, whatever the
          // connection says.
          priority:
            event.type === 'service-incident'
              ? SERVICE_INCIDENT_PRIORITY.gotify
              : connection.priority,
          extras: {
            'client::display': { contentType: 'text/plain' },
          },
        }),
      });
      if (!response.ok) throw channelFailure('gotify', response.statusText);
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('gotify', err);
    }
  }

  private format(
    connection: GotifyChannelConnection,
    event: ChannelEvent,
  ): { title: string; message: string } | null {
    const date = new Date();
    // Emoji only when the connection has decorations on — but the space and
    // the trailing newline are always there.
    const decorate = (decoration: string, text: string) =>
      `${connection.decoration ? decoration : ''} ${text}\n`;

    switch (event.type) {
      case 'test':
        return { title: TEST_TITLE, message: TEST_MESSAGE };
      case 'app-deploy':
        return {
          title: decorate('✅', 'Build Success'),
          message:
            `${decorate('🛠️', `Project: ${event.projectName}`)}` +
            `${decorate('⚙️', `Application: ${event.applicationName}`)}` +
            `${decorate('🌍', `Environment: ${event.environmentName}`)}` +
            `${decorate('❔', `Type: ${event.applicationType}`)}` +
            `${decorate('🕒', `Date: ${formatEventTime(date)}`)}` +
            (event.buildLink
              ? `${decorate('🔗', `Build details:\n${event.buildLink}`)}`
              : ''),
        };
      case 'app-build-error':
        return {
          title: decorate('⚠️', 'Build Failed'),
          message:
            `${decorate('🛠️', `Project: ${event.projectName}`)}` +
            `${decorate('⚙️', `Application: ${event.applicationName}`)}` +
            `${decorate('❔', `Type: ${event.applicationType}`)}` +
            `${decorate('🕒', `Date: ${formatEventTime(date)}`)}` +
            `${decorate('⚠️', `Error:\n${event.errorMessage}`)}` +
            (event.buildLink
              ? `${decorate('🔗', `Build details:\n${event.buildLink}`)}`
              : ''),
        };
      case 'database-backup':
        return {
          title: decorate(
            event.status === 'success' ? '✅' : '❌',
            `Database Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          ),
          message:
            `${decorate('🛠️', `Project: ${event.projectName}`)}` +
            `${decorate('⚙️', `Application: ${event.applicationName}`)}` +
            `${decorate('❔', `Type: ${event.databaseType}`)}` +
            `${decorate('📂', `Database Name: ${event.databaseName}`)}` +
            `${decorate('🕒', `Date: ${formatEventTime(date)}`)}` +
            `${event.status === 'error' && event.errorMessage ? decorate('❌', `Error:\n${event.errorMessage}`) : ''}`,
        };
      case 'volume-backup':
        return {
          title: decorate(
            event.status === 'success' ? '✅' : '❌',
            `Volume Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          ),
          message:
            `${decorate('🛠️', `Project: ${event.projectName}`)}` +
            `${decorate('⚙️', `Application: ${event.applicationName}`)}` +
            `${decorate('💾', `Volume Name: ${event.volumeName}`)}` +
            `${decorate('🔧', `Service Type: ${event.serviceType}`)}` +
            `${event.backupSize ? decorate('📊', `Backup Size: ${event.backupSize}`) : ''}` +
            `${decorate('🕒', `Date: ${formatEventTime(date)}`)}` +
            `${event.status === 'error' && event.errorMessage ? decorate('❌', `Error:\n${event.errorMessage}`) : ''}`,
        };
      case 'docker-cleanup':
        return {
          title: decorate('✅', 'Docker Cleanup'),
          message:
            `${decorate('🕒', `Date: ${formatEventTime(date)}`)}` +
            `${decorate('📜', `Message:\n${event.message}`)}`,
        };
      case 'instance-backup':
        return {
          title: decorate(
            event.status === 'success' ? '✅' : '❌',
            `Cloudgate Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          ),
          message:
            `${decorate('📦', 'Backup Type: Complete Cloudgate Instance')}` +
            `${event.backupSize ? decorate('💾', `Backup Size: ${event.backupSize}`) : ''}` +
            `${decorate('🕒', `Date: ${formatEventTime(date)}`)}` +
            `${event.status === 'error' && event.errorMessage ? decorate('❌', `Error:\n${event.errorMessage}`) : ''}`,
        };
      case 'instance-restart':
        return {
          title: decorate('✅', 'Cloudgate Server Restarted'),
          message: `${decorate('🕒', `Date: ${formatEventTime(date)}`)}`,
        };
      case 'license-lapse':
        return {
          title: decorate('⚠️', 'Enterprise License Lapsed'),
          message:
            `${decorate('🏢', `Organization: ${event.organizationName}`)}` +
            `${decorate('🕒', `Expired: ${formatEventTime(event.validUntil)}`)}` +
            `${decorate('⛔', `Stopped:\n${event.stopped.join('\n')}`)}` +
            (event.strandedMembers.length > 0
              ? `${decorate(
                  '🔒',
                  `Locked Out (${event.strandedMembers.length}):\n${event.strandedMembers
                    .map(describeStrandedMember)
                    .join('\n')}`,
                )}`
              : '') +
            `${decorate('📜', event.message)}`,
        };
      case 'license-expiring':
        return {
          title: decorate('⏳', 'Enterprise License Expiring'),
          message:
            `${decorate('🏢', `Organization: ${event.organizationName}`)}` +
            `${decorate('🕒', `Expires: ${formatEventTime(event.validUntil)}`)}` +
            `${decorate('⏳', `Days Left: ${event.daysLeft}`)}` +
            `${decorate('📜', event.message)}`,
        };
      case 'preview-teardown-stuck':
        return {
          title: decorate('⚠️', PREVIEW_TEARDOWN_STUCK_TITLE),
          message:
            previewTeardownStuckFacts(event)
              .map(({ label, value }) => decorate('▸', `${label}: ${value}`))
              .join('') + decorate('📜', event.message),
        };
      case 'service-incident':
        return {
          title: decorate(
            event.state === 'opened' ? '🔴' : '🟢',
            serviceIncidentTitle(event),
          ),
          message:
            serviceIncidentFacts(event)
              .map(({ label, value }) => decorate('▸', `${label}: ${value}`))
              .join('') +
            (event.serviceLink
              ? decorate(
                  '🔗',
                  `${SERVICE_HEALTH_LINK_LABEL}:\n${event.serviceLink}`,
                )
              : ''),
        };
      case 'ai-model-not-answering':
        return {
          title: decorate('🔴', AI_MODEL_NOT_ANSWERING_TITLE),
          message:
            aiModelNotAnsweringFacts(event)
              .map(({ label, value }) => decorate('▸', `${label}: ${value}`))
              .join('') +
            decorate('📜', event.message) +
            (event.aiModelLink
              ? decorate('🔗', `${AI_MODEL_LINK_LABEL}:\n${event.aiModelLink}`)
              : ''),
        };
      case 'agent-rate-limited':
        return {
          title: decorate('⚠️', AGENT_RATE_LIMITED_TITLE),
          message:
            agentRateLimitedFacts(event)
              .map(({ label, value }) => decorate('▸', `${label}: ${value}`))
              .join('') +
            decorate('📜', event.message) +
            (event.agentLink
              ? decorate('🔗', `${AGENT_ROW_LINK_LABEL}:\n${event.agentLink}`)
              : ''),
        };
      default:
        // No gotify message for server-threshold.
        return null;
    }
  }
}
