/**
 * The one way a notification prints a time for a person to read:
 * `2026-09-15 19:23:12 UTC`.
 *
 * **Why UTC and why the label.** Every channel and every email used to
 * call `Date.toLocaleString()` — or `date-fns`' `format(date, 'PP pp')`, which
 * is the same thing with a different spelling — on the backend. Both print in
 * the *server's* zone and locale and print no zone at all, so on a default
 * install (the box runs `Etc/UTC`, nothing sets `TZ`) an operator at UTC+5 read
 * `7:23:12 PM` beside Slack's own `12:23 AM` and had nothing telling them the
 * two were the same instant. A notification is rendered once and read by
 * people in any zone, so the server has no reader's zone to format in; what it
 * can do is say which zone it used. UTC is that zone because it is the only one
 * that does not depend on how the host happens to be configured — the same
 * event reads the same on every install — and the ISO-shaped date sorts and
 * parses where `9/15/2026` is ambiguous between locales.
 *
 * **One copy, because there were dozens.** The ticket's census listed the bare
 * `toLocaleString()` calls in ten files; four channels (telegram, mattermost,
 * lark, teams) also printed through `date-fns`' `format`, which it did not
 * list and which fails the same way. `test/notifications/event-time.spec.ts`
 * renders every channel's every event and requires this form on the wire, and
 * scans `src/notifications` for either call outside this file, so a new
 * channel that reaches for one is refused rather than reviewed.
 *
 * Discord is the one channel that renders the time in the *reader's* zone
 * (`<t:…>` markup, resolved by the client) and keeps doing so; the custom
 * webhook's `timestamp` stays the ISO-8601 instant it always was. Both are
 * already unambiguous and neither goes through here. Slack's `<!date^…>` would
 * do for Slack what `<t:…>` does for Discord, and was left alone on purpose:
 * every Slack time sits in a legacy attachment field, and whether a field
 * parses the markup (rather than showing it raw) has not been observed on a
 * real workspace. A labelled UTC time is correct everywhere; markup that
 * renders as source is not.
 *
 * An unparseable input — a `timestamp` or `validUntil` string that is not a
 * date — prints `unknown time` rather than throwing: `toISOString` throws a
 * `RangeError` on an invalid `Date`, and a notification that fails to render
 * is a notification nobody receives, which is worse than one field that says
 * it does not know.
 */
export function formatEventTime(at: Date | string): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}
