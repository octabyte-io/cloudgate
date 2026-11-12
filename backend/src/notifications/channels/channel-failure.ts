import type { NotificationType } from '../../db/schema';
import { isOutboundAddressRefusal } from '../../outbound/outbound-address-guard';

/**
 * How each channel names itself in a failed-delivery sentence.
 *
 * `satisfies Record<NotificationType, string>` is the census: a thirteenth
 * channel does not compile until it has a name here, which is what keeps the
 * sentence uniform (there were once five different shapes across six channels).
 *
 * The brands keep their own capitalisation — `ntfy` is lowercase in its own
 * documentation and in the console's own label — and the two channels that are
 * not brands (`email`, `custom webhook`) stay lowercase because they are
 * ordinary nouns. What is consistent is the sentence, not the letter case:
 * every channel says `Failed to send <name> notification: <reason>`.
 */
export const CHANNEL_NAMES = {
  slack: 'Slack',
  telegram: 'Telegram',
  discord: 'Discord',
  email: 'email',
  resend: 'Resend',
  gotify: 'Gotify',
  ntfy: 'ntfy',
  mattermost: 'Mattermost',
  custom: 'custom webhook',
  lark: 'Lark',
  pushover: 'Pushover',
  teams: 'Teams',
} as const satisfies Record<NotificationType, string>;

/**
 * Messages that name the wrapper rather than the failure.
 *
 * `fetch` rejects with a `TypeError` whose message is the bare literal
 * `fetch failed` no matter what went wrong; the reason — `getaddrinfo
 * ENOTFOUND api.example.com`, `connect ECONNREFUSED 127.0.0.1:9999` — is an
 * `Error` on its `cause`. `terminated` is the same shape one layer down, undici
 * saying the socket closed with the reason again on `cause`. So these three are
 * not reasons, they are markers that the reason is further in.
 */
const UNINFORMATIVE_MESSAGES = new Set([
  'fetch failed',
  'failed to fetch',
  'terminated',
]);

const isInformative = (message: string): boolean =>
  message !== '' && !UNINFORMATIVE_MESSAGES.has(message.toLowerCase());

/**
 * The outermost message in an error's `cause` chain that says what went wrong.
 *
 * Outermost-first rather than deepest-first on purpose: a layer that wrapped an
 * error usually knows more than the layer it wrapped, and only the wrappers
 * that say *nothing* (see {@link UNINFORMATIVE_MESSAGES}) are stepped over. A
 * `TypeError: fetch failed` is stepped over and its `cause` answers; a
 * `Failed to send Resend notification: API key is invalid` is not, and answers
 * itself.
 *
 * If every link is uninformative the first non-empty message is still better
 * than the fallback — `fetch failed` at least says the connection never got
 * anywhere — so it is kept and returned. `seen` guards a `cause` that points
 * back up the chain, which nothing here builds but an SDK could.
 */
const firstInformativeMessage = (error: unknown, fallback: string): string => {
  const seen = new Set<object>();
  let node: unknown = error;
  let bare = '';
  while (node !== null && node !== undefined) {
    if (typeof node === 'string') {
      return isInformative(node.trim()) ? node.trim() : bare || fallback;
    }
    if (typeof node !== 'object' || seen.has(node)) break;
    seen.add(node);
    const raw = (node as { message?: unknown }).message;
    const message = typeof raw === 'string' ? raw.trim() : '';
    if (isInformative(message)) return message;
    if (message !== '' && bare === '') bare = message;
    node = (node as { cause?: unknown }).cause;
  }
  return bare || fallback;
};

/**
 * This module's own prefix, taken off so the sentence is composed once.
 *
 * Every strategy calls {@link channelFailure} from both of its paths, and the
 * `catch` usually receives what the non-ok path threw — slack said it twice
 * before (*"Failed to send slack notification Failed to send slack
 * notification Forbidden"*). Stripping first makes {@link channelFailure}
 * idempotent, so a strategy never has to know which path it is on.
 *
 * **The colon is required, and that is the whole scope of this regex now.**
 * It used to tolerate an unpunctuated prefix as well, because the two
 * mail senders in `src/mail/senders` — the mail module's, not this one's —
 * flattened their own `Failed to send <x> notification <reason>` into every
 * failure, which is where the *"Failed to send Resend notification API key
 * is invalid."* came from. Stripping it here was a workaround: it made this
 * module a second place that had to know the senders' wording, and would have
 * drifted the moment that wording changed. The prefix came out of the
 * senders instead, so the only thing that composes one is {@link
 * channelFailure}, which always punctuates it.
 *
 * Bounded to a short run of word characters rather than `.*?` so it cannot eat
 * a reason that happens to start with those words.
 */
const CHANNEL_PREFIX = /^Failed to send [\w ]{1,32} notification:\s+/i;

const UNKNOWN_REASON = 'Unknown error';

/**
 * The one failed-delivery sentence, for every channel and every kind of
 * failure: `Failed to send <name> notification: <reason>`.
 *
 * Before this each strategy composed its own and five shapes reached the
 * console — mattermost and lark added no prefix at all, so a rejected `fetch`
 * arrived as the bare *"Fetch failed."*; teams and resend ran the prefix into
 * the reason with no punctuation; only pushover's read as a sentence. Worse,
 * the two with no prefix were also the two with no `try/catch`, so the reason
 * on `error.cause` was discarded and a host that does not resolve was
 * indistinguishable from a port that refuses.
 *
 * The bar is `destinations.service.ts`'s Test connection, which answers with
 * rclone's own words through `rcloneFailureMessage`: the transport's diagnosis,
 * not a sentence this tree wrote about it. `reason` is therefore whatever the
 * channel was actually told — a `Response.statusText`, a provider's error body,
 * or the message of the deepest link of the `cause` chain that says something.
 *
 * So every strategy calls this from both of its paths — the non-ok response
 * and the rejected transport — and the second call usually receives what the
 * first one threw. That re-wrap is why {@link CHANNEL_PREFIX} exists and is
 * safe; the ten `catch` blocks carry a pointer here rather than a copy of this
 * paragraph, because ten copies of one explanation is the very drift this
 * avoids, in prose.
 *
 * **Nothing here defeats the redaction.** `NotificationsService`
 * `sendSavedTest` still runs `redactCredentials` over the whole composed
 * sentence, so a webhook URL echoed back by a transport is masked exactly as
 * before. What the `cause` chain adds is a host and a port (`getaddrinfo
 * ENOTFOUND hooks.example.com`, `connect ECONNREFUSED 10.0.0.4:443`) — never a
 * URL path, which is the half of a webhook URL that is the credential.
 */
export const channelFailure = (
  channel: NotificationType,
  reason: unknown,
): Error =>
  // A refused address is passed on whole, not re-worded: it is the 400 that
  // names the field to correct, and its code is what a client branches on.
  isOutboundAddressRefusal(reason)
    ? reason
    : new Error(
        `Failed to send ${CHANNEL_NAMES[channel]} notification: ${firstInformativeMessage(
          reason,
          UNKNOWN_REASON,
        ).replace(CHANNEL_PREFIX, '')}`,
      );

/**
 * What `NotificationsService.deliverTest` answers a failed probe with: the
 * error's own message, or — where that message is the bare `fetch failed` — the
 * reason on its `cause`.
 *
 * Every strategy composes {@link channelFailure} now, so this is normally a
 * pass-through of a sentence that already names its cause. It walks the chain
 * anyway because this is the method the 400 is built in: a transport that
 * rejects somewhere no strategy wraps (an SDK, a DNS failure inside
 * nodemailer's own connect) still reaches a person with a reason rather than
 * with undici's placeholder.
 *
 * The prefix is *not* stripped here — at this point it is the composed sentence
 * an operator is meant to read, and which channel refused is half of it.
 */
export const deliveryFailureMessage = (
  error: unknown,
  fallback: string,
): string => firstInformativeMessage(error, fallback);
