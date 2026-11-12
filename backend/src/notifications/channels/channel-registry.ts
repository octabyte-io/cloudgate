import { Inject, Injectable } from '@nestjs/common';
import type { NotificationType } from '../../db/schema';
import { FETCH_CLIENT } from '../../git-providers/fetch.provider';
import type { FetchClient } from '../../git-providers/fetch.provider';
import { ResendSender } from '../../mail/senders/resend';
import { SmtpSender } from '../../mail/senders/smtp';
import { OutboundAddressGuard } from '../../outbound/outbound-address-guard';
import type { OutboundScope } from '../../outbound/outbound-address-guard';
import type { NotificationChannelStrategy } from './channel.strategy';
import { CustomChannelStrategy } from './custom.strategy';
import { DiscordChannelStrategy } from './discord.strategy';
import { EmailChannelStrategy } from './email.strategy';
import { GotifyChannelStrategy } from './gotify.strategy';
import { LarkChannelStrategy } from './lark.strategy';
import { MattermostChannelStrategy } from './mattermost.strategy';
import { NtfyChannelStrategy } from './ntfy.strategy';
import { PushoverChannelStrategy } from './pushover.strategy';
import { ResendChannelStrategy } from './resend.strategy';
import { SlackChannelStrategy } from './slack.strategy';
import { TeamsChannelStrategy } from './teams.strategy';
import { TelegramChannelStrategy } from './telegram.strategy';

/**
 * The connection field each guarded channel dials, as a refusal names it.
 * Telegram, Pushover and Resend are absent on purpose: each dials its
 * vendor's one fixed API host, and nothing in the connection can move it.
 */
export const CHANNEL_ADDRESS_FIELD = {
  slack: 'webhookUrl',
  discord: 'webhookUrl',
  mattermost: 'webhookUrl',
  teams: 'webhookUrl',
  lark: 'webhookUrl',
  gotify: 'serverUrl',
  ntfy: 'serverUrl',
  custom: 'endpoint',
  email: 'smtpServer',
} as const satisfies Partial<Record<NotificationType, string>>;

/**
 * Dispatch table: notification type → delivery strategy, built for the
 * Organization the channel belongs to.
 *
 * **Built per delivery, not injected once,** because where a channel may
 * dial depends on whose channel it is: a customer's webhook, gotify
 * or ntfy URL, custom endpoint or SMTP host must not have the platform host
 * call loopback, a private range or the metadata address, and the instance
 * organization's may (`OutboundAddressGuard`). A strategy takes its transport
 * in its constructor, so it is handed one already scoped — the strategies
 * themselves, and the suites that drive them with a mocked fetch, are
 * unchanged. The alternative, an `AsyncLocalStorage` scope read inside a
 * shared fetch, was rejected: what a dial may reach would then depend on a
 * context nothing at the call site shows.
 */
@Injectable()
export class NotificationChannelRegistry {
  constructor(
    @Inject(FETCH_CLIENT) private readonly fetch: FetchClient,
    private readonly guard: OutboundAddressGuard,
    private readonly smtp: SmtpSender,
    private readonly resend: ResendSender,
  ) {}

  /** The strategy for `type`, dialling only where `organizationId`'s channel may. */
  get(
    type: NotificationType,
    organizationId: string,
  ): NotificationChannelStrategy<never> {
    const place = { organizationId };
    switch (type) {
      case 'telegram':
        return new TelegramChannelStrategy(this.fetch);
      case 'pushover':
        return new PushoverChannelStrategy(this.fetch);
      case 'resend':
        return new ResendChannelStrategy(this.resend);
      case 'email':
        return new EmailChannelStrategy(
          this.guardedSmtp({ place, field: CHANNEL_ADDRESS_FIELD.email }),
        );
    }
    const fetch = this.guard.fetchFor(this.fetch, {
      place,
      field: CHANNEL_ADDRESS_FIELD[type],
    });
    switch (type) {
      case 'slack':
        return new SlackChannelStrategy(fetch);
      case 'discord':
        return new DiscordChannelStrategy(fetch);
      case 'mattermost':
        return new MattermostChannelStrategy(fetch);
      case 'teams':
        return new TeamsChannelStrategy(fetch);
      case 'lark':
        return new LarkChannelStrategy(fetch);
      case 'gotify':
        return new GotifyChannelStrategy(fetch);
      case 'ntfy':
        return new NtfyChannelStrategy(fetch);
      case 'custom':
        return new CustomChannelStrategy(fetch);
    }
  }

  /**
   * The SMTP sender with its host checked and pinned: nodemailer is handed
   * the address the guard checked, and the name as `servername`, so STARTTLS
   * and the certificate check are still against the host the operator typed.
   */
  private guardedSmtp(scope: OutboundScope): SmtpSender {
    const { smtp, guard } = this;
    return {
      async send(connection, ...rest) {
        const address = await guard.addressToDial(connection.smtpServer, scope);
        return smtp.send(
          address === connection.smtpServer
            ? connection
            : {
                ...connection,
                smtpServer: address,
                servername: connection.smtpServer,
              },
          ...rest,
        );
      },
    } as SmtpSender;
  }
}
