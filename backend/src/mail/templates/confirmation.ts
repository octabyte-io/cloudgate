import { render } from '@react-email/components';
import { emailLogoAttachment } from '../email-logo';
import type { RenderedEmail } from './index';
import { LapseNoticeTemplate } from './lapse-notice';

/** What one confirmation says: everything but the greeting, already worded. */
export interface ConfirmationFacts {
  subject: string;
  heading: string;
  paragraphs: string[];
  /** The one button, to where the change can be seen. */
  action?: { label: string; url: string };
}

/**
 * The shell of every email confirming a change a customer made on the Hosted
 * instance (spec #69): their Server is ready, a payment was received, the plan,
 * the Add-ons or a Bought Server changed. Each goes to every owner and admin of
 * the Organization, always, in the {@link LapseNoticeTemplate} layout, whose
 * footer says so. Each confirmation's wording lives in its own module beside
 * this one (`server-ready.ts`), which builds the facts and calls this; none
 * names the provider (ADR-0071).
 */
export async function renderConfirmationEmail(
  userName: string,
  facts: ConfirmationFacts,
): Promise<RenderedEmail> {
  return {
    subject: facts.subject,
    html: await render(
      LapseNoticeTemplate({
        audience: 'owners-and-admins',
        userName: userName || 'User',
        heading: facts.heading,
        paragraphs: facts.paragraphs,
        action: facts.action,
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}
