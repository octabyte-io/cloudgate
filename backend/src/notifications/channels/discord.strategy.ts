import { Inject, Injectable } from '@nestjs/common';
import { FETCH_CLIENT } from '../../git-providers/fetch.provider';
import type { FetchClient } from '../../git-providers/fetch.provider';
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
import type { StrandedMemberSummary } from '../events/notification-event';
import { capMessage } from './cap-message';
import { channelFailure } from './channel-failure';
import { TEST_MESSAGE, TEST_TITLE } from './channel.strategy';
import type { ChannelEvent } from './channel.strategy';
import type { NotificationChannelStrategy } from './channel.strategy';
import { escapeMarkdown } from './escape-markup';

/**
 * The `Error Message` embed field of a failed backup, as database-backup has
 * always written it: capped, with an ellipsis saying that it was.
 *
 * Volume-backup and instance-backup wrote the identical field with **no cap at
 * all** until H-124. One function for the three so the number cannot drift
 * apart again, which is the whole of the finding.
 *
 * 1010 is not sourced as a platform limit anywhere in this tree, and is not
 * claimed as one here: it is the number the neighbouring case already applied to
 * this same field, which is the only defensible figure available. (Its
 * arithmetic hints at the intent — 1010 plus the two fences and the ellipsis is
 * 1019 — but what a platform does with a longer value is unverified, so the cap
 * is a consistency guarantee rather than a rejection defence.) Build-error keeps
 * its own 800 and its own no-ellipsis shape; that case is not this family.
 *
 * Sourcing the limit closes the hedge in that last paragraph without moving the
 * number. The field's own limit is *"Field value: 1024 characters"*, and
 * *"Exceeding these constraints results in a Bad Request response"*
 * (https://docs.discord.com/developers/resources/message) — so discord refuses
 * rather than truncates, and 1019 is five characters inside the limit it refuses
 * at. The `...` therefore sits **outside** the cap on purpose: 1010 is a budget
 * for the message, sized to leave room for the wrapper, and the wrapped result
 * is what has to fit. Build-error's 800 wraps to 806. Neither marker moves
 * inward, and no cap here changes.
 */
const BACKUP_ERROR_FIELD_LIMIT = 1010;
const backupErrorField = (errorMessage: string): string =>
  `\`\`\`${
    errorMessage.length > BACKUP_ERROR_FIELD_LIMIT
      ? `${capMessage(errorMessage, BACKUP_ERROR_FIELD_LIMIT)}...`
      : errorMessage
  }\`\`\``;

/**
 * The `Locked Out` embed field of a lapsed license: every stranded member on
 * one line, cut to discord's own limit on a field value, with a count of the
 * members the cut dropped.
 *
 * *"field.value | 1024 characters"*, and *"Violating any of these constraints
 * will result in a `Bad Request` response"* —
 * https://docs.discord.com/developers/resources/message#embed-object-embed-limits
 * — the same page and the same sentence read to settle the 1010 above,
 * now applied to the field it is actually the limit of.
 *
 * This field had **no cap at all** at first, and it is the one field on this
 * strategy where that mattered most: every other capped value degrades
 * gracefully (a truncated backup error is still a useful backup error), while
 * this one is the list of people who have just lost access, and *the number of
 * them is what made the message fail*. The alert got less deliverable as the
 * event got more serious. Measured before this existed: at the ~52 units a
 * member line takes, 22 stranded members produced a 1,123-unit value and 100
 * produced 5,179 — all of them a `Bad Request` and no alert.
 *
 * **The marker is counted inside the limit here, unlike `...` above.** That is
 * a deliberate difference rather than a second pattern: `BACKUP_ERROR_FIELD_
 * LIMIT`'s 1010 is a budget sized by hand for a wrapper of known width (two
 * fences and three dots, 1019), and a count's width is not known by hand — it
 * grows with the organization. So the note is measured rather than reserved,
 * against `members.length`, which bounds both the dropped count and its digits.
 * The `...` is this module's existing elision glyph, not a U+2026, so there is
 * one of them in the file.
 *
 * The member the cut landed inside is dropped rather than half-rendered. Two
 * reasons, and the second is the load-bearing one: a line reading `Ida Rhodes
 * (ida@exa` is a worse answer than no line, and a partial line would make the
 * count disagree with the list — the point of the count is that what arrived
 * plus what it names is everyone.
 */
const LOCKED_OUT_FIELD_LIMIT = 1024;
const lockedOutNote = (dropped: number): string => `\n...and ${dropped} more`;
const lockedOutField = (members: readonly StrandedMemberSummary[]): string => {
  const lines = members.map(describeStrandedMember).join('\n');
  if (lines.length <= LOCKED_OUT_FIELD_LIMIT) return lines;
  const kept = capMessage(
    lines,
    LOCKED_OUT_FIELD_LIMIT - lockedOutNote(members.length).length,
  );
  // A member is shown only if the cut left the whole of them, and the newline
  // after the line is what proves that. `lastIndexOf` answers -1 when the cut
  // landed inside the very first member, whose one truncated line is then all
  // there is to show; it counts as dropped, so the note still adds up.
  const lastBreak = kept.lastIndexOf('\n');
  const shown = lastBreak === -1 ? '' : kept.slice(0, lastBreak);
  const count = shown === '' ? 0 : shown.split('\n').length;
  return `${shown || kept}${lockedOutNote(members.length - count)}`;
};

/** A discord connection's fields. */
export interface DiscordChannelConnection {
  webhookUrl: string;
  decoration?: boolean | null;
}

/**
 * Posts one discord embed per event to the connection's webhook, with a
 * Cloudgate footer.
 */
@Injectable()
export class DiscordChannelStrategy implements NotificationChannelStrategy<DiscordChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: DiscordChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const embed = this.format(connection, event);
    if (!embed) return;
    try {
      const response = await this.fetch(connection.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!response.ok) throw channelFailure('discord', response.statusText);
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('discord', err);
    }
  }

  private format(
    connection: DiscordChannelConnection,
    event: ChannelEvent,
  ): Record<string, unknown> | null {
    const date = new Date();
    const unixDate = Math.trunc(Number(date) / 1000);
    // Emoji/prefix only when the connection has decorations on.
    const decorate = (decoration: string, text: string) =>
      `${connection.decoration ? decoration : ''} ${text}`.trim();

    switch (event.type) {
      case 'test':
        return {
          title: decorate('>', `\`🤚\` - ${TEST_TITLE}`),
          description: decorate('>', TEST_MESSAGE),
          color: 0xf3f7f4,
        };
      case 'app-deploy':
        return {
          title: decorate('>', '`✅` Build Successes'),
          color: 0x57f287,
          fields: [
            {
              name: decorate('`🛠️`', 'Project'),
              value: event.projectName,
              inline: true,
            },
            {
              name: decorate('`⚙️`', 'Application'),
              value: event.applicationName,
              inline: true,
            },
            {
              name: decorate('`🌍`', 'Environment'),
              value: event.environmentName,
              inline: true,
            },
            {
              name: decorate('`❔`', 'Type'),
              value: event.applicationType,
              inline: true,
            },
            {
              name: decorate('`📅`', 'Date'),
              value: `<t:${unixDate}:D>`,
              inline: true,
            },
            {
              name: decorate('`⌚`', 'Time'),
              value: `<t:${unixDate}:t>`,
              inline: true,
            },
            {
              name: decorate('`❓`', 'Type'),
              value: 'Successful',
              inline: true,
            },
            ...(event.buildLink
              ? [
                  {
                    name: decorate('`🧷`', 'Build Link'),
                    value: `[Click here to access build link](${event.buildLink})`,
                  },
                ]
              : []),
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Build Notification' },
        };
      case 'app-build-error': {
        const truncatedErrorMessage = capMessage(event.errorMessage, 800);
        return {
          title: decorate('>', '`⚠️` Build Failed'),
          color: 0xed4245,
          fields: [
            {
              name: decorate('`🛠️`', 'Project'),
              value: event.projectName,
              inline: true,
            },
            {
              name: decorate('`⚙️`', 'Application'),
              value: event.applicationName,
              inline: true,
            },
            {
              name: decorate('`❔`', 'Type'),
              value: event.applicationType,
              inline: true,
            },
            {
              name: decorate('`📅`', 'Date'),
              value: `<t:${unixDate}:D>`,
              inline: true,
            },
            {
              name: decorate('`⌚`', 'Time'),
              value: `<t:${unixDate}:t>`,
              inline: true,
            },
            {
              name: decorate('`❓`', 'Type'),
              value: 'Failed',
              inline: true,
            },
            {
              name: decorate('`⚠️`', 'Error Message'),
              value: `\`\`\`${truncatedErrorMessage}\`\`\``,
            },
            ...(event.buildLink
              ? [
                  {
                    name: decorate('`🧷`', 'Build Link'),
                    value: `[Click here to access build link](${event.buildLink})`,
                  },
                ]
              : []),
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Build Notification' },
        };
      }
      case 'database-backup': {
        const success = event.status === 'success';
        return {
          title: success
            ? decorate('>', '`✅` Database Backup Successful')
            : decorate('>', '`❌` Database Backup Failed'),
          color: success ? 0x57f287 : 0xed4245,
          fields: [
            {
              name: decorate('`🛠️`', 'Project'),
              value: event.projectName,
              inline: true,
            },
            {
              name: decorate('`⚙️`', 'Application'),
              value: event.applicationName,
              inline: true,
            },
            {
              name: decorate('`❔`', 'Database'),
              value: event.databaseType,
              inline: true,
            },
            {
              name: decorate('`📂`', 'Database Name'),
              value: event.databaseName,
              inline: true,
            },
            {
              name: decorate('`📅`', 'Date'),
              value: `<t:${unixDate}:D>`,
              inline: true,
            },
            {
              name: decorate('`⌚`', 'Time'),
              value: `<t:${unixDate}:t>`,
              inline: true,
            },
            {
              name: decorate('`❓`', 'Type'),
              value: success ? 'Successful' : 'Failed',
              inline: true,
            },
            ...(event.status === 'error' && event.errorMessage
              ? [
                  {
                    name: decorate('`⚠️`', 'Error Message'),
                    value: backupErrorField(event.errorMessage),
                  },
                ]
              : []),
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Database Backup Notification' },
        };
      }
      case 'volume-backup': {
        const success = event.status === 'success';
        return {
          title: success
            ? decorate('>', '`✅` Volume Backup Successful')
            : decorate('>', '`❌` Volume Backup Failed'),
          color: success ? 0x57f287 : 0xed4245,
          fields: [
            {
              name: decorate('`🛠️`', 'Project'),
              value: event.projectName,
              inline: true,
            },
            {
              name: decorate('`⚙️`', 'Application'),
              value: event.applicationName,
              inline: true,
            },
            {
              name: decorate('`💾`', 'Volume Name'),
              value: event.volumeName,
              inline: true,
            },
            {
              name: decorate('`🔧`', 'Service Type'),
              value: event.serviceType,
              inline: true,
            },
            ...(event.backupSize
              ? [
                  {
                    name: decorate('`📊`', 'Backup Size'),
                    value: event.backupSize,
                    inline: true,
                  },
                ]
              : []),
            {
              name: decorate('`📅`', 'Date'),
              value: `<t:${unixDate}:D>`,
              inline: true,
            },
            {
              name: decorate('`⌚`', 'Time'),
              value: `<t:${unixDate}:t>`,
              inline: true,
            },
            {
              name: decorate('`❓`', 'Type'),
              value: success ? 'Successful' : 'Failed',
              inline: true,
            },
            ...(event.status === 'error' && event.errorMessage
              ? [
                  {
                    name: decorate('`⚠️`', 'Error Message'),
                    value: backupErrorField(event.errorMessage),
                  },
                ]
              : []),
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Volume Backup Notification' },
        };
      }
      case 'docker-cleanup':
        return {
          title: decorate('>', '`✅` Docker Cleanup'),
          color: 0x57f287,
          fields: [
            {
              name: decorate('`📅`', 'Date'),
              value: `<t:${unixDate}:D>`,
              inline: true,
            },
            {
              name: decorate('`⌚`', 'Time'),
              value: `<t:${unixDate}:t>`,
              inline: true,
            },
            {
              name: decorate('`❓`', 'Type'),
              value: 'Successful',
              inline: true,
            },
            {
              name: decorate('`📜`', 'Message'),
              value: `\`\`\`${event.message}\`\`\``,
            },
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Docker Cleanup Notification' },
        };
      case 'server-threshold': {
        const eventDate = new Date(event.timestamp);
        const eventUnixDate = Math.trunc(Number(eventDate) / 1000);
        const typeEmoji = event.metric === 'CPU' ? '🔲' : '💾';
        return {
          title: decorate(
            '>',
            `\`${event.close ? '✅' : '⚠️'}\` ${serverThresholdTitle(event)}`,
          ),
          color: event.close ? 0x57f287 : 0xff0000,
          fields: [
            {
              name: decorate('`🏷️`', 'Server Name'),
              value: event.serverName,
              inline: true,
            },
            {
              name: decorate('`📅`', 'Date'),
              value: `<t:${eventUnixDate}:D>`,
              inline: true,
            },
            {
              name: decorate('`⌚`', 'Time'),
              value: `<t:${eventUnixDate}:t>`,
              inline: true,
            },
            {
              name: decorate(typeEmoji, 'Type'),
              value: event.metric,
              inline: true,
            },
            {
              name: decorate('📊', 'Current Value'),
              value: `${event.value.toFixed(2)}%`,
              inline: true,
            },
            {
              name: decorate('⚠️', 'Threshold'),
              value: describeServerThreshold(event),
              inline: true,
            },
            {
              name: decorate('`📜`', 'Message'),
              value: `\`\`\`${event.message}\`\`\``,
            },
            ...serverThresholdCloseFacts(event).map(({ label, value }) => ({
              name: label,
              value,
              inline: true,
            })),
          ],
          timestamp: eventDate.toISOString(),
          footer: { text: 'Cloudgate Server Monitoring Alert' },
        };
      }
      case 'instance-backup': {
        const success = event.status === 'success';
        return {
          title: success
            ? decorate('>', '`✅` Cloudgate Backup Successful')
            : decorate('>', '`❌` Cloudgate Backup Failed'),
          color: success ? 0x57f287 : 0xed4245,
          fields: [
            {
              name: decorate('`📦`', 'Backup Type'),
              value: 'Complete Cloudgate Instance',
              inline: true,
            },
            ...(event.backupSize
              ? [
                  {
                    name: decorate('`💾`', 'Backup Size'),
                    value: event.backupSize,
                    inline: true,
                  },
                ]
              : []),
            {
              name: decorate('`📅`', 'Date'),
              value: `<t:${unixDate}:D>`,
              inline: true,
            },
            {
              name: decorate('`⌚`', 'Time'),
              value: `<t:${unixDate}:t>`,
              inline: true,
            },
            {
              name: decorate('`❓`', 'Status'),
              value: success ? 'Successful' : 'Failed',
              inline: true,
            },
            ...(event.status === 'error' && event.errorMessage
              ? [
                  {
                    name: decorate('`⚠️`', 'Error Message'),
                    value: backupErrorField(event.errorMessage),
                  },
                ]
              : []),
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Instance Backup Notification' },
        };
      }
      case 'license-lapse': {
        const expiry = new Date(event.validUntil);
        const expiryUnix = Math.trunc(Number(expiry) / 1000);
        return {
          title: decorate('>', '`⚠️` Enterprise License Lapsed'),
          color: 0xed4245,
          fields: [
            {
              name: decorate('`🏢`', 'Organization'),
              value: event.organizationName,
              inline: true,
            },
            {
              name: decorate('`📅`', 'Expired'),
              value: `<t:${expiryUnix}:F>`,
              inline: true,
            },
            {
              name: decorate('`⛔`', 'Stopped'),
              value: event.stopped.join('\n'),
            },
            // Discord refuses an embed field with an empty value, so a lapse
            // that locks nobody out leaves the field out.
            ...(event.strandedMembers.length > 0
              ? [
                  {
                    name: decorate(
                      '`🔒`',
                      `Locked Out (${event.strandedMembers.length})`,
                    ),
                    value: lockedOutField(event.strandedMembers),
                  },
                ]
              : []),
            { name: decorate('`📜`', 'Message'), value: event.message },
          ],
          timestamp: expiry.toISOString(),
          footer: { text: 'Cloudgate Enterprise License Notification' },
        };
      }
      case 'license-expiring': {
        const expiry = new Date(event.validUntil);
        const expiryUnix = Math.trunc(Number(expiry) / 1000);
        return {
          title: decorate('>', '`⏳` Enterprise License Expiring'),
          color: 0xfee75c,
          fields: [
            {
              name: decorate('`🏢`', 'Organization'),
              value: event.organizationName,
              inline: true,
            },
            {
              name: decorate('`📅`', 'Expires'),
              value: `<t:${expiryUnix}:F>`,
              inline: true,
            },
            {
              name: decorate('`⏳`', 'Days Left'),
              value: String(event.daysLeft),
              inline: true,
            },
            { name: decorate('`📜`', 'Message'), value: event.message },
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Enterprise License Notification' },
        };
      }
      case 'instance-restart':
        return {
          title: decorate('>', '`✅` Cloudgate Server Restarted'),
          color: 0x57f287,
          fields: [
            {
              name: decorate('`📅`', 'Date'),
              value: `<t:${unixDate}:D>`,
              inline: true,
            },
            {
              name: decorate('`⌚`', 'Time'),
              value: `<t:${unixDate}:t>`,
              inline: true,
            },
            {
              name: decorate('`❓`', 'Type'),
              value: 'Successful',
              inline: true,
            },
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Restart Notification' },
        };
      case 'preview-teardown-stuck':
        return {
          title: decorate('>', `\`⚠️\` ${PREVIEW_TEARDOWN_STUCK_TITLE}`),
          color: 0xff0000,
          fields: [
            ...previewTeardownStuckFacts(event, escapeMarkdown).map(
              ({ label, value }) => ({
                name: label,
                value,
                inline: true,
              }),
            ),
            { name: 'Message', value: event.message },
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Preview Notification' },
        };
      case 'service-incident':
        return {
          title: decorate(
            '>',
            `\`${event.state === 'opened' ? '🔴' : '🟢'}\` ${serviceIncidentTitle(event)}`,
          ),
          color: event.state === 'opened' ? 0xed4245 : 0x57f287,
          fields: [
            ...serviceIncidentFacts(event, escapeMarkdown).map(
              ({ label, value }) => ({
                name: label,
                value,
                inline: true,
              }),
            ),
            ...(event.serviceLink
              ? [
                  {
                    name: 'Health',
                    value: `[${SERVICE_HEALTH_LINK_LABEL}](${event.serviceLink})`,
                  },
                ]
              : []),
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Service Health Notification' },
        };
      case 'ai-model-not-answering':
        return {
          title: decorate('>', `\`🔴\` ${AI_MODEL_NOT_ANSWERING_TITLE}`),
          color: 0xed4245,
          fields: [
            ...aiModelNotAnsweringFacts(event, escapeMarkdown).map(
              ({ label, value }) => ({ name: label, value, inline: true }),
            ),
            { name: 'Message', value: event.message },
            ...(event.aiModelLink
              ? [
                  {
                    name: 'AI model',
                    value: `[${AI_MODEL_LINK_LABEL}](${event.aiModelLink})`,
                  },
                ]
              : []),
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate AI Model Notification' },
        };
      case 'agent-rate-limited':
        return {
          title: decorate('>', `\`⚠️\` ${AGENT_RATE_LIMITED_TITLE}`),
          color: 0xffa500,
          fields: [
            ...agentRateLimitedFacts(event).map(({ label, value, typed }) => ({
              name: label,
              value: typed ? escapeMarkdown(value) : value,
              inline: true,
            })),
            { name: 'Message', value: event.message },
            ...(event.agentLink
              ? [
                  {
                    name: 'Agent',
                    value: `[${AGENT_ROW_LINK_LABEL}](${event.agentLink})`,
                  },
                ]
              : []),
          ],
          timestamp: date.toISOString(),
          footer: { text: 'Cloudgate Agent Notification' },
        };
      default:
        return null;
    }
  }
}
