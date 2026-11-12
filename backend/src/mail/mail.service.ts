import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RenderedEmail } from './templates';
import { SmtpSender } from './senders/smtp';
import type { MailAttachment } from './senders/smtp';
import { ResendSender } from './senders/resend';

/**
 * Transactional mail behind one seam, over the SMTP and Resend senders,
 * picked by MAIL_PROVIDER. Per-organization notification
 * emails (later phase) use the senders directly with their own connection
 * rows; this service is for instance-level mail (auth verification, invites).
 *
 * **A send that fails rejects with the transport's own failure, unnamed.**
 * This is a seam rather than a caller — every caller has its own noun
 * for what it was sending, and only that caller knows it. `sendInvoicePaid`
 * (`cloud/billing/billing-notifications.service.ts`) already composes
 * *"Failed to send invoice email to …"* around whatever this rejects with, so a
 * sentence composed here would be the second half of a doubled one.
 */
@Injectable()
export class MailService {
  constructor(
    private readonly config: ConfigService,
    private readonly smtpSender: SmtpSender,
    private readonly resendSender: ResendSender,
  ) {}

  async send(
    to: string,
    email: RenderedEmail,
    attachments?: MailAttachment[],
  ): Promise<void> {
    // The header logo rides on the rendered email, so it is attached here on
    // either provider rather than by every caller; a caller's own file (the
    // invoice PDF) goes beside it.
    const allAttachments = [
      ...(email.inlineImages ?? []),
      ...(attachments ?? []),
    ];
    const provider = this.config.get<string>('MAIL_PROVIDER');
    const fromAddress = this.config.get<string>('MAIL_FROM_ADDRESS') ?? '';

    if (provider === 'smtp') {
      await this.smtpSender.send(
        {
          smtpServer: this.config.get<string>('SMTP_SERVER') ?? '',
          smtpPort: this.config.get<number>('SMTP_PORT') ?? 587,
          username: this.config.get<string>('SMTP_USERNAME') ?? '',
          password: this.config.get<string>('SMTP_PASSWORD') ?? '',
          fromAddress,
          toAddresses: [to],
        },
        email.subject,
        email.html,
        allAttachments,
      );
      return;
    }

    if (provider === 'resend') {
      await this.resendSender.send(
        {
          apiKey: this.config.get<string>('RESEND_API_KEY') ?? '',
          fromAddress,
          toAddresses: [to],
        },
        email.subject,
        email.html,
        allAttachments,
      );
      return;
    }

    throw new Error(
      'Mail is not configured: set MAIL_PROVIDER to "smtp" or "resend"',
    );
  }
}
