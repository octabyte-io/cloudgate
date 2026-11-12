import { z, type ZodRawShape } from "zod";

import { example, type FieldSpec } from "@/components/console/form-spec";
import type { TestSecret } from "@/components/console/resource-spec";
import type {
  ChannelConnection,
  ChannelType,
  EventFlag,
} from "@/lib/api/endpoints/notifications";
import { EVENT_FLAGS } from "@/lib/api/endpoints/notifications";
import type { IconName } from "@/lib/design/icons";

/**
 * **The twelve channels, as data.**
 *
 * `notifications.controller.ts` is 39 routes, and the phase brief is explicit
 * about the trap: built literally it is twelve create forms, twelve edit forms
 * and twelve test buttons that drift apart inside one phase. They do not differ
 * in any way a *person* can see except **which fields they ask for** — the name,
 * the eight event switches, the create/update/test calls and every piece of copy
 * around them are identical.
 *
 * So this file is one entry per channel and there is exactly one form. Nothing
 * else under `features/integrations/notifications/` names a channel at all.
 *
 * ---
 *
 * **What varies, and what does not.**
 *
 * - **Fields** vary. Slack is a URL, email is six fields including a list of
 *   addresses, custom is a URL and a table of headers.
 * - **Secrets** vary in *which* field they are and in whether the channel works
 *   without one, not in how they behave: every one is encrypted at rest —
 *   `encryptedText`, or `encryptedJson` for the custom channel's header map, the
 *   one credential that is not a single string
 *   — none is
 *   rendered back, and an empty box on an edit means "keep the stored
 *   one". `secrets` names them so the shared update path can omit an empty one —
 *   the omission is the whole mechanism, since a `PATCH` that does not mention a
 *   column leaves it exactly as it was — and marks the one that is genuinely
 *   optional, so a test on an add is not refused for a credential ntfy's public
 *   server never wanted.
 * - **Events do not vary at all.** All eight flags are on the base
 *   `notification` row and every channel's create DTO extends the same
 *   `eventFlagsSchema`, which answers the brief's endpoint question: **event
 *   subscriptions are part of the create body, not a separate call.**
 *
 * **The icons group by transport**, not by brand: a room you post into, an
 * inbox, a device that buzzes, or a URL of your own. Twelve brand glyphs would
 * be twelve pieces of decoration; four say something true about what happens
 * when the event fires. The provider's own name is right beside it in bold.
 */

export type ChannelValues = {
  name: string;
} & Record<EventFlag, boolean> &
  Record<string, unknown>;

export type ChannelDescriptor = {
  type: ChannelType;
  /** The provider's own name, spelled the way the provider spells it. */
  label: string;
  icon: IconName;
  /** One line on the pick card. What it is, not how to configure it. */
  blurb: string;
  /** The connection fields, in form order. */
  fields: FieldSpec<ChannelValues>[];
  /** The connection half of the schema. `name` and the flags are shared. */
  shape: ZodRawShape;
  /** A rule across two of this channel's fields. One channel has one. */
  check?: (values: ChannelValues, ctx: z.RefinementCtx) => void;
  /** Form values for the connection half, from a stored row or from nothing. */
  toDefaults: (connection: ChannelConnection | null) => Record<string, unknown>;
  /** The connection half of the body a create, an update or a test sends. */
  toBody: (values: ChannelValues) => Record<string, unknown>;
  /**
   * Which of this channel's fields are credentials, and which of those the
   * channel cannot be reached without. See the note above.
   */
  secrets: TestSecret[];
  /** The table's second column. **Never a secret.** */
  summary: (connection: ChannelConnection | null) => string;
};

// ---------------------------------------------------------------------------
// Converters. A form field is a string; a column is a string, a number, a text
// array or a JSON object. These four are the whole of that translation.
// ---------------------------------------------------------------------------

/** `""` → left out. For a **credential**, where empty means "keep the stored one". */
function keep(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A trimmed string, `""` included.
 *
 * For a **non-secret optional**, where empty has to reach the backend or a
 * channel override could be set and never cleared again. F10's "an empty
 * optional is `undefined` when creating and `null` when updating" does not apply
 * here: these columns are `z.string().optional()` on both DTOs, which refuses a
 * null, and every strategy reads them for truthiness.
 */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A number field, or `undefined` when the box was left empty. */
function count(value: unknown): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** One address per line, blanks dropped — `toAddresses` is a text array. */
function lines(value: unknown): string[] {
  return String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * A `rows` field of key/value pairs back into the JSON object the column holds —
 * or **left out entirely**, when the table is the one the dialog opened with.
 *
 * `keep()` above is this same rule for a single string, and it works for the same
 * reason: `undefined` is dropped from the body, and a `PATCH` that never mentions
 * a column leaves it exactly as it was. The custom channel's headers are one
 * credential in the shape of a map — encrypted at rest, answered as
 * `headerNames` with no values — so the value boxes open blank exactly as a
 * password box does, and blank has to mean "keep".
 *
 * What a map costs that a string does not is that **it is written all at once**.
 * `{}` is a real answer meaning "no headers at all", so it cannot double as
 * "keep", and a value nobody retyped cannot be merged back in from here: this
 * console does not hold it. So there are exactly two outcomes:
 *
 * - **The table untouched** — every value blank, and the same names it opened
 *   with. Left out, and the stored headers stay. This is the PATCH that changes
 *   only the channel's name, which used to arrive as `{}` and wipe them.
 * - **Anything typed, added or removed** — the table as it stands is the whole
 *   set. A row whose value was never filled in is *dropped* rather than written
 *   blank, so a half-retyped table loses that header visibly — the card's count
 *   falls — instead of leaving a live-looking `Authorization: ` behind it. The
 *   field's hint says so before it happens.
 */
function headerMap(
  value: unknown,
  storedNames: unknown,
): Record<string, string> | undefined {
  const rows = Array.isArray(value)
    ? (value as Array<{ key?: string; value?: string }>)
    : [];
  // A row with no name is not a header, whatever is in its value box.
  const named = rows
    .map((row) => ({
      key: (row.key ?? "").trim(),
      value: (row.value ?? "").trim(),
    }))
    .filter((row) => row.key !== "");

  const stored = Array.isArray(storedNames) ? (storedNames as string[]) : [];
  const names = named.map((row) => row.key);
  const untouched =
    named.every((row) => row.value === "") &&
    names.length === stored.length &&
    [...names].sort().join("\n") === [...stored].sort().join("\n");
  if (untouched) return undefined;

  const out: Record<string, string> = {};
  for (const row of named) if (row.value !== "") out[row.key] = row.value;
  return out;
}

/**
 * The stored header names as rows with blank values — the names that are
 * configured, and a box per value to retype or to leave alone.
 *
 * `headerNames` is all a read answers with, so this is the table's version
 * of `SECRET_HINT`'s empty password box: it says *which* headers are set without
 * saying what they are, where an empty table would have said there are none.
 */
function headerRows(
  names: string[] | null | undefined,
): Array<{ key: string; value: string }> {
  return (names ?? []).map((key) => ({ key, value: "" }));
}

/**
 * A whole number the box may be left empty for, and empty has two spellings:
 * `""` from `toDefaults` on a row with none, and `undefined` once the box has
 * been typed in and emptied — a number field hands its schema a number or
 * nothing. Both are a real answer. This is the one that covers
 * Pushover's retry and expire, which is why a grep for `z.coerce` finds five
 * for this file's six number fields.
 */
const optionalInt = (min: number, max: number, message: string) =>
  z.union([
    z.literal(""),
    z.undefined(),
    z.coerce.number().int().min(min, message).max(max, message),
  ]);

/** A hostname, for the table. Falls back to the whole string. */
function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// The pieces several channels share, so a webhook reads the same on all five.
// ---------------------------------------------------------------------------

const SECRET_HINT =
  "Stored encrypted and never shown again. Leave it empty when editing to keep the one already saved.";

const webhookField = (placeholder: string): FieldSpec<ChannelValues> => ({
  name: "webhookUrl",
  label: "Webhook URL",
  kind: "password",
  placeholder,
  hint: SECRET_HINT,
});

/** A webhook URL is a credential: whoever holds it can post as you. */
const webhookOnly = {
  shape: { webhookUrl: z.string() } satisfies ZodRawShape,
  secrets: [
    { name: "webhookUrl", label: "the webhook URL", required: true },
  ] satisfies TestSecret[],
  toDefaults: () => ({ webhookUrl: "" }),
  toBody: (values: ChannelValues) => ({ webhookUrl: keep(values.webhookUrl) }),
};

const addressFields = (): FieldSpec<ChannelValues>[] => [
  {
    name: "fromAddress",
    label: "From",
    kind: "text",
    placeholder: "cloudgate@example.com",
  },
  {
    name: "toAddresses",
    label: "To",
    kind: "lines",
    rows: 3,
    placeholder: "ops@example.com\non-call@example.com",
    hint: "One address per line.",
  },
];

const addressShape = {
  fromAddress: z.string().min(1, "A sender address is needed."),
  toAddresses: z.string().min(1, "At least one recipient is needed."),
};

// ---------------------------------------------------------------------------
// The events. Identical on every channel, so they are declared once.
// ---------------------------------------------------------------------------

/**
 * The twelve events, as switches.
 *
 * These names are `EVENT_FLAG_COLUMNS` in `notifications/events/notification-event.ts`,
 * one for one — a flag invented here would be a switch that turns nothing on.
 * The sentences say **what fires the event**, because "tell me about deploys" is
 * not information and the difference between the first two is exactly what
 * somebody needs to know before choosing.
 */
const EVENT_LABELS: Record<EventFlag, { label: string; hint: string }> = {
  appDeploy: {
    label: "A Deployment succeeded",
    hint: "Fires when a build finishes and the service is running. Carries the Project, the Environment and the domains it answers on.",
  },
  appBuildError: {
    label: "A Deployment failed",
    hint: "Fires when a build errors, with the message the builder printed.",
  },
  databaseBackup: {
    label: "A database backup ran",
    hint: "Both outcomes — a dump that was written, and one that was not.",
  },
  volumeBackup: {
    label: "A volume backup ran",
    hint: "Both outcomes, with the archive's size when there is one.",
  },
  dockerCleanup: {
    label: "Docker cleanup ran",
    hint: "The scheduled prune of unused images, containers and volumes.",
  },
  serverThreshold: {
    label: "A Server crossed a threshold",
    hint: "CPU or memory past the limit set on that Server's own monitoring. The one event here about a machine rather than a Deployment.",
  },
  instanceBackup: {
    label: "Cloudgate backed itself up",
    hint: "The instance's own backup. Nothing fires this yet — the feature it belongs to is not built.",
  },
  instanceRestart: {
    label: "Cloudgate restarted",
    hint: "Fires from this instance's own start-up, which is also how you find out it went down.",
  },
  licenseLapse: {
    label: "An enterprise license lapsed",
    hint: "Fires once when a license's expiry passes, listing what stopped: SSO sign-in, SCIM adds, forward-auth changes, custom roles, white-labelling edits, and parallel builds and Cloud runs. Names anyone still on a custom role — they are refused every permission-checked action until a license is active again, and nobody is moved onto a static role automatically, because the member role would grant them more, not less.",
  },
  licenseExpiring: {
    label: "An enterprise license is about to expire",
    hint: "Fires once 14 days and once 3 days before a license's expiry date, naming the date and what stops on it. The owners also get an email at both points when this instance can send mail. A renewal reaches the instance on its own, through the daily re-check.",
  },
  agentRateLimited: {
    label: "An Agent was rate limited",
    hint: "Fires at the first refused call of an Agent that ran out of its rate budget, then stays quiet until it has gone an hour without one. Names the Agent, its budget and key, and links to its row, where Suspend stops it.",
  },
  previewTeardownStuck: {
    label: "Requested previews could not be torn down",
    hint: "Fires once when expired requested previews on a Server have been retried for fifteen minutes and their copies are still there, then stays quiet until that Server has none left. Names the Server and the Applications whose preview slots stay taken until the copies are gone.",
  },
  serviceIncident: {
    label: "Service incidents",
    hint: "Fires once when a Service's Uptime check has failed enough times in a row to open an Incident, and once when the Incident closes, saying whether it recovered, the Service was stopped or the check was turned off. Names the Service, the Domain it checks and the error, and links to its Health tab.",
  },
  aiModelNotAnswering: {
    label: "An AI model is not answering",
    hint: "Fires once when a call through the gateway cannot reach an AI model that should be running, then stays quiet until a call gets through. A Stop and a caller's own mistakes never fire it. Names the AI model, its model and machine, and links to its Model tab.",
  },
};

export const EVENT_FIELDS: FieldSpec<ChannelValues>[] = [
  {
    name: "__events",
    label: "Send this channel",
    kind: "section",
    hint: "A channel with nothing ticked is configured and silent.",
  },
  ...EVENT_FLAGS.map(
    (flag): FieldSpec<ChannelValues> => ({
      name: flag,
      label: EVENT_LABELS[flag].label,
      hint: EVENT_LABELS[flag].hint,
      kind: "switch",
    }),
  ),
];

// ---------------------------------------------------------------------------
// The table.
// ---------------------------------------------------------------------------

export const CHANNELS: ChannelDescriptor[] = [
  {
    type: "slack",
    label: "Slack",
    icon: "hash",
    blurb: "An incoming webhook posts into one Slack channel.",
    fields: [
      webhookField("https://hooks.slack.com/services/…"),
      {
        name: "channel",
        label: "Channel override",
        kind: "text",
        optional: true,
        placeholder: example("deploys"),
        hint: "Only some webhook kinds honour this. Leave it empty to post where the webhook already points.",
      },
    ],
    shape: { ...webhookOnly.shape, channel: z.string() },
    secrets: webhookOnly.secrets,
    toDefaults: (connection) => ({
      webhookUrl: "",
      channel: connection?.channel ?? "",
    }),
    toBody: (values) => ({
      ...webhookOnly.toBody(values),
      channel: text(values.channel),
    }),
    summary: (connection) =>
      connection?.channel
        ? `#${connection.channel}`
        : "Wherever the webhook points",
  },

  {
    type: "discord",
    label: "Discord",
    icon: "hash",
    blurb: "A channel webhook, with an embed per event.",
    fields: [
      webhookField("https://discord.com/api/webhooks/…"),
      {
        name: "decoration",
        label: "Decorate the message",
        kind: "switch",
        hint: "Colors the embed by outcome and adds an emoji. Off is plain text.",
      },
    ],
    shape: { ...webhookOnly.shape, decoration: z.boolean() },
    secrets: webhookOnly.secrets,
    toDefaults: (connection) => ({
      webhookUrl: "",
      decoration: connection?.decoration ?? true,
    }),
    toBody: (values) => ({
      ...webhookOnly.toBody(values),
      decoration: Boolean(values.decoration),
    }),
    summary: (connection) =>
      connection?.decoration === false ? "Plain messages" : "Decorated messages",
  },

  {
    type: "mattermost",
    label: "Mattermost",
    icon: "hash",
    blurb: "An incoming webhook, optionally posting as its own name.",
    fields: [
      webhookField("https://mattermost.example.com/hooks/…"),
      {
        name: "channel",
        label: "Channel override",
        kind: "text",
        optional: true,
        placeholder: example("deploys"),
        hint: "Without the #. Leave it empty to post where the webhook already points.",
      },
      {
        name: "username",
        label: "Post as",
        kind: "text",
        optional: true,
        placeholder: example("Cloudgate"),
      },
    ],
    // The one DTO in the twelve that is `z.url()` rather than a non-empty
    // string, so a value without a scheme is refused by the backend. Said here
    // as well, or the refusal arrives after the dialog has been filled in.
    shape: {
      webhookUrl: z.string(),
      channel: z.string(),
      username: z.string(),
    },
    secrets: webhookOnly.secrets,
    toDefaults: (connection) => ({
      webhookUrl: "",
      channel: connection?.channel ?? "",
      username: connection?.username ?? "",
    }),
    toBody: (values) => ({
      ...webhookOnly.toBody(values),
      channel: text(values.channel),
      username: text(values.username),
    }),
    summary: (connection) =>
      connection?.channel
        ? `#${connection.channel}`
        : "Wherever the webhook points",
  },

  {
    type: "teams",
    label: "Microsoft Teams",
    icon: "hash",
    blurb: "An incoming webhook posting an adaptive card.",
    fields: [webhookField("https://outlook.office.com/webhook/…")],
    ...webhookOnly,
    // Nothing to show. The webhook URL is this channel's only field and it is a
    // credential, so the table says so rather than printing it — which is the
    // rule made visible rather than stated in a doc nobody reads.
    summary: () => "",
  },

  {
    type: "lark",
    label: "Lark",
    icon: "hash",
    blurb: "A Lark (Feishu) group bot webhook.",
    fields: [webhookField("https://open.larksuite.com/open-apis/bot/v2/hook/…")],
    ...webhookOnly,
    summary: () => "",
  },

  {
    type: "email",
    label: "Email over SMTP",
    icon: "mail",
    blurb: "Your own SMTP server. Nothing leaves your network but the mail.",
    fields: [
      {
        name: "smtpServer",
        label: "SMTP server",
        kind: "text",
        mono: true,
        placeholder: "smtp.example.com",
      },
      {
        name: "smtpPort",
        label: "Port",
        kind: "number",
        min: 1,
        max: 65535,
        placeholder: example("587"),
      },
      { name: "username", label: "Username", kind: "text" },
      {
        name: "password",
        label: "Password",
        kind: "password",
        hint: SECRET_HINT,
      },
      ...addressFields(),
    ],
    shape: {
      smtpServer: z.string().min(1, "An SMTP server is needed."),
      smtpPort: z.coerce
        .number()
        .int()
        .min(1, "A port is a number between 1 and 65535.")
        .max(65535, "A port is a number between 1 and 65535."),
      username: z.string().min(1, "A username is needed."),
      password: z.string(),
      ...addressShape,
    },
    secrets: [{ name: "password", label: "the password", required: true }],
    toDefaults: (connection) => ({
      smtpServer: connection?.smtpServer ?? "",
      smtpPort: connection?.smtpPort ?? 587,
      username: connection?.username ?? "",
      password: "",
      fromAddress: connection?.fromAddress ?? "",
      toAddresses: (connection?.toAddresses ?? []).join("\n"),
    }),
    toBody: (values) => ({
      smtpServer: text(values.smtpServer),
      smtpPort: count(values.smtpPort),
      username: text(values.username),
      password: keep(values.password),
      fromAddress: text(values.fromAddress),
      toAddresses: lines(values.toAddresses),
    }),
    summary: (connection) =>
      connection?.smtpServer
        ? `${connection.smtpServer}:${connection.smtpPort ?? ""}`
        : "",
  },

  {
    type: "resend",
    label: "Resend",
    icon: "mail",
    blurb: "Resend's API, so there is no SMTP server to run.",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        kind: "password",
        placeholder: "re_…",
        hint: SECRET_HINT,
      },
      ...addressFields(),
    ],
    shape: { apiKey: z.string(), ...addressShape },
    secrets: [{ name: "apiKey", label: "the API key", required: true }],
    toDefaults: (connection) => ({
      apiKey: "",
      fromAddress: connection?.fromAddress ?? "",
      toAddresses: (connection?.toAddresses ?? []).join("\n"),
    }),
    toBody: (values) => ({
      apiKey: keep(values.apiKey),
      fromAddress: text(values.fromAddress),
      toAddresses: lines(values.toAddresses),
    }),
    summary: (connection) => connection?.fromAddress ?? "",
  },

  {
    type: "telegram",
    label: "Telegram",
    icon: "zap",
    blurb: "A bot messages one chat, with buttons to the domains it deployed.",
    fields: [
      {
        name: "botToken",
        label: "Bot token",
        kind: "password",
        placeholder: "123456:ABC-DEF…",
        hint: SECRET_HINT,
      },
      {
        name: "chatId",
        label: "Chat ID",
        kind: "text",
        mono: true,
        placeholder: "-1001234567890",
        hint: "A group's ID is negative. Ask @userinfobot, or read it off getUpdates.",
      },
      {
        name: "messageThreadId",
        label: "Topic ID",
        kind: "text",
        mono: true,
        optional: true,
        hint: "Only for a group with topics turned on.",
      },
    ],
    shape: {
      botToken: z.string(),
      chatId: z.string().min(1, "A chat ID is needed."),
      messageThreadId: z.string(),
    },
    secrets: [{ name: "botToken", label: "the bot token", required: true }],
    toDefaults: (connection) => ({
      botToken: "",
      chatId: connection?.chatId ?? "",
      messageThreadId: connection?.messageThreadId ?? "",
    }),
    toBody: (values) => ({
      botToken: keep(values.botToken),
      chatId: text(values.chatId),
      messageThreadId: text(values.messageThreadId),
    }),
    summary: (connection) => connection?.chatId ?? "",
  },

  {
    type: "gotify",
    label: "Gotify",
    icon: "zap",
    blurb: "A self-hosted push server. One app token per sender.",
    fields: [
      {
        name: "serverUrl",
        label: "Server URL",
        kind: "text",
        mono: true,
        placeholder: "https://gotify.example.com",
      },
      {
        name: "appToken",
        label: "App token",
        kind: "password",
        hint: SECRET_HINT,
      },
      {
        name: "priority",
        label: "Priority",
        kind: "number",
        min: 1,
        max: 10,
        hint: "Gotify's own scale. 8 and up is what makes a phone ring.",
      },
      {
        name: "decoration",
        label: "Decorate the message",
        kind: "switch",
        hint: "Adds an emoji and a heading. Off is plain text.",
      },
    ],
    shape: {
      serverUrl: z.string().min(1, "A server URL is needed."),
      appToken: z.string(),
      priority: z.coerce.number().int().min(1, "Priority starts at 1."),
      decoration: z.boolean(),
    },
    secrets: [{ name: "appToken", label: "the app token", required: true }],
    toDefaults: (connection) => ({
      serverUrl: connection?.serverUrl ?? "",
      appToken: "",
      priority: connection?.priority ?? 5,
      decoration: connection?.decoration ?? true,
    }),
    toBody: (values) => ({
      serverUrl: text(values.serverUrl),
      appToken: keep(values.appToken),
      priority: count(values.priority),
      decoration: Boolean(values.decoration),
    }),
    summary: (connection) => hostOf(connection?.serverUrl),
  },

  {
    type: "ntfy",
    label: "ntfy",
    icon: "zap",
    blurb: "Publish to a topic. The public server needs no account.",
    fields: [
      {
        name: "serverUrl",
        label: "Server URL",
        kind: "text",
        mono: true,
        placeholder: "https://ntfy.sh",
      },
      {
        name: "topic",
        label: "Topic",
        kind: "text",
        mono: true,
        placeholder: example("cloudgate-deploys"),
        hint: "On a public server the topic name is the only thing keeping this private. Make it unguessable.",
      },
      {
        name: "accessToken",
        label: "Access token",
        kind: "password",
        optional: true,
        hint: "Only for a server with authentication turned on. " + SECRET_HINT,
      },
      {
        name: "priority",
        label: "Priority",
        kind: "number",
        min: 1,
        max: 5,
        hint: "1 is silent, 3 is default, 5 breaks through a phone's do-not-disturb.",
      },
    ],
    shape: {
      serverUrl: z.string().min(1, "A server URL is needed."),
      topic: z.string().min(1, "A topic is needed."),
      accessToken: z.string(),
      priority: z.coerce
        .number()
        .int()
        .min(1, "Priority is 1 to 5.")
        .max(5, "Priority is 1 to 5."),
    },
    // **The one optional credential in the twelve**. ntfy.sh publishes to a
    // public topic with no account at all, so a token nobody typed is the normal
    // answer here rather than a field left out — and a test on an add has to run
    // without it, or a public topic cannot be proved before it is saved.
    secrets: [
      { name: "accessToken", label: "the access token", required: false },
    ],
    toDefaults: (connection) => ({
      serverUrl: connection?.serverUrl ?? "https://ntfy.sh",
      topic: connection?.topic ?? "",
      accessToken: "",
      priority: connection?.priority ?? 3,
    }),
    toBody: (values) => ({
      serverUrl: text(values.serverUrl),
      topic: text(values.topic),
      accessToken: keep(values.accessToken),
      priority: count(values.priority),
    }),
    summary: (connection) =>
      connection?.topic ? `${hostOf(connection.serverUrl)}/${connection.topic}` : "",
  },

  {
    type: "pushover",
    label: "Pushover",
    icon: "zap",
    blurb: "Push to your own devices, with a priority that keeps retrying.",
    fields: [
      {
        name: "userKey",
        label: "User key",
        kind: "password",
        hint: SECRET_HINT,
      },
      {
        name: "apiToken",
        label: "API token",
        kind: "password",
        hint: SECRET_HINT,
      },
      {
        name: "priority",
        label: "Priority",
        kind: "number",
        min: -2,
        max: 2,
        hint: "−2 is silent, 0 is normal, 1 bypasses quiet hours, 2 is emergency and keeps retrying until somebody acknowledges it.",
      },
      {
        name: "retry",
        label: "Retry every",
        kind: "number",
        min: 30,
        max: 10800,
        optional: true,
        placeholder: example("60"),
        hint: "Seconds. 30 at the least. Only used at priority 2.",
        when: (values) => Number(values.priority) === 2,
      },
      {
        name: "expire",
        label: "Give up after",
        kind: "number",
        min: 1,
        max: 10800,
        optional: true,
        placeholder: example("3600"),
        hint: "Seconds, up to 10800 (three hours). Only used at priority 2.",
        when: (values) => Number(values.priority) === 2,
      },
    ],
    shape: {
      userKey: z.string(),
      apiToken: z.string(),
      priority: z.coerce
        .number()
        .int()
        .min(-2, "Priority is −2 to 2.")
        .max(2, "Priority is −2 to 2."),
      retry: optionalInt(30, 10800, "Retry is 30 to 10800 seconds."),
      expire: optionalInt(1, 10800, "Expire is 1 to 10800 seconds."),
    },
    // Pushover's own rule, and the backend enforces it with a `refine` whose
    // path is `retry` — said here too, so the refusal arrives while the two
    // fields are on screen rather than after the save.
    check: (values, ctx) => {
      if (Number(values.priority) !== 2) return;
      if (count(values.retry) === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["retry"],
          message: "Emergency priority keeps retrying, so it needs an interval.",
        });
      }
      if (count(values.expire) === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["expire"],
          message: "Emergency priority needs a point at which it gives up.",
        });
      }
    },
    secrets: [
      { name: "userKey", label: "the user key", required: true },
      { name: "apiToken", label: "the API token", required: true },
    ],
    toDefaults: (connection) => ({
      userKey: "",
      apiToken: "",
      priority: connection?.priority ?? 0,
      retry: connection?.retry ?? "",
      expire: connection?.expire ?? "",
    }),
    toBody: (values) => ({
      userKey: keep(values.userKey),
      apiToken: keep(values.apiToken),
      priority: count(values.priority),
      retry: count(values.retry) ?? null,
      expire: count(values.expire) ?? null,
    }),
    summary: (connection) =>
      connection?.priority === 2
        ? "Emergency priority"
        : `Priority ${connection?.priority ?? 0}`,
  },

  {
    type: "custom",
    label: "Custom webhook",
    icon: "globe",
    blurb: "Cloudgate POSTs the event to a URL of yours, as JSON.",
    fields: [
      {
        name: "endpoint",
        label: "Endpoint",
        kind: "password",
        placeholder: "https://hooks.example.com/cloudgate",
        hint:
          "Cloudgate POSTs the event here as JSON. " + SECRET_HINT,
      },
      {
        name: "headers",
        label: "Headers",
        kind: "rows",
        addLabel: "Add a header",
        emptyLabel: "No extra headers. Add one to carry an API key or a signature.",
        columns: [
          { name: "key", label: "Name", kind: "text", placeholder: example("Authorization") },
          { name: "value", label: "Value", kind: "text", placeholder: "Bearer …" },
        ],
        hint: "Sent with every request. Values are encrypted at rest and never sent back, so the boxes open empty — leave the table as it is to keep the headers already saved. Change anything in it and it replaces the whole set, so retype every value you mean to keep.",
      },
    ],
    shape: {
      endpoint: z.string(),
      headers: z.array(z.object({ key: z.string(), value: z.string() })),
      /**
       * The header names as the dialog opened with them. **Not a control** — no
       * `FieldSpec` names it, so nothing renders it, and `toBody` does not send
       * it; it is in the schema because that is what puts it in the values
       * `toBody` is handed, the same trick `notificationId` uses in
       * `channel-spec.tsx`. `headerMap` needs it to tell a table nobody touched
       * from one deliberately emptied, and those two mean opposite things.
       */
      headerNames: z.array(z.string()),
    },
    // Both halves are credentials at rest: the endpoint is `encryptedText` and
    // often carries a token in its path, which is why it is a password field
    // rather than a text one, and the header map is `encryptedJson` beside it.
    // Only the endpoint is named here, because `secrets` is what the dialog
    // counts filled-in *boxes* with — one string each — and the headers are a
    // `rows` field whose value is an array, which `testCredentials` reads as
    // permanently blank. Declared here it would turn the test button off on every
    // add and make "test what is typed, or test what is saved" unanswerable on an
    // edit. The headers behave as a credential everywhere it matters anyway: blank
    // boxes on an edit, omitted from a PATCH that did not touch them, never
    // rendered back. What it costs is that a test sent with what is typed here
    // carries only the headers typed here — clear the endpoint too and the test
    // goes through the saved channel instead, headers and all.
    secrets: [{ name: "endpoint", label: "the endpoint", required: true }],
    toDefaults: (connection) => ({
      endpoint: "",
      headers: headerRows(connection?.headerNames),
      headerNames: connection?.headerNames ?? [],
    }),
    toBody: (values) => ({
      endpoint: keep(values.endpoint),
      headers: headerMap(values.headers, values.headerNames),
    }),
    summary: (connection) => {
      // The names come back, the values do not, so the count is a count of
      // names — and it is the whole of what this column can say about them.
      const size = connection?.headerNames?.length ?? 0;
      return size === 0
        ? "No extra headers"
        : size === 1
          ? "1 extra header"
          : `${size} extra headers`;
    },
  },
];

export function channelOf(type: ChannelType): ChannelDescriptor {
  const found = CHANNELS.find((channel) => channel.type === type);
  // Every `notificationType` the enum has is in the table above, so this is
  // unreachable — but a row from a future enum value must not take the page
  // down with it.
  if (!found) throw new Error(`Unknown notification channel: ${type}`);
  return found;
}
