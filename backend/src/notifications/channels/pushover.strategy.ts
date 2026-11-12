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
  SERVICE_INCIDENT_PRIORITY,
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

/**
 * Pushover's own limit on the `message` parameter: *"Messages are currently
 * limited to 1024 UTF-8 characters (up to 4 bytes each), with a title of up to
 * 250 characters."* — https://pushover.net/api
 *
 * Sourced from that page, per the sourcing rule. Unlike the three channels `capMessage`
 * already serves, the limit is on the **whole message** rather than one field
 * of it, and the message is plain text with no markup a cut could break — so
 * the cap goes on the assembled body in `send`, once, and covers every event
 * and every field inside it rather than the error message alone.
 *
 * UTF-16 code units under a limit stated in characters is the conservative
 * direction (`capMessage`'s docblock settles the trade): an astral character
 * counts two units here and one character there, so 1024 units can never be
 * more than 1024 of pushover's characters.
 *
 * **The title is not capped**, and that is not an omission: every `title` this
 * file produces is a literal or a literal with a metric name in it, and the
 * longest of them ("Cloudgate Backup Successful") is 27 characters against the
 * documented 250. No input reaches a title, so there is nothing to cut.
 *
 * **The question is whether the unbounded-prose defect fixed in telegram is
 * here too, and it is not — because the cap is taken on the whole assembled
 * string rather than on a body with a budget.** In telegram the limit had to be
 * spent as *"4096 minus the prose"*, so an unbounded project name could take
 * the body's share to zero *and* put the total over the limit, and telegram
 * refuses an over-long message outright. Here the same project name is inside
 * the one string `capMessage` cuts: it can push the date and the error message
 * off the end, but the result is 1024 units by construction and pushover
 * receives a message it can deliver. That is the *detail* category rather than
 * its *delivery* one, and it is the trade this cap already documents above —
 * plain text with no markup a cut could break is exactly what makes cutting the
 * assembly safe. `channel-strategies.spec.ts` pins the bound against overlong
 * fields, so moving this cap onto a budgeted body later fails a test rather
 * than quietly re-opening that defect here.
 */
const PUSHOVER_MESSAGE_LIMIT = 1024;

/**
 * Why pushover refused, in pushover's words rather than only the HTTP status.
 *
 * *"If any input was invalid, you will receive an HTTP 4xx status, with a JSON
 * object or XML node containing a `status` code of something other than 1, and
 * an `errors` array detailing which parameters were invalid"* —
 * https://pushover.net/api, whose worked example is
 * `{"user":"invalid","errors":["user identifier is invalid"],"status":0,…}`.
 *
 * The cost of not reading it: a channel saved with a bad app
 * token and a bad user key answered *"Failed to send Pushover notification:
 * Bad Request."*, which is true of both mistakes and names neither. The array
 * names the field, and the field is what the operator has to go and fix.
 *
 * The status stays in front of it because the array is a list of parameter
 * complaints, not a sentence — and because a refusal that is *not* about the
 * input (a 500, a rate limit) has no `errors` array at all, and then the status
 * is the whole of what pushover said. Anything unreadable — no body, not JSON,
 * a connection cut mid-body — falls back to the status the same way: a failure
 * while reading the reason must not replace the reason with itself.
 *
 * This is the only channel of the twelve that reads a provider's error body.
 * That is not a precedent the other eleven are expected to follow blind: it is
 * here because pushover documents the shape, and the sourcing rule is that
 * a body shape nothing in this tree has quoted is not asserted from memory.
 */
const refusalReason = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { errors?: unknown };
    const errors = Array.isArray(body.errors)
      ? body.errors.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];
    if (errors.length > 0)
      return `${response.statusText}: ${errors.join('; ')}`;
  } catch {
    // Unreadable body; the status below is what pushover said.
  }
  return response.statusText;
};

/** A pushover connection's fields. */
export interface PushoverChannelConnection {
  userKey: string;
  apiToken: string;
  priority?: number | null;
  retry?: number | null;
  expire?: number | null;
}

/**
 * Sends one pushover title/message pair per event, at the connection's
 * priority.
 */
@Injectable()
export class PushoverChannelStrategy implements NotificationChannelStrategy<PushoverChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: PushoverChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const message = this.format(event);
    if (!message) return;

    const formData = new URLSearchParams();
    formData.append('token', connection.apiToken);
    formData.append('user', connection.userKey);
    formData.append('title', message.title);
    formData.append(
      'message',
      capMessage(message.message, PUSHOVER_MESSAGE_LIMIT),
    );
    // An Incident is high and never emergency: 2 repeats until it is
    // acknowledged, which a message told exactly twice must not do.
    const priority =
      event.type === 'service-incident'
        ? SERVICE_INCIDENT_PRIORITY.pushover
        : connection.priority;
    formData.append('priority', priority?.toString() || '0');
    // For emergency priority (2), retry and expire are required.
    if (priority === 2) {
      formData.append('retry', connection.retry?.toString() || '30');
      formData.append('expire', connection.expire?.toString() || '3600');
    }

    try {
      const response = await this.fetch(
        'https://api.pushover.net/1/messages.json',
        { method: 'POST', body: formData },
      );
      if (!response.ok) {
        throw channelFailure('pushover', await refusalReason(response));
      }
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('pushover', err);
    }
  }

  private format(
    event: ChannelEvent,
  ): { title: string; message: string } | null {
    const date = new Date();
    switch (event.type) {
      case 'test':
        return { title: TEST_TITLE, message: TEST_MESSAGE };
      case 'app-deploy':
        return {
          title: 'Build Success',
          message:
            `Project: ${event.projectName}\nApplication: ${event.applicationName}\n` +
            `Environment: ${event.environmentName}\nType: ${event.applicationType}\n` +
            `Date: ${formatEventTime(date)}`,
        };
      case 'app-build-error':
        return {
          title: 'Build Failed',
          message:
            `Project: ${event.projectName}\nApplication: ${event.applicationName}\n` +
            `Type: ${event.applicationType}\nDate: ${formatEventTime(date)}\n` +
            `Error: ${event.errorMessage}`,
        };
      case 'database-backup':
        return {
          title: `Database Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          message:
            `Project: ${event.projectName}\nApplication: ${event.applicationName}\n` +
            `Database: ${event.databaseType}\nDatabase Name: ${event.databaseName}\n` +
            `Date: ${formatEventTime(date)}${event.status === 'error' && event.errorMessage ? `\nError: ${event.errorMessage}` : ''}`,
        };
      case 'volume-backup':
        return {
          title: `Volume Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          message:
            `Project: ${event.projectName}\nApplication: ${event.applicationName}\n` +
            `Volume: ${event.volumeName}\nService Type: ${event.serviceType}` +
            `${event.backupSize ? `\nBackup Size: ${event.backupSize}` : ''}\n` +
            `Date: ${formatEventTime(date)}${event.status === 'error' && event.errorMessage ? `\nError: ${event.errorMessage}` : ''}`,
        };
      case 'docker-cleanup':
        return {
          title: 'Docker Cleanup',
          message: `Date: ${formatEventTime(date)}\nMessage: ${event.message}`,
        };
      case 'server-threshold': {
        const eventDate = new Date(event.timestamp);
        return {
          title: serverThresholdTitle(event),
          message:
            `Server: ${event.serverName}\nType: ${event.metric}\n` +
            `Current: ${event.value.toFixed(2)}%\nThreshold: ${describeServerThreshold(event)}\n` +
            `Message: ${event.message}\nTime: ${formatEventTime(eventDate)}` +
            serverThresholdCloseFacts(event)
              .map(({ label, value }) => `\n${label}: ${value}`)
              .join(''),
        };
      }
      case 'instance-backup':
        return {
          title: `Cloudgate Backup ${event.status === 'success' ? 'Successful' : 'Failed'}`,
          message:
            `Backup Type: Complete Cloudgate Instance` +
            `${event.backupSize ? `\nBackup Size: ${event.backupSize}` : ''}\n` +
            `Date: ${formatEventTime(date)}${event.status === 'error' && event.errorMessage ? `\nError: ${event.errorMessage}` : ''}`,
        };
      case 'license-lapse':
        return {
          title: 'Enterprise License Lapsed',
          message:
            `Organization: ${event.organizationName}\n` +
            `Expired: ${formatEventTime(event.validUntil)}\n` +
            `Stopped:\n${event.stopped.join('\n')}\n` +
            (event.strandedMembers.length > 0
              ? `Locked Out (${event.strandedMembers.length}):\n` +
                `${event.strandedMembers.map(describeStrandedMember).join('\n')}\n`
              : '') +
            event.message,
        };
      case 'license-expiring':
        return {
          title: 'Enterprise License Expiring',
          message:
            `Organization: ${event.organizationName}\n` +
            `Expires: ${formatEventTime(event.validUntil)}\n` +
            `Days Left: ${event.daysLeft}\n` +
            event.message,
        };
      case 'instance-restart':
        return {
          title: 'Cloudgate Server Restarted',
          message: `Date: ${formatEventTime(date)}`,
        };
      case 'preview-teardown-stuck':
        return {
          title: PREVIEW_TEARDOWN_STUCK_TITLE,
          message:
            previewTeardownStuckFacts(event)
              .map(({ label, value }) => `${label}: ${value}`)
              .join('\n') + `\n${event.message}`,
        };
      case 'service-incident':
        return {
          title: serviceIncidentTitle(event),
          message:
            serviceIncidentFacts(event)
              .map(({ label, value }) => `${label}: ${value}`)
              .join('\n') +
            (event.serviceLink
              ? `\n${SERVICE_HEALTH_LINK_LABEL}: ${event.serviceLink}`
              : ''),
        };
      case 'ai-model-not-answering':
        return {
          title: AI_MODEL_NOT_ANSWERING_TITLE,
          message:
            aiModelNotAnsweringFacts(event)
              .map(({ label, value }) => `${label}: ${value}`)
              .join('\n') +
            `\n${event.message}` +
            (event.aiModelLink
              ? `\n${AI_MODEL_LINK_LABEL}: ${event.aiModelLink}`
              : ''),
        };
      case 'agent-rate-limited':
        return {
          title: AGENT_RATE_LIMITED_TITLE,
          message:
            agentRateLimitedFacts(event)
              .map(({ label, value }) => `${label}: ${value}`)
              .join('\n') +
            `\n${event.message}` +
            (event.agentLink
              ? `\n${AGENT_ROW_LINK_LABEL}: ${event.agentLink}`
              : ''),
        };
      default:
        return null;
    }
  }
}
