import type { RenderedEmail } from './index';
import { renderConfirmationEmail } from './confirmation';

/**
 * A **Bought Server** reached Ready (spec #69, #70): its first setup
 * finished, or failed, which includes being cut off by a restart twice. A
 * failed one is still Ready, with Setup failed and *Run setup* on its Setup
 * card, so the email says so and names the button.
 */
export async function renderServerReadyEmail({
  userName,
  organizationName,
  serverName,
  serverUrl,
  firstSetup,
}: {
  userName: string;
  organizationName: string;
  serverName: string;
  serverUrl: string;
  firstSetup: 'finished' | 'failed';
}): Promise<RenderedEmail> {
  const failed = firstSetup === 'failed';
  return renderConfirmationEmail(userName, {
    subject: failed
      ? `Your Server ${serverName} is ready, but its first setup failed`
      : `Your Server ${serverName} is ready`,
    heading: failed
      ? `${serverName} needs its setup run again`
      : `${serverName} is ready`,
    paragraphs: failed
      ? [
          `The Server ${serverName} bought for ${organizationName} is Ready, but its first setup failed.`,
          'Open the Server and press Run setup to try again: its Setup card shows what went wrong. You can deploy to it once a setup finishes.',
        ]
      : [
          `The Server ${serverName} bought for ${organizationName} is set up and Ready. You can deploy to it now.`,
        ],
    action: { label: 'Open the Server', url: serverUrl },
  });
}
