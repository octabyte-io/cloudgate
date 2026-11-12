import { APIError } from 'better-auth/api';

/**
 * At most one confirmation email per address every few minutes: the
 * Hosted instance's guard on what a bot can make it send, on top of
 * better-auth's own 3-per-10-seconds limit per IP. That one stops a single
 * client hammering; this one stops many clients (or one rotating addresses on
 * its side) running up mail to the same inbox.
 *
 * Held in memory: the Hosted instance runs as one process on one VM (spec,
 * Out of Scope), and a restart forgetting a few minutes of sends costs
 * at most one extra email per address.
 */

/** How long after one confirmation email to an address the next is refused. */
export const CONFIRMATION_EMAIL_WINDOW_MS = 5 * 60_000;

/** better-auth's error code on the refusal, which the console shows as is. */
export const CONFIRMATION_EMAIL_LIMITED_CODE = 'CONFIRMATION_EMAIL_LIMITED';

/** The clock the limit reads, as milliseconds since the epoch. */
export type ConfirmationEmailClock = () => number;

/** The provider token for {@link ConfirmationEmailClock}; e2e moves it on. */
export const CONFIRMATION_EMAIL_CLOCK = 'CONFIRMATION_EMAIL_CLOCK';

export const systemConfirmationEmailClock: ConfirmationEmailClock = () =>
  Date.now();

export class ConfirmationEmailLimit {
  /** When the last email to each address went out, keyed lower-cased. */
  private readonly sentAt = new Map<string, number>();

  constructor(
    private readonly now: ConfirmationEmailClock = systemConfirmationEmailClock,
    private readonly windowMs = CONFIRMATION_EMAIL_WINDOW_MS,
  ) {}

  /**
   * Sends one confirmation email to `address` through `send`, or refuses with
   * 429 CONFIRMATION_EMAIL_LIMITED and sends nothing while the last one to the
   * same address is younger than the window. A send that fails does not count,
   * so the person can ask again at once.
   */
  async send(address: string, send: () => Promise<void>): Promise<void> {
    const now = this.now();
    this.forgetOlderThan(now);
    const key = address.trim().toLowerCase();
    const last = this.sentAt.get(key);
    if (last !== undefined) {
      const minutes = Math.ceil((last + this.windowMs - now) / 60_000);
      throw new APIError('TOO_MANY_REQUESTS', {
        code: CONFIRMATION_EMAIL_LIMITED_CODE,
        message:
          `A confirmation email was sent to ${key} a moment ago. ` +
          `Wait ${minutes === 1 ? 'a minute' : `${minutes} minutes`} before asking for another.`,
      });
    }
    this.sentAt.set(key, now);
    try {
      await send();
    } catch (error) {
      this.sentAt.delete(key);
      throw error;
    }
  }

  private forgetOlderThan(now: number): void {
    for (const [key, at] of this.sentAt) {
      if (now - at >= this.windowMs) this.sentAt.delete(key);
    }
  }
}
