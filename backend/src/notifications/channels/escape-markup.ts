/**
 * Escapes for operator-typed values interpolated into a channel's markup.
 * The rule: a value is escaped at the channel, the only place
 * that knows what its payload is parsed as — telegram's HTML has its own
 * `escapeHtml` in `telegram.strategy.ts`.
 *
 * So far only the rate-limited Agent's name and Organization go through these.
 * The older events interpolate names raw on these channels, which renders a
 * `*` as emphasis rather than refusing a message — a cosmetic slip, unlike
 * telegram's, and left as it was found.
 */

/**
 * Slack's `mrkdwn`: the three characters Slack's own formatting guide says to
 * escape. `<` is the one that matters — `<!channel>` pages everyone in it and
 * `<https://…|text>` is a link the sender did not write.
 */
export const escapeSlack = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The markdown the chat channels render (discord, mattermost, teams, lark):
 * a backslash before each character that opens emphasis, code, a link, a
 * quote, a heading or a table, so `[x](https://…)` stays text rather than
 * becoming a link that reads as ours.
 */
export const escapeMarkdown = (value: string): string =>
  value.replace(/[\\`*_~|[\]()>#]/g, '\\$&');
