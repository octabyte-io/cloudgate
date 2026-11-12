import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import type { Attachment } from 'resend';
import type { MailAttachment } from './smtp';

/** A Resend connection: API key, sender and recipients. */
export interface ResendConnection {
  apiKey: string;
  fromAddress: string;
  toAddresses: string[];
}

/**
 * A {@link MailAttachment} as the Resend SDK names it: a `cid` is Resend's
 * `contentId`, which is what makes the attachment inline for a `cid:`
 * reference in the HTML (the header logo).
 */
function toResendAttachment({
  filename,
  content,
  contentType,
  cid,
}: MailAttachment): Attachment {
  return {
    filename,
    content,
    ...(contentType && { contentType }),
    ...(cid && { contentId: cid }),
  };
}

/**
 * Sends one HTML email through Resend, with optional attachments; any failure is logged and rethrown as
 * the transport's own failure.
 *
 * **It does not name what was being sent** — the same reason the SMTP
 * sibling does not, written out on `SmtpSender`.
 */
@Injectable()
export class ResendSender {
  private readonly logger = new Logger(ResendSender.name);

  async send(
    connection: ResendConnection,
    subject: string,
    htmlContent: string,
    attachments?: MailAttachment[],
  ): Promise<void> {
    try {
      const client = new Resend(connection.apiKey);

      const result = await client.emails.send({
        from: connection.fromAddress,
        to: connection.toAddresses,
        subject,
        html: htmlContent,
        ...(attachments?.length && {
          attachments: attachments.map(toResendAttachment),
        }),
      });

      if (result.error) {
        throw new Error(result.error.message);
      }
    } catch (err) {
      this.logger.error(err);
      // Rethrown whole, on `SmtpSender`'s reasoning: the `result.error` branch
      // above already carries Resend's own words, and an SDK rejection carries
      // its `cause`.
      throw err instanceof Error
        ? err
        : new Error('Unknown error', { cause: err });
    }
  }
}
