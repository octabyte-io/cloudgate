import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

/**
 * An SMTP connection — env-configured for transactional mail now,
 * per-organization notification rows later.
 */
export interface SmtpConnection {
  smtpServer: string;
  smtpPort: number;
  username: string;
  password: string;
  fromAddress: string;
  toAddresses: string[];
  /**
   * The name to present for TLS when `smtpServer` is an address the caller
   * already resolved and checked (`OutboundAddressGuard`): SNI and the
   * certificate check stay against the host the operator typed, while the
   * connection goes to the address that was checked.
   */
  servername?: string;
}

/**
 * A file sent with an email. With a `cid` it is an inline image the HTML
 * references as `cid:<cid>` (the header logo, `mail/email-logo.ts`) rather
 * than a download; both senders pass it through as their transport names it.
 */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid?: string;
}

/**
 * Sends one HTML email over SMTP via nodemailer, with optional attachments;
 * any failure is logged and rethrown as the transport's own failure.
 *
 * **It does not name what was being sent.** This sender is under both
 * `MailService` — invitations, password resets, verification, billing — and the
 * email notification channel, and it used to flatten every failure into
 * `Failed to send email notification <reason>`. So a failed invitation reported
 * itself as a failed notification, which names the wrong subsystem and sends
 * whoever is debugging it to the notification channels screen. Only a caller
 * knows what it asked for, so the caller composes the sentence:
 * `channelFailure` (`notifications/channels/channel-failure.ts`) for the
 * notification strategies, its own for a transactional caller.
 */
@Injectable()
export class SmtpSender {
  private readonly logger = new Logger(SmtpSender.name);

  async send(
    connection: SmtpConnection,
    subject: string,
    htmlContent: string,
    attachments?: MailAttachment[],
  ): Promise<void> {
    try {
      const {
        smtpServer,
        smtpPort,
        username,
        password,
        fromAddress,
        toAddresses,
        servername,
      } = connection;
      const transporter = nodemailer.createTransport({
        host: smtpServer,
        port: smtpPort,
        auth: { user: username, pass: password },
        ...(servername && { servername }),
      });

      await transporter.sendMail({
        from: fromAddress,
        to: toAddresses.join(', '),
        subject,
        html: htmlContent,
        textEncoding: 'base64',
        attachments,
      });
    } catch (err) {
      this.logger.error(err);
      // Rethrown whole rather than re-wrapped: nodemailer hangs the code
      // (ECONNREFUSED, EAUTH) on the error it threw and undici's reason on its
      // `cause`, and the old wrap kept neither. A non-Error throw is the one
      // thing that has to be normalised, and it keeps the old fallback wording.
      throw err instanceof Error
        ? err
        : new Error('Unknown error', { cause: err });
    }
  }
}
