import type { NotificationEvent } from '../events/notification-event';

/**
 * The body of the "Test connection" probe — the first message an operator ever
 * receives from Cloudgate, and on most channels the only proof the channel
 * works.
 *
 * **One copy, because there were twelve.** Every channel strategy and
 * `renderEventEmail` had their own literal, so the wording could be — and was —
 * corrected in one place while eleven others kept saying something else. The
 * old text read `Hi, From Cloudgate 👋`: the capital F after the comma parsed
 * as a name rather than a greeting. It is one greeting now, punctuated as one.
 *
 * The census that keeps it at one copy is `channel-strategies.spec.ts`, which
 * drives every strategy in the registry with a `test` event and asserts the
 * constant reaches the wire, then scans `src/notifications` for a thirteenth
 * literal. A new channel that pastes the string instead of importing it fails
 * that scan rather than drifting quietly.
 */
export const TEST_MESSAGE = 'Hi from Cloudgate 👋';

/**
 * The probe's title, on the channels whose payload has somewhere to put one.
 *
 * Settled with the body, after three answers were found to the same
 * question: `Test Notification` on ntfy, gotify, pushover, the custom webhook,
 * discord and teams, `Test Email` in the email template, and nothing at all on
 * slack, mattermost, telegram and lark. `Test Notification` wins because it was
 * already the majority and because it is channel-agnostic — `Test Email` named
 * the transport, which the recipient can see for themselves.
 *
 * The four channels with no title still send only {@link TEST_MESSAGE}: their
 * payloads are a single text field, and prepending a title to the body would
 * change the message rather than label it. That is a property of those
 * payloads, not a twelfth copy of a decision.
 */
export const TEST_TITLE = 'Test Notification';

/** The "Test connection" probe ({@link TEST_MESSAGE}), as an event. */
export interface TestEvent {
  type: 'test';
}

export type ChannelEvent = NotificationEvent | TestEvent;

/**
 * One delivery strategy per notification channel: formats the event into the
 * channel's payload shape and pushes it through the channel's transport. An
 * event a channel has no format for (e.g. gotify + server-threshold) is
 * silently skipped.
 */
export interface NotificationChannelStrategy<TConnection> {
  send(connection: TConnection, event: ChannelEvent): Promise<void>;
}
