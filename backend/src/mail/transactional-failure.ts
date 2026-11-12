import type { RenderedEmail } from './templates';

/**
 * Structurally the same slice as `auth.config`'s `TransactionalMailer`, spelled
 * out here rather than imported so the mail module does not depend on auth's.
 */
interface Mailer {
  send(to: string, email: RenderedEmail): Promise<void>;
}

/**
 * Sends one transactional email and, if it fails, names what was being sent.
 *
 * The senders under `senders/` report the transport failure and nothing else
 * — they are under both this module and the notification channels, so
 * the only sentence they could compose would be wrong for one of them. This is
 * the transactional half of the pair whose other half is `channelFailure`
 * (`notifications/channels/channel-failure.ts`): the caller holds the noun, so
 * the caller composes the sentence.
 *
 * `MailService` itself stays a pass-through for the same reason — its other
 * caller, `BillingNotificationsService`, already composes *"Failed to send
 * invoice email to <addr>: …"* of its own, and a sentence at that seam would be
 * the second half of a doubled one.
 */
export async function sendTransactional(
  mailer: Mailer,
  noun: string,
  to: string,
  email: RenderedEmail,
): Promise<void> {
  try {
    await mailer.send(to, email);
  } catch (err) {
    throw new Error(
      `Failed to send the ${noun} email: ${err instanceof Error ? err.message : 'Unknown error'}`,
      { cause: err },
    );
  }
}
