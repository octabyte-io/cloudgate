import { api } from "../client";

/**
 * `notifications.controller.ts` — twelve channels, one list.
 *
 * The controller is 39 routes: `POST /<channel>`, `PATCH /<channel>/:id` and
 * `POST /<channel>/test` twelve times over, plus a shared `GET /`, `GET /:id`
 * and `DELETE /:id`. **Only the channel segment varies**, so this module has one
 * of each with the segment as an argument, and the *field sets* — the sole real
 * difference between a Slack channel and an SMTP one — live in
 * `features/integrations/notifications/channels.ts` beside the form that renders
 * them. If this file ever grows a `switch` on channel name, it has been written
 * wrong.
 *
 * ---
 *
 * **The list sends no secret back.** Every connection column that holds a
 * credential is encrypted at rest, and `sanitize()` in
 * `notifications.service.ts` projects it away before the row leaves the server —
 * the way the registry, destination, AI and all four git-provider modules each
 * strip theirs.
 * Until that landed the read had no projection at all, so `GET /notifications`
 * answered with Slack webhook URLs, Telegram bot tokens, SMTP passwords and
 * Resend API keys in plain text.
 *
 * `ChannelConnection` below therefore declares **no credential field** — not as
 * a narrowing of a wider answer, but because that is the shape of the answer.
 * Two channels still need something *said* about a credential they cannot show,
 * and both say it without the value: ntfy answers `hasAccessToken`, because a
 * tokenless public topic and a private one are a difference a person has to be
 * able to see, and the custom channel answers `headerNames`, because its headers
 * are a free-form map with no fixed key to drop.
 *
 * It is also why the edit dialog starts every secret box empty, and why a
 * `PATCH` that omits one keeps the stored value.
 *
 * ---
 *
 * **A test can take credentials or an id**, and which one is right depends on
 * what you are asking.
 *
 * `POST /<channel>/test` is typed from the *connection fields*, which is the
 * right way round for a create: you prove a webhook before you save it. It was
 * the only shape there was, so "send a test through the channel I saved last
 * week" could not be said at all — and since the credential never comes back,
 * that meant a saved channel could never be tested again.
 *
 * `POST /:id/test` closes that: the server loads the row the dispatcher would
 * load, decrypts the connection and pushes the same hello probe through it. One
 * route for all twelve kinds, because the kind is on the row.
 *
 * Both live behind the one control in the form, and the difference the person
 * sees is *which credential was used*: the one they just typed, or the one
 * already stored. Nothing in either answer carries a credential back.
 */

export const CHANNEL_TYPES = [
  "slack",
  "telegram",
  "discord",
  "email",
  "resend",
  "gotify",
  "ntfy",
  "mattermost",
  "custom",
  "lark",
  "pushover",
  "teams",
] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

/**
 * The events a channel can subscribe to.
 *
 * These are **`EVENT_FLAG_COLUMNS` in `notifications/events/notification-event.ts`**,
 * one for one — the dispatcher loads `notification` rows where the matching
 * column is true and pushes the event through each channel's strategy. A tenth
 * name invented here would be a switch that turns nothing on.
 */
export const EVENT_FLAGS = [
  "appDeploy",
  "appBuildError",
  "databaseBackup",
  "volumeBackup",
  "dockerCleanup",
  "serverThreshold",
  "instanceBackup",
  "instanceRestart",
  "licenseLapse",
  "licenseExpiring",
  "agentRateLimited",
  "previewTeardownStuck",
  "serviceIncident",
  "aiModelNotAnswering",
] as const;

export type EventFlag = (typeof EVENT_FLAGS)[number];

/**
 * The non-secret half of a channel's connection row, per kind.
 *
 * **Every field a channel's form or table reads has to be named here.** Two of
 * them were not, and the two casts that stood in for them are how a backend
 * change that renamed one went through the console uncaught: the custom
 * channel's headers stopped coming back and the edit dialog silently prefilled
 * an empty table over a stored credential. A cast is an assertion the
 * compiler cannot check; a declared field is the same claim, checked.
 */
export interface ChannelConnection {
  // slack · mattermost
  channel?: string | null;
  username?: string | null;
  // telegram
  chatId?: string | null;
  messageThreadId?: string | null;
  // discord · gotify
  decoration?: boolean | null;
  // email
  smtpServer?: string | null;
  smtpPort?: number | null;
  // email · resend
  fromAddress?: string | null;
  toAddresses?: string[] | null;
  // gotify · ntfy
  serverUrl?: string | null;
  // ntfy
  topic?: string | null;
  /**
   * Whether a token is stored, in place of the token. ntfy's is the one optional
   * credential in the twelve, and dropping it outright would leave the console
   * unable to tell a public topic that needs none from a private one whose token
   * it must not see.
   */
  hasAccessToken?: boolean;
  // gotify · ntfy · pushover
  priority?: number | null;
  // pushover
  retry?: number | null;
  expire?: number | null;
  // custom
  /**
   * The custom channel's header **names**, with no values.
   *
   * The values are as much a credential as the endpoint — `Authorization` and
   * `X-API-Key` are how a webhook authenticates — so the map is encrypted at rest
   * and `sanitize()` answers with its keys alone. `headerNames.length` is the
   * count; there is no `headers` on a row, and asking for one is the bug.
   */
  headerNames?: string[];
}

/**
 * A configured channel. The connection row arrives under its own type name —
 * `row.slack`, `row.email` — which is `channelRelations` in the service.
 */
export type NotificationChannel = {
  notificationId: string;
  name: string;
  notificationType: ChannelType;
  createdAt: string;
  organizationId: string;
} & Record<EventFlag, boolean> &
  Partial<Record<ChannelType, ChannelConnection | null>>;

/** The connection row of whichever kind this channel is. */
export function channelConnection(
  row: NotificationChannel,
): ChannelConnection | null {
  return row[row.notificationType] ?? null;
}

export const notificationsApi = {
  list: () => api.get<NotificationChannel[]>("/notifications"),

  create: (type: ChannelType, body: Record<string, unknown>) =>
    api.post<NotificationChannel>(`/notifications/${type}`, body),

  /** Partial, on both halves: the name and flags, and the connection fields. */
  update: (
    type: ChannelType,
    notificationId: string,
    body: Record<string, unknown>,
  ) =>
    api.patch<NotificationChannel>(
      `/notifications/${type}/${notificationId}`,
      body,
    ),

  remove: (notificationId: string) =>
    api.delete<NotificationChannel>(`/notifications/${notificationId}`),

  /**
   * Really delivers a message through the **connection fields given here** —
   * nothing needs to be saved. This is the create case: prove the webhook, then
   * save it.
   *
   * A success is an empty **204** (it
   * used to be an empty 201, which announced a creation for a probe
   * that saves nothing); what makes it worth pressing is the refusal,
   * which carries the provider's own words (`invalid_token`, an SMTP banner, a
   * 404 from a webhook URL with a typo in it).
   */
  test: (type: ChannelType, body: Record<string, unknown>) =>
    api.post<unknown>(`/notifications/${type}/test`, body),

  /**
   * Really delivers a message through the channel **as it is saved** — the
   * server reads the row and decrypts its credential.
   *
   * This is the operational question rather than the setup one: *is the alerting
   * I configured three months ago still working?* It answers about the stored
   * connection, so anything typed into the dialog and not yet saved is not part
   * of what was tested — the dialog says so.
   *
   * No body, and no channel segment: the kind is on the row.
   */
  testSaved: (notificationId: string) =>
    api.post<unknown>(`/notifications/${notificationId}/test`),
};
