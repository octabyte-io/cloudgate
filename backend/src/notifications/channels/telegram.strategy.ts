import { Inject, Injectable } from '@nestjs/common';
import { FETCH_CLIENT } from '../../git-providers/fetch.provider';
import type { FetchClient } from '../../git-providers/fetch.provider';
import { formatEventTime } from '../events/event-time';
import {
  AGENT_RATE_LIMITED_TITLE,
  AGENT_ROW_LINK_LABEL,
  agentRateLimitedFacts,
  describeServerThreshold,
  describeStrandedMember,
  PREVIEW_TEARDOWN_STUCK_TITLE,
  previewTeardownStuckFacts,
  serverThresholdCloseFacts,
  serverThresholdTitle,
  SERVICE_HEALTH_LINK_LABEL,
  serviceIncidentFacts,
  serviceIncidentTitle,
  AI_MODEL_LINK_LABEL,
  AI_MODEL_NOT_ANSWERING_TITLE,
  aiModelNotAnsweringFacts,
} from '../events/notification-event';
import { capMessage } from './cap-message';
import { channelFailure } from './channel-failure';
import { TEST_MESSAGE } from './channel.strategy';
import type { ChannelEvent } from './channel.strategy';
import type { NotificationChannelStrategy } from './channel.strategy';

/**
 * Telegram's own limit on the `text` parameter of `sendMessage`: *"Text of the
 * message to be sent, 1-4096 characters after entities parsing"* —
 * https://core.telegram.org/bots/api#sendmessage
 *
 * Sourced from that page rather than remembered, which is the whole of the
 * sourcing rule:
 * this number was once offered from memory, could not be found in the tree, and
 * was retracted. Note the shape of the sentence quoted above — a *range*, not a
 * maximum. Telegram refuses an over-long `text` rather than shortening it, so
 * of the nine channels whose limits were sourced this is the one whose breach
 * **loses the delivery** instead of garbling a glyph, which is why it was done
 * first. When this was written `send` below only logged a refusal and did not
 * read the response at all, so an over-long build failure was silent; it now
 * makes it report, which is what turns this cap from a safeguard nobody could
 * see working into one that says so when it does not.
 *
 * Two things the number does not do on its own:
 *
 * - It bounds the *message*, not the field inside it. Capping `errorMessage` at
 *   4096 would still assemble a message of 4096 plus the ~200 units of prose
 *   around it, which is still refused. So the budget below is the message's and
 *   the field gets what the prose leaves.
 * - It cannot be applied to the assembled string. `parse_mode: 'HTML'` means a
 *   cut landing inside `<pre>` or before its closing tag turns a *truncated*
 *   notification into a *rejected* one — the exact failure this cap exists to
 *   prevent. So the cut lands in the interpolated body and never in the markup.
 *
 * Both of the unit mismatches lean the safe way. "After entities parsing" means
 * telegram counts the text with the tags stripped, so counting the tags in cuts
 * sooner than telegram would; and UTF-16 code units under a limit stated in
 * characters is the same conservative direction `capMessage`'s docblock settles
 * (an astral character is two units and one character).
 */
const TELEGRAM_MESSAGE_TEXT_LIMIT = 4096;

/**
 * Escapes an interpolated value for a `parse_mode: 'HTML'` body — telegram's
 * own rule, and telegram's own three symbols: *"All `<`, `>` and `&` symbols
 * that are not a part of a tag or an HTML entity must be replaced with the
 * corresponding HTML entities (`<` with `&lt;`, `>` with `&gt;` and `&` with
 * `&amp;`)"* — https://core.telegram.org/bots/api#html-style
 *
 * Sourced from that page the way the length limit above was sourced, rather
 * than taken from general HTML practice. Two further sentences on the same
 * page are why an unescaped value costs the whole delivery instead of a glyph:
 * *"Only the tags mentioned above are currently supported"* and *"The API
 * currently supports only the following named HTML entities: `&lt;`, `&gt;`,
 * `&amp;` and `&quot;`"*. `sendMessage` answers `ok: false` with the reason in
 * `description` for a `text` it cannot parse, so a build failure whose stderr
 * reads `Type <Foo> is not assignable` took the notification with it — and `<`
 * is ordinary in a C++, XML or JSX diagnostic. Measured before this
 * existed: the body reached the wire as
 * `<pre>src/a.tsx(3,10): error TS2322: Type <Foo> & Bar</pre>`.
 *
 * Every interpolated value in `format` goes through this, not only the four
 * `errorMessage` sites the report named. `notification-event.ts` reasoned that
 * the license-lapse fields emit no bare angle bracket, which was true of
 * `describeStrandedMember`'s template and false of the values it interpolates:
 * a display name is whatever the account holder typed.
 *
 * Not applied to `reply_markup`, which is JSON telegram never parses as HTML —
 * escaping a domain there would put `&amp;` in a hostname. The four other
 * unescaped interpolations in `format` are each closed by something other than
 * this function, and are listed so a reviewer does not have to re-derive them:
 * `formatEventTime`, whose output is digits, a space, colons, dashes and `UTC`;
 * `toFixed` and an array `length`, which are numbers; `metric`, a two-literal
 * union the compiler closes; and the `statusEmoji`/`typeStatus` literals this
 * file wrote itself.
 * `channel-strategies.spec.ts` holds the whole of `format` to telegram's
 * parse rule for all ten event types, so an eleventh that interpolates a
 * field raw fails there rather than reaching a chat.
 *
 * `"` is deliberately not escaped. Telegram names three symbols, not four, and
 * `&quot;` matters only inside an attribute value; nothing here interpolates
 * into one. `&` is replaced first, because doing it after `<` would turn the
 * `&` of a freshly written `&lt;` into `&amp;lt;` and render the tag as text.
 */
const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * An entity `capMessage` cut in half: `&amp;` ending as `&`, `&a`, `&am` or
 * `&amp`. A complete entity ends in `;`, which is not a letter, so this can
 * only ever match an incomplete one — and after `escapeHtml` every `&` in the
 * body begins an entity, so there is no bare `&` for it to eat.
 */
const DANGLING_ENTITY = /&[a-zA-Z]{0,4}$/;

/**
 * How much of TELEGRAM_MESSAGE_TEXT_LIMIT one interpolated prose field may
 * spend — a project name, an application name, a volume name, an organization
 * name, a server name, a cleanup summary, a threshold alert.
 *
 * **This number is ours and not Telegram's, which the sourcing rule
 * requires saying out loud.** Telegram publishes one number for `sendMessage`,
 * the 4096 above, and none for a field inside the text; there is no page to
 * quote for 512 and none is implied. It is a product choice about where a
 * notification degrades, made because the alternative is losing the message.
 *
 * **What it fixes.** The budget `withinTextLimit` computes is *"4096
 * minus the prose"*, and the prose interpolates fields that were themselves
 * unbounded — so a long enough project name spent the whole budget and the
 * message went over the limit however hard the body was cut, and Telegram
 * refuses the whole message. Escaping widened that up to fivefold by escaping
 * before the cap (correctly): `&` becomes `&amp;`, so *n* characters can cost
 * *5n* units. Four of this file's ten events do not use `withinTextLimit` at
 * all, and for those an unbounded field had no cap of any kind — a 5000-unit
 * project name in a build *success* was refused just as readily.
 *
 * **Was it bounded at its source?** Checked first, because a real bound would
 * have been cheaper than an invented one, and two of the five fields the issue
 * named have one: an organization's name is `z.string().min(1).max(255)` in
 * `organization.dto.ts` — and that is the only writer, because better-auth's
 * own `/organization/create` and `/organization/update` are in `createAuth`'s
 * `disabledPaths` — and a member's `role` is `.max(50)` at both
 * `custom-role.dto.ts` and `update-member-role.dto.ts` (better-auth's own
 * `/organization/update-member-role` is in `disabledPaths` too). The
 * other three are not bounded anywhere: `project.name`, `application.name` and
 * `environment.name` are `text` columns (nothing in `backend/src` declares a
 * `varchar`) behind `z.string().min(1, 'name cannot be empty')` with no
 * `.max()`, a user's `firstName`/`lastName` are `text`, and
 * `ReceiveServerThresholdDto.Message` — an alert string a metrics agent posts —
 * is a bare `z.string()`.
 *
 * **So why not cite 255 and be done.** Because a source-character bound cannot
 * close the arithmetic: volume-backup interpolates five of these fields, and
 * 5 × 255 characters escape to as much as 6375 units, over the 4096 on their
 * own. The bound has to be in the same units as the limit, which means it is
 * taken on the *escaped* form — escape-then-cap, the ordering settled for
 * the body, so this file has one rule and not two. The cost of that choice is
 * real and is the reason it is written down: a 255-character organization name
 * made entirely of `&` escapes to 1275 units and is cut, even though
 * `organization.dto.ts` accepted it. A field of ordinary text is not, which is
 * the case worth optimising.
 *
 * **Why 512 and not the 255 that exists.** Twice the largest bound the tree
 * places on a name-shaped field, so a field carrying a real source bound
 * survives its own escaping unless most of it is expanding characters; and
 * generous enough that license-lapse's `message`, the one interpolated field
 * that is Cloudgate-generated prose rather than operator input
 * (`LAPSE_GUIDANCE` and a count, 320 units today), arrives whole with headroom
 * — `channel-strategies.spec.ts` pins that, so extending the guidance past the
 * headroom fails a test instead of silently truncating it.
 *
 * **The floor it buys, measured rather than derived.** With every field an
 * adversarial 5000 `&`, the body still gets 2414 units at app-build-error,
 * 1872 at database-backup and 1337 at volume-backup — the widest event, at
 * five fields. Nonzero is the property asked for; that it is over a
 * thousand is what makes the diagnostic still worth reading. The four events
 * with no body need no floor and are bounded by the same sum: app-deploy's four
 * fields cannot exceed 2048 units plus its prose. Before this, the same inputs
 * assembled 125,209 units at volume-backup and cut the error body to **zero**.
 * `channel-strategies.spec.ts` asserts both halves for all ten event types,
 * rather than trusting this paragraph.
 *
 * Not applied to the two bodies `withinTextLimit` already governs — the four
 * `errorMessage` sites and license-lapse's member list. Those get the message
 * budget, which is larger than 512 and is the whole point of having one, and
 * capping them here would shorten a diagnostic for no gain. A stranded
 * member's `name` therefore stays unbounded and cannot cost the delivery: it
 * is inside the list, and the list is the body.
 */
const TELEGRAM_FIELD_LIMIT = 512;

/**
 * One interpolated prose field, escaped and bounded — `escapeHtml` plus
 * TELEGRAM_FIELD_LIMIT, in that order and for that order's reason.
 *
 * The dangling-entity strip is the same one `withinTextLimit` needs and for the
 * same reason: cutting escaped text can leave `&am`, which is *"not a part of a
 * tag or an HTML entity"* and gets the message refused exactly as a bare `<`
 * does. Dropping only ever shortens, so the bound above still holds.
 */
const escapedField = (value: string): string =>
  capMessage(escapeHtml(value), TELEGRAM_FIELD_LIMIT).replace(
    DANGLING_ENTITY,
    '',
  );

/**
 * Assembles a message around `escapedBody`, with the body cut to whatever the
 * fixed prose leaves of TELEGRAM_MESSAGE_TEXT_LIMIT.
 *
 * `assemble('')` is the measurement: the overhead is read off the real template
 * at the real call site rather than counted by hand, so no second number goes
 * stale when a line of prose changes. `capMessage` does the cutting — there is
 * one cutter in this module and this is not a second one.
 *
 * **The body arrives already escaped, and that order is the point.**
 * Escaping expands — one `&` becomes five units — so escaping *after* the cut
 * would spend the budget the cut had just bought and hand telegram a `text`
 * over 4096 again, which is the refusal the cap exists to prevent. Escaping
 * first and cutting the escaped form keeps the bound, at the cost of the other
 * hazard: a cut landing inside `&amp;` leaves `&am`, which is itself *"not a
 * part of a tag or an HTML entity"* and is not one of the four names telegram
 * supports, so it is refused for the same reason a bare `<` is. The dangling
 * remnant is therefore dropped after the cut. Dropping only ever shortens, so
 * the budget still holds, and it is not a second cutter — it removes an
 * incomplete entity rather than enforcing a length.
 *
 * **The prose is now bounded too, which is what makes this budget hold.**
 * It used not to be: a 900-character project name escaped to 4500
 * units, left the body a budget of zero, and the message went over 4096
 * anyway — the hole was the original cap's, because the budget was always
 * *"what the prose leaves"*, and escaping widened it up to fivefold rather than
 * opening it. Every interpolated field in `assemble` now goes through
 * `escapedField`, so `assemble('').length` has a ceiling and `Math.max(…, 0)`
 * below can no longer be reached. The `Math.max` stays: it is cheaper than an
 * argument about which event has the most fields, and a floor of zero is the
 * right answer if a later event ever finds one.
 */
const withinTextLimit = (
  assemble: (escapedBody: string) => string,
  escapedBody: string,
): string =>
  assemble(
    capMessage(
      escapedBody,
      Math.max(TELEGRAM_MESSAGE_TEXT_LIMIT - assemble('').length, 0),
    ).replace(DANGLING_ENTITY, ''),
  );

/** A telegram connection's fields. */
export interface TelegramChannelConnection {
  botToken: string;
  chatId: string;
  messageThreadId?: string | null;
}

type InlineButton = { text: string; url: string }[][];

/**
 * Sends one HTML-formatted telegram message per event through the bot API,
 * with inline buttons where the event carries links.
 *
 * The five bodies this file interpolates that are not of known length — the
 * four `errorMessage` sites and license-lapse's member list — go through
 * `withinTextLimit`, and every interpolated value goes through
 * `escapeHtml`. Every *other* interpolation goes through `escapedField`,
 * which escapes and bounds it.
 *
 * That last sentence used to read *"every other interpolation is a
 * Cloudgate-generated line: a cleanup summary, a threshold alert, a project or
 * application name"*, and it was wrong in the same way the escaping fix found
 * `notification-event.ts` wrong: the *template* was ours and the values in it
 * were not. A project name is whatever an operator typed and no `.max()`
 * bounds it; docker-cleanup's summary is our literal wrapped around
 * `server.name` (`DockerCleanupService.runServerCleanup`); a threshold alert's
 * `message` is a bare `z.string()` a metrics agent posts
 * (`ReceiveServerThresholdDto`). Each of those could refuse the whole message
 * on length — and for app-deploy, docker-cleanup, server-threshold and
 * instance-restart, which have no body and so never called `withinTextLimit`,
 * with no cap of any kind in the way.
 *
 * **`send` reports a refusal rather than swallowing it.** Its old
 * fire-and-forget `try/catch` only called `this.logger.error`, and `send` never
 * looked at the response at all — so a telegram refusal, which is a 400
 * carrying `ok: false` and not a rejected `fetch`, resolved like a delivery and
 * did not even reach that log line. Telegram is the one channel of the twelve
 * whose breaches are **refusals rather than degradations**, so it is the one
 * where swallowing costs the delivery instead of a detail. Nothing above needs
 * to change to absorb the throw: `NotificationDispatcherService.dispatch`
 * already wraps each channel in its own `try/catch` that logs the row's name
 * and type — which `logger.error(err)` here never did — and carries on to the
 * next, and `NotificationsService.deliverTest` maps a throw to the 400 that
 * makes the console's "Test connection" answer truthfully. This is also the
 * majority shape rather than a new one: ten of the twelve strategies already
 * reported a failed delivery (slack, discord, teams, gotify, ntfy, mattermost,
 * pushover and custom on a non-ok response; email and resend by letting the
 * sender throw), which makes eleven. `lark.strategy.ts` was the twelfth and was
 * left swallowing here, because lark's breaches are the truncations
 * `capMessage` already handles rather than refusals, so it cost a detail and
 * not a delivery; it was fixed anyway on the other half of the argument — a
 * swallowing channel makes "Test connection" answer 200 for a webhook that
 * cannot deliver — and the twelve are now uniform.
 *
 * Uniform in *reporting*, that is; the sentences they reported with were not.
 * The non-ok throw above and the rejected-`fetch` path both go
 * through `channelFailure` now, in all twelve.
 */
@Injectable()
export class TelegramChannelStrategy implements NotificationChannelStrategy<TelegramChannelConnection> {
  constructor(@Inject(FETCH_CLIENT) private readonly fetch: FetchClient) {}

  async send(
    connection: TelegramChannelConnection,
    event: ChannelEvent,
  ): Promise<void> {
    const message = this.format(event);
    if (!message) return;
    const url = `https://api.telegram.org/bot${connection.botToken}/sendMessage`;
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: connection.chatId,
          message_thread_id: connection.messageThreadId,
          text: message.text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: message.inlineButton },
        }),
      });
      if (!response.ok) throw channelFailure('telegram', response.statusText);
    } catch (err) {
      // Both paths, one sentence; why, and why the re-wrap is safe:
      // `channel-failure.ts`.
      throw channelFailure('telegram', err);
    }
  }

  private format(
    event: ChannelEvent,
  ): { text: string; inlineButton?: InlineButton } | null {
    const date = new Date();
    switch (event.type) {
      case 'test':
        return { text: TEST_MESSAGE };
      case 'app-deploy': {
        const chunkArray = <T>(array: readonly T[], chunkSize: number): T[][] =>
          Array.from({ length: Math.ceil(array.length / chunkSize) }, (_, i) =>
            array.slice(i * chunkSize, i * chunkSize + chunkSize),
          );

        const inlineButton: InlineButton = [
          ...(event.buildLink
            ? [[{ text: 'Deployment Logs', url: event.buildLink }]]
            : []),
          ...chunkArray(event.domains ?? [], 2).map((chunk) =>
            chunk.map((domain) => ({
              text: domain.host,
              url: `${domain.https ? 'https' : 'http'}://${domain.host}`,
            })),
          ),
        ];

        return {
          text:
            `<b>✅ Build Success</b>\n\n<b>Project:</b> ${escapedField(event.projectName)}\n` +
            `<b>Application:</b> ${escapedField(event.applicationName)}\n` +
            `<b>Environment:</b> ${escapedField(event.environmentName)}\n` +
            `<b>Type:</b> ${escapedField(event.applicationType)}\n` +
            `<b>Time:</b> ${formatEventTime(date)}`,
          inlineButton,
        };
      }
      case 'app-build-error':
        return {
          text: withinTextLimit(
            (error) =>
              `<b>⚠️ Build Failed</b>\n\n<b>Project:</b> ${escapedField(event.projectName)}\n` +
              `<b>Application:</b> ${escapedField(event.applicationName)}\n<b>Type:</b> ${escapedField(event.applicationType)}\n` +
              `<b>Time:</b> ${formatEventTime(date)}\n\n` +
              `<b>Error:</b>\n<pre>${error}</pre>`,
            escapeHtml(event.errorMessage),
          ),
          inlineButton: event.buildLink
            ? [[{ text: 'Deployment Logs', url: event.buildLink }]]
            : undefined,
        };
      case 'database-backup': {
        const isError = event.status === 'error' && event.errorMessage;
        const statusEmoji = event.status === 'success' ? '✅' : '❌';
        const typeStatus = event.status === 'success' ? 'Successful' : 'Failed';
        return {
          text: withinTextLimit(
            (error) =>
              `<b>${statusEmoji} Database Backup ${typeStatus}</b>\n\n` +
              `<b>Project:</b> ${escapedField(event.projectName)}\n<b>Application:</b> ${escapedField(event.applicationName)}\n` +
              `<b>Type:</b> ${escapedField(event.databaseType)}\n<b>Database Name:</b> ${escapedField(event.databaseName)}\n` +
              `<b>Time:</b> ${formatEventTime(date)}` +
              (isError ? `\n\n<b>Error:</b>\n<pre>${error}</pre>` : ''),
            escapeHtml(event.errorMessage ?? ''),
          ),
        };
      }
      case 'volume-backup': {
        const isError = event.status === 'error' && event.errorMessage;
        const statusEmoji = event.status === 'success' ? '✅' : '❌';
        const typeStatus = event.status === 'success' ? 'Successful' : 'Failed';
        const sizeInfo = event.backupSize
          ? `\n<b>Backup Size:</b> ${escapedField(event.backupSize)}`
          : '';
        return {
          text: withinTextLimit(
            (error) =>
              `<b>${statusEmoji} Volume Backup ${typeStatus}</b>\n\n` +
              `<b>Project:</b> ${escapedField(event.projectName)}\n<b>Application:</b> ${escapedField(event.applicationName)}\n` +
              `<b>Volume Name:</b> ${escapedField(event.volumeName)}\n<b>Service Type:</b> ${escapedField(event.serviceType)}${sizeInfo}\n` +
              `<b>Time:</b> ${formatEventTime(date)}` +
              (isError ? `\n\n<b>Error:</b>\n<pre>${error}</pre>` : ''),
            escapeHtml(event.errorMessage ?? ''),
          ),
        };
      }
      case 'docker-cleanup':
        return {
          text:
            `<b>✅ Docker Cleanup</b>\n\n<b>Message:</b> ${escapedField(event.message)}\n` +
            `<b>Time:</b> ${formatEventTime(date)}`,
        };
      case 'server-threshold': {
        const eventDate = new Date(event.timestamp);
        // The template literal's source indentation is sent as-is, whitespace
        // and all.
        //
        // `metric` and the two numbers are not escaped and do not need to be:
        // `metric` is a two-literal union ('CPU' | 'Memory') the compiler
        // closes, and `toFixed` answers digits and a dot. The two operator-
        // supplied values are the ones that go through `escapeHtml`.
        return {
          text: `
				<b>${event.close ? '✅' : '⚠️'} ${serverThresholdTitle(event)}</b>
                <b>Server Name:</b> ${escapedField(event.serverName)}
				<b>Type:</b> ${event.metric}
				<b>Current Value:</b> ${event.value.toFixed(2)}%
				<b>Threshold:</b> ${describeServerThreshold(event)}
				<b>Message:</b> ${escapedField(event.message)}
				<b>Time:</b> ${formatEventTime(eventDate)}${serverThresholdCloseFacts(event)
          .map(({ label, value }) => `\n<b>${label}:</b> ${value}`)
          .join('')}
			`,
        };
      }
      case 'instance-backup': {
        const isError = event.status === 'error' && event.errorMessage;
        const statusEmoji = event.status === 'success' ? '✅' : '❌';
        const typeStatus = event.status === 'success' ? 'Successful' : 'Failed';
        const sizeInfo = event.backupSize
          ? `\n<b>Backup Size:</b> ${escapedField(event.backupSize)}`
          : '';
        return {
          text: withinTextLimit(
            (error) =>
              `<b>${statusEmoji} Cloudgate Backup ${typeStatus}</b>\n\n` +
              `<b>Backup Type:</b> Complete Cloudgate Instance${sizeInfo}\n` +
              `<b>Time:</b> ${formatEventTime(date)}` +
              (isError ? `\n\n<b>Error:</b>\n<pre>${error}</pre>` : ''),
            escapeHtml(event.errorMessage ?? ''),
          ),
        };
      }
      case 'license-lapse': {
        // The member lines are the reason this event carries structured members
        // rather than `Name <email>` strings: telegram parses this body as HTML
        // and refuses the whole message on an unrecognised start tag. That
        // shaped the *template* and not the values in it — a display name is
        // whatever the account holder typed, so every rendered line is escaped
        // before it is joined. The `\n` between them is markup this file
        // wrote and is joined on after the escape.
        const expiry = new Date(event.validUntil);
        const who = event.strandedMembers
          .map((person) => `• ${escapeHtml(describeStrandedMember(person))}`)
          .join('\n');
        // The list is the fifth unbounded body in this file, and the only one
        // that is not an error message: it grows with the organization, so a
        // large enough lapse refuses the whole alert on length the way a long
        // stderr does. The count above it survives the cut, so a truncated list
        // still says how many people are locked out. With nobody locked out
        // the part is left out rather than shown as a zero.
        const stopped = event.stopped
          .map((line) => `• ${escapeHtml(line)}`)
          .join('\n');
        return {
          text: withinTextLimit(
            (members) =>
              `<b>⚠️ Enterprise License Lapsed</b>\n\n` +
              `<b>Organization:</b> ${escapedField(event.organizationName)}\n` +
              `<b>Expired:</b> ${formatEventTime(expiry)}\n` +
              `<b>Stopped:</b>\n${stopped}\n` +
              (event.strandedMembers.length > 0
                ? `<b>Locked Out:</b> ${event.strandedMembers.length}\n${members}\n`
                : '') +
              `\n${escapedField(event.message)}`,
            who,
          ),
        };
      }
      case 'license-expiring': {
        // No list to cap here: every interpolation is a bounded field, escaped
        // the way the lapse's are.
        const expiry = new Date(event.validUntil);
        return {
          text:
            `<b>⏳ Enterprise License Expiring</b>\n\n` +
            `<b>Organization:</b> ${escapedField(event.organizationName)}\n` +
            `<b>Expires:</b> ${formatEventTime(expiry)}\n` +
            `<b>Days Left:</b> ${event.daysLeft}\n` +
            `\n${escapedField(event.message)}`,
        };
      }
      case 'instance-restart':
        return {
          text:
            `<b>✅ Cloudgate Server Restarted</b>\n\n` +
            `<b>Time:</b> ${formatEventTime(date)}`,
        };
      case 'preview-teardown-stuck':
        return {
          text:
            `<b>⚠️ ${PREVIEW_TEARDOWN_STUCK_TITLE}</b>\n\n` +
            previewTeardownStuckFacts(event)
              .map(
                ({ label, value }) => `<b>${label}:</b> ${escapedField(value)}`,
              )
              .join('\n') +
            `\n\n${escapedField(event.message)}`,
        };
      case 'service-incident':
        return {
          text:
            `<b>${event.state === 'opened' ? '🔴' : '🟢'} ${serviceIncidentTitle(event)}</b>\n\n` +
            serviceIncidentFacts(event)
              .map(
                ({ label, value }) => `<b>${label}:</b> ${escapedField(value)}`,
              )
              .join('\n'),
          inlineButton: event.serviceLink
            ? [[{ text: SERVICE_HEALTH_LINK_LABEL, url: event.serviceLink }]]
            : undefined,
        };
      case 'ai-model-not-answering':
        return {
          text:
            `<b>🔴 ${AI_MODEL_NOT_ANSWERING_TITLE}</b>\n\n` +
            aiModelNotAnsweringFacts(event)
              .map(
                ({ label, value }) => `<b>${label}:</b> ${escapedField(value)}`,
              )
              .join('\n') +
            `\n\n${escapedField(event.message)}`,
          inlineButton: event.aiModelLink
            ? [[{ text: AI_MODEL_LINK_LABEL, url: event.aiModelLink }]]
            : undefined,
        };
      case 'agent-rate-limited':
        return {
          text:
            `<b>⚠️ ${AGENT_RATE_LIMITED_TITLE}</b>\n\n` +
            agentRateLimitedFacts(event)
              .map(
                ({ label, value }) => `<b>${label}:</b> ${escapedField(value)}`,
              )
              .join('\n') +
            `\n\n${escapedField(event.message)}`,
          inlineButton: event.agentLink
            ? [[{ text: AGENT_ROW_LINK_LABEL, url: event.agentLink }]]
            : undefined,
        };
      default:
        return null;
    }
  }
}
