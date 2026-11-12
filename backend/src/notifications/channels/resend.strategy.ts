import { Injectable } from '@nestjs/common';
import { ResendSender } from '../../mail/senders/resend';
import type { ResendConnection } from '../../mail/senders/resend';
import { renderEventEmail } from '../events/event-emails';
import { channelFailure } from './channel-failure';
import type { ChannelEvent } from './channel.strategy';
import type { NotificationChannelStrategy } from './channel.strategy';

/**
 * The resend notification path: render the event's email template and
 * push it through sendResendNotification (the Phase 38 ResendSender).
 *
 * **No body cap: no limit was sourceable.** What was looked for: a
 * maximum length on `html`, `text` or `subject`, the three fields this path
 * fills. Resend's send-email reference
 * (https://resend.com/docs/api-reference/emails/send-email) states maxima for
 * other fields — template variable keys *"no more than 50 characters"*, tag
 * names and values *"no more than 256 characters"* — and none for those three.
 * Its account quotas and limits page
 * (https://resend.com/docs/knowledge-base/account-quotas-and-limits) bounds
 * rate (10 requests per second), daily and monthly volume, batch size and
 * retention, and states no message size and no body length at all.
 *
 * Unlike the SMTP sibling this is a single vendor, so a limit *could* have been
 * sourced here; it simply is not published. No number is inferred from the
 * SMTP side or from another mail vendor to fill the gap.
 */
@Injectable()
export class ResendChannelStrategy implements NotificationChannelStrategy<ResendConnection> {
  constructor(private readonly resend: ResendSender) {}

  async send(connection: ResendConnection, event: ChannelEvent): Promise<void> {
    const rendered = await renderEventEmail(event);
    if (!rendered) return;
    try {
      // The header logo rides on the rendered email as its inline image.
      await this.resend.send(
        connection,
        rendered.subject,
        rendered.html,
        rendered.inlineImages,
      );
    } catch (err) {
      // The one sentence, composed here because the sender reports the
      // transport failure and nothing else; why, in `channel-failure.ts`.
      throw channelFailure('resend', err);
    }
  }
}
