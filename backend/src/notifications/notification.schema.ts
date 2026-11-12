import { relations } from 'drizzle-orm';
import { boolean, integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import {
  encryptedJson,
  encryptedText,
  isoTimestamp,
  nanoidPk,
} from '../db/columns';
import { organization } from '../organizations/organizations.schema';

// One notification row per configured channel, event flags selecting which
// triggers fan out to it, and a per-channel connection table holding the
// delivery credentials. Tokens and webhook URLs are encrypted at rest
// (registry/destination precedent). instanceBackup/instanceRestart are the
// Cloudgate instance's own backup and restart events.
export const notificationType = pgEnum('notification_type', [
  'slack',
  'telegram',
  'discord',
  'email',
  'resend',
  'gotify',
  'ntfy',
  'mattermost',
  'pushover',
  'custom',
  'lark',
  'teams',
]);

export const notification = pgTable('notification', {
  notificationId: nanoidPk('notification_id'),
  name: text('name').notNull(),
  appDeploy: boolean('app_deploy').notNull().default(false),
  appBuildError: boolean('app_build_error').notNull().default(false),
  databaseBackup: boolean('database_backup').notNull().default(false),
  volumeBackup: boolean('volume_backup').notNull().default(false),
  instanceRestart: boolean('instance_restart').notNull().default(false),
  instanceBackup: boolean('instance_backup').notNull().default(false),
  dockerCleanup: boolean('docker_cleanup').notNull().default(false),
  serverThreshold: boolean('server_threshold').notNull().default(false),
  // The enterprise-license lapse, the one event here that no action triggers
  // (expiry is derived, so LicenseLapseService finds the transition rather than
  // being told about it).
  licenseLapse: boolean('license_lapse').notNull().default(false),
  // The same license 14 and 3 days before it lapses. Off by default,
  // like every flag, so no existing channel starts hearing about it.
  licenseExpiring: boolean('license_expiring').notNull().default(false),
  // The Agent loop signal: the first 429 of an Agent's episode. Off by default,
  // like every flag, so no existing channel starts hearing about Agents.
  agentRateLimited: boolean('agent_rate_limited').notNull().default(false),
  // The expiry sweep cannot finish tearing down Requested previews on a
  // Server, told once per episode. Off by default, like every flag.
  previewTeardownStuck: boolean('preview_teardown_stuck')
    .notNull()
    .default(false),
  // A Service's Incident opened or closed. Off by default,
  // like every flag, so no existing channel starts hearing about Incidents.
  serviceIncident: boolean('service_incident').notNull().default(false),
  // An AI model meant to be running cannot be reached through the
  // Gateway, told once per episode. Off by default, like every flag.
  aiModelNotAnswering: boolean('ai_model_not_answering')
    .notNull()
    .default(false),
  notificationType: notificationType('notification_type').notNull(),
  createdAt: isoTimestamp('created_at'),
  slackId: text('slack_id').references(() => slack.slackId, {
    onDelete: 'cascade',
  }),
  telegramId: text('telegram_id').references(() => telegram.telegramId, {
    onDelete: 'cascade',
  }),
  discordId: text('discord_id').references(() => discord.discordId, {
    onDelete: 'cascade',
  }),
  emailId: text('email_id').references(() => email.emailId, {
    onDelete: 'cascade',
  }),
  resendId: text('resend_id').references(() => resend.resendId, {
    onDelete: 'cascade',
  }),
  gotifyId: text('gotify_id').references(() => gotify.gotifyId, {
    onDelete: 'cascade',
  }),
  ntfyId: text('ntfy_id').references(() => ntfy.ntfyId, {
    onDelete: 'cascade',
  }),
  mattermostId: text('mattermost_id').references(
    () => mattermost.mattermostId,
    { onDelete: 'cascade' },
  ),
  customId: text('custom_id').references(() => custom.customId, {
    onDelete: 'cascade',
  }),
  larkId: text('lark_id').references(() => lark.larkId, {
    onDelete: 'cascade',
  }),
  pushoverId: text('pushover_id').references(() => pushover.pushoverId, {
    onDelete: 'cascade',
  }),
  teamsId: text('teams_id').references(() => teams.teamsId, {
    onDelete: 'cascade',
  }),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
});

export const slack = pgTable('slack', {
  slackId: nanoidPk('slack_id'),
  webhookUrl: encryptedText('webhook_url').notNull(),
  channel: text('channel'),
});

export const telegram = pgTable('telegram', {
  telegramId: nanoidPk('telegram_id'),
  botToken: encryptedText('bot_token').notNull(),
  chatId: text('chat_id').notNull(),
  messageThreadId: text('message_thread_id'),
});

export const discord = pgTable('discord', {
  discordId: nanoidPk('discord_id'),
  webhookUrl: encryptedText('webhook_url').notNull(),
  decoration: boolean('decoration'),
});

export const email = pgTable('email', {
  emailId: nanoidPk('email_id'),
  smtpServer: text('smtp_server').notNull(),
  smtpPort: integer('smtp_port').notNull(),
  username: text('username').notNull(),
  password: encryptedText('password').notNull(),
  fromAddress: text('from_address').notNull(),
  toAddresses: text('to_addresses').array().notNull(),
});

export const resend = pgTable('resend', {
  resendId: nanoidPk('resend_id'),
  apiKey: encryptedText('api_key').notNull(),
  fromAddress: text('from_address').notNull(),
  toAddresses: text('to_addresses').array().notNull(),
});

export const gotify = pgTable('gotify', {
  gotifyId: nanoidPk('gotify_id'),
  serverUrl: text('server_url').notNull(),
  appToken: encryptedText('app_token').notNull(),
  priority: integer('priority').notNull().default(5),
  decoration: boolean('decoration'),
});

export const ntfy = pgTable('ntfy', {
  ntfyId: nanoidPk('ntfy_id'),
  serverUrl: text('server_url').notNull(),
  topic: text('topic').notNull(),
  accessToken: encryptedText('access_token'),
  priority: integer('priority').notNull().default(3),
});

export const mattermost = pgTable('mattermost', {
  mattermostId: nanoidPk('mattermost_id'),
  webhookUrl: encryptedText('webhook_url').notNull(),
  channel: text('channel'),
  username: text('username'),
});

export const custom = pgTable('custom', {
  customId: nanoidPk('custom_id'),
  endpoint: encryptedText('endpoint').notNull(),
  // The headers are how the webhook authenticates, so they are a credential
  // beside the endpoint, not metadata — hence encrypted rather than
  // plain `jsonb`. The map is still the column's type; only the driver sees the
  // serialized ciphertext.
  headers: encryptedJson<Record<string, string>>('headers'),
});

export const lark = pgTable('lark', {
  larkId: nanoidPk('lark_id'),
  webhookUrl: encryptedText('webhook_url').notNull(),
});

export const pushover = pgTable('pushover', {
  pushoverId: nanoidPk('pushover_id'),
  userKey: encryptedText('user_key').notNull(),
  apiToken: encryptedText('api_token').notNull(),
  priority: integer('priority').notNull().default(0),
  retry: integer('retry'),
  expire: integer('expire'),
});

export const teams = pgTable('teams', {
  teamsId: nanoidPk('teams_id'),
  webhookUrl: encryptedText('webhook_url').notNull(),
});

export const notificationRelations = relations(notification, ({ one }) => ({
  slack: one(slack, {
    fields: [notification.slackId],
    references: [slack.slackId],
  }),
  telegram: one(telegram, {
    fields: [notification.telegramId],
    references: [telegram.telegramId],
  }),
  discord: one(discord, {
    fields: [notification.discordId],
    references: [discord.discordId],
  }),
  email: one(email, {
    fields: [notification.emailId],
    references: [email.emailId],
  }),
  resend: one(resend, {
    fields: [notification.resendId],
    references: [resend.resendId],
  }),
  gotify: one(gotify, {
    fields: [notification.gotifyId],
    references: [gotify.gotifyId],
  }),
  ntfy: one(ntfy, {
    fields: [notification.ntfyId],
    references: [ntfy.ntfyId],
  }),
  mattermost: one(mattermost, {
    fields: [notification.mattermostId],
    references: [mattermost.mattermostId],
  }),
  custom: one(custom, {
    fields: [notification.customId],
    references: [custom.customId],
  }),
  lark: one(lark, {
    fields: [notification.larkId],
    references: [lark.larkId],
  }),
  pushover: one(pushover, {
    fields: [notification.pushoverId],
    references: [pushover.pushoverId],
  }),
  teams: one(teams, {
    fields: [notification.teamsId],
    references: [teams.teamsId],
  }),
  organization: one(organization, {
    fields: [notification.organizationId],
    references: [organization.id],
  }),
}));

export type Notification = typeof notification.$inferSelect;
export type NotificationType = (typeof notificationType.enumValues)[number];
export type SlackConnection = typeof slack.$inferSelect;
export type TelegramConnection = typeof telegram.$inferSelect;
export type DiscordConnection = typeof discord.$inferSelect;
export type EmailConnection = typeof email.$inferSelect;
export type ResendConnection = typeof resend.$inferSelect;
export type GotifyConnection = typeof gotify.$inferSelect;
export type NtfyConnection = typeof ntfy.$inferSelect;
export type MattermostConnection = typeof mattermost.$inferSelect;
export type CustomConnection = typeof custom.$inferSelect;
export type LarkConnection = typeof lark.$inferSelect;
export type PushoverConnection = typeof pushover.$inferSelect;
export type TeamsConnection = typeof teams.$inferSelect;

/** The relation set that hydrates a notification row with its connection. */
export const channelRelations = {
  slack: true,
  telegram: true,
  discord: true,
  email: true,
  resend: true,
  gotify: true,
  ntfy: true,
  mattermost: true,
  custom: true,
  lark: true,
  pushover: true,
  teams: true,
} as const;

/** A notification row hydrated with its channel connection. */
export type NotificationWithChannels = Notification & {
  slack: SlackConnection | null;
  telegram: TelegramConnection | null;
  discord: DiscordConnection | null;
  email: EmailConnection | null;
  resend: ResendConnection | null;
  gotify: GotifyConnection | null;
  ntfy: NtfyConnection | null;
  mattermost: MattermostConnection | null;
  custom: CustomConnection | null;
  lark: LarkConnection | null;
  pushover: PushoverConnection | null;
  teams: TeamsConnection | null;
};
