import { Inject, Injectable, Logger } from '@nestjs/common';
import { format } from 'date-fns';
import type Stripe from 'stripe';
import { FETCH_CLIENT } from '../../git-providers/fetch.provider';
import type { FetchClient } from '../../git-providers/fetch.provider';
import { MailService } from '../../mail/mail.service';
import type { MailAttachment } from '../../mail/senders/smtp';
import {
  renderInvoiceNotificationEmail,
  renderPaymentFailedEmail,
} from '../../mail/templates';

/** Who an invoice email goes to. */
export interface InvoiceRecipient {
  email: string;
  name: string;
}

/**
 * The billing emails the Stripe webhook sends: invoice paid (with the invoice
 * PDF attached when Stripe has one) and payment failed.
 *
 *   * mail goes through MailService;
 *   * the PDF is fetched through FETCH_CLIENT rather than global `fetch`, so the
 *     download is a boundary tests can replace (the git-providers precedent).
 */
@Injectable()
export class BillingNotificationsService {
  private readonly logger = new Logger(BillingNotificationsService.name);

  constructor(
    private readonly mail: MailService,
    @Inject(FETCH_CLIENT) private readonly fetch: FetchClient,
  ) {}

  /**
   * Mails the paid invoice. Silent when the invoice has no hosted URL, and
   * a send failure is logged rather than raised — the webhook must still answer
   * 200, or Stripe will retry an event that was already applied.
   * `trialEnded` marks the first real charge after the free trial, whose
   * email says the trial has ended.
   */
  async sendInvoicePaid(
    invoice: Stripe.Invoice,
    recipient: InvoiceRecipient,
    { trialEnded = false }: { trialEnded?: boolean } = {},
  ): Promise<void> {
    if (!invoice.hosted_invoice_url) return;

    try {
      const invoiceNumber = invoice.number || invoice.id || '';
      const pdf = invoice.invoice_pdf
        ? await this.downloadPdf(invoice.invoice_pdf)
        : null;
      const attachments: MailAttachment[] = pdf
        ? [{ filename: `cloudgate-invoice-${invoiceNumber}.pdf`, content: pdf }]
        : [];

      const email = await renderInvoiceNotificationEmail({
        userName: recipient.name,
        invoiceNumber,
        amountPaid: formatAmount(invoice.amount_paid, invoice.currency),
        currency: invoice.currency,
        date: formatDate(invoice.created),
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        hasPdf: !!pdf,
        trialEnded,
      });

      await this.mail.send(recipient.email, email, attachments);
    } catch (error) {
      this.logger.error(
        `Failed to send invoice email to ${recipient.email}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Mails a failed invoice payment, on the same terms. */
  async sendPaymentFailed(
    invoice: Stripe.Invoice,
    recipient: InvoiceRecipient,
  ): Promise<void> {
    if (!invoice.hosted_invoice_url) return;

    try {
      const email = await renderPaymentFailedEmail({
        userName: recipient.name,
        invoiceNumber: invoice.number || invoice.id || '',
        amountDue: formatAmount(invoice.amount_due, invoice.currency),
        currency: invoice.currency,
        date: formatDate(invoice.created),
        hostedInvoiceUrl: invoice.hosted_invoice_url,
      });

      await this.mail.send(recipient.email, email);
    } catch (error) {
      this.logger.error(
        `Failed to send payment failed email to ${recipient.email}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Fetches the invoice PDF — a failure means no attachment, not no email. */
  private async downloadPdf(url: string): Promise<Buffer | null> {
    try {
      const response = await this.fetch(url);
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }
}

/** Cents to a localized currency string. */
export function formatAmount(amountInCents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountInCents / 100);
}

/** Stripe's unix seconds as the emails print them. */
function formatDate(createdSeconds: number): string {
  return format(new Date(createdSeconds * 1000), 'MMM dd, yyyy');
}
