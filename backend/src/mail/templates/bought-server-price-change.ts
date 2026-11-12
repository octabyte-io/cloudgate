import { render } from '@react-email/components';
import { emailLogoAttachment } from '../email-logo';
import type { RenderedEmail } from './index';
import { LapseNoticeTemplate } from './lapse-notice';

/** One Bought Server's new price, as the email words it: amounts and the date already formatted. */
export interface PriceChangeFacts {
  serverName: string;
  oldPrice: string;
  newPrice: string;
  /** The day the new price starts: 30 days on for a rise, today for a fall. */
  startsOn: string;
  rise: boolean;
}

/**
 * An Operator repriced an Organization's **Bought Servers** (ADR-0071,
 * #1400): one email to each owner, listing every Server repriced, its old
 * and new monthly price and the day the new one starts. A rise says the
 * Server may be deleted before then with no penalty; a fall says it applies
 * at once. Like every Bought Server email, it never names the provider.
 *
 * Its own module rather than another renderer in `index.ts`, which several
 * Bought Server tickets were adding to at once.
 */
export async function renderBoughtServerPriceChangeEmail({
  userName,
  organizationName,
  changes,
  serversUrl,
}: {
  userName: string;
  organizationName: string;
  changes: PriceChangeFacts[];
  serversUrl: string;
}): Promise<RenderedEmail> {
  const rises = changes.filter((change) => change.rise);
  const only = changes.length === 1 ? changes[0] : null;
  const subject = only
    ? only.rise
      ? `The price of your Server ${only.serverName} changes on ${only.startsOn}`
      : `The price of your Server ${only.serverName} is lower from today`
    : `The prices of your Servers in ${organizationName} are changing`;

  const paragraphs = [
    `The monthly price of ${
      only ? `the Server ${only.serverName}` : 'some Servers'
    } in ${organizationName} is changing, because what it costs us to run ${
      only ? 'it' : 'them'
    } has changed.`,
    ...changes.map((change) =>
      change.rise
        ? `${change.serverName}: ${change.oldPrice} a month now, ${change.newPrice} a month from ${change.startsOn}.`
        : `${change.serverName}: ${change.newPrice} a month instead of ${change.oldPrice}, from today, ${change.startsOn}.`,
    ),
  ];
  if (rises.length > 0) {
    paragraphs.push(
      `Until then you keep paying the price you pay now. You may delete ${
        rises.length === 1 ? 'the Server' : 'a Server'
      } before its new price starts, with no penalty: the new price is never charged for it.`,
    );
  }
  if (rises.length < changes.length) {
    paragraphs.push(
      'A lower price applies at once: the rest of this month is credited on your next invoice.',
    );
  }

  return {
    subject,
    html: await render(
      LapseNoticeTemplate({
        audience: 'owners',
        userName: userName || 'User',
        heading: only
          ? `A new price for ${only.serverName}`
          : 'New prices for your Servers',
        paragraphs,
        action: { label: 'Open Servers', url: serversUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}
