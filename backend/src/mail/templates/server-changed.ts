import type { RenderedEmail } from './index';
import { renderConfirmationEmail } from './confirmation';

/**
 * What a finished change made of a **Bought Server**, as the email says it:
 * backups on or off, the extra storage grown to a size, or a new size,
 * described by what it is (`3 vCPU · 4 GB RAM`, never the provider's code),
 * or null when the catalogue could not say.
 */
export type ServerChange =
  | { kind: 'backups'; on: boolean }
  | { kind: 'storage'; storageGb: number }
  | { kind: 'size'; size: string | null };

/**
 * A change to a **Bought Server** finished (spec #69, #75): backups turned on
 * or off, its extra storage grown, or its size changed. It says what changed
 * and what the Server now costs a month. A change refunded because the
 * provider refused it never gets this email, only its refund email.
 */
export async function renderServerChangedEmail({
  userName,
  organizationName,
  serverName,
  change,
  monthlyPrice,
  serverUrl,
}: {
  userName: string;
  organizationName: string;
  serverName: string;
  change: ServerChange;
  /** Every line of the Server together, formatted: `$30.00`. */
  monthlyPrice: string;
  serverUrl: string;
}): Promise<RenderedEmail> {
  const where = `the Server ${serverName} in ${organizationName}`;
  let subject: string;
  let what: string;
  switch (change.kind) {
    case 'backups':
      subject = `Backups are ${change.on ? 'on' : 'off'} for your Server ${serverName}`;
      what = change.on
        ? `Backups are now on for ${where}.`
        : `Backups are now off for ${where}, and its backups were deleted.`;
      break;
    case 'storage':
      subject = `Your Server ${serverName} now has ${change.storageGb} GB of extra storage`;
      what = `The extra storage of ${where} is now ${change.storageGb} GB.`;
      break;
    case 'size':
      subject = `Your Server ${serverName} has a new size`;
      what = `The Server ${serverName} in ${organizationName} now runs on ${change.size ?? 'its new size'}.`;
      break;
  }
  return renderConfirmationEmail(userName, {
    subject,
    heading: `${serverName} changed`,
    paragraphs: [what, `${serverName} now costs ${monthlyPrice} a month.`],
    action: { label: 'Open the Server', url: serverUrl },
  });
}
