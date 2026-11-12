import { Injectable } from '@nestjs/common';
import { SmtpSender } from '../../mail/senders/smtp';
import type { SmtpConnection } from '../../mail/senders/smtp';
import { renderEventEmail } from '../events/event-emails';
import { channelFailure } from './channel-failure';
import type { ChannelEvent } from './channel.strategy';
import type { NotificationChannelStrategy } from './channel.strategy';

/**
 * The email notification path: render the event's email template and push it
 * through sendEmailNotification (the Phase 38 SmtpSender).
 *
 * **No body cap, and a character count is not the shape an email limit has.**
 * There is no provider to read: the transport is whatever SMTP server
 * the operator configured, so no vendor documentation could state the limit in
 * force. What SMTP defines is a per-server **message size** in bytes, which the
 * receiving server advertises in its EHLO response and which covers headers,
 * body and every encoded attachment together (the SIZE extension, RFC 1870,
 * https://www.rfc-editor.org/rfc/rfc1870). That is a byte budget negotiated per
 * connection, not a character count on rendered HTML, and `capMessage` — which
 * cuts UTF-16 code units of one string — cannot express it. A refusal on size
 * is at least loud: `SmtpSender` logs it and rethrows, so unlike telegram's
 * swallow the operator sees it.
 *
 * The one length RFC 5322 does fix is per **line** (998 characters,
 * https://www.rfc-editor.org/rfc/rfc5322#section-2.1.1), which the transfer
 * encoding already settles — `SmtpSender` hands nodemailer
 * `textEncoding: 'base64'` — and not something a cap on the body would help
 * with.
 *
 * The unbounded value that reaches the body is the same `errorMessage` the chat
 * channels carry, via `renderEventEmail`'s details table.
 */
@Injectable()
export class EmailChannelStrategy implements NotificationChannelStrategy<SmtpConnection> {
  constructor(private readonly smtp: SmtpSender) {}

  async send(connection: SmtpConnection, event: ChannelEvent): Promise<void> {
    const rendered = await renderEventEmail(event);
    if (!rendered) return;
    try {
      // The header logo rides on the rendered email as its inline image.
      await this.smtp.send(
        connection,
        rendered.subject,
        rendered.html,
        rendered.inlineImages,
      );
    } catch (err) {
      // The one sentence, composed here because the sender reports the
      // transport failure and nothing else; why, in `channel-failure.ts`.
      throw channelFailure('email', err);
    }
  }
}
