import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';

/**
 * Whether a `user` row is a person or an **Agent** (CONTEXT.md, ADR-0023).
 *
 * Declared in the data rather than inferred from the absence of a sign-in
 * method: an Agent has no `account` row, but neither does a SCIM
 * tombstone (ADR-0022), and "no password" is a fact about today's rows rather
 * than a statement of what the row is. Every rule that treats an Agent
 * differently reads this column through `isAgentUser` (`user-kind.ts`), and it
 * is written once, by `AgentsService.create`: better-auth never writes it, so
 * every user better-auth creates takes the default.
 */
export const userKind = pgEnum('user_kind', ['human', 'agent']);

// better-auth auth tables (drizzle adapter). better-auth's `name` field is
// mapped to the `firstName` column in auth.config.ts.
export const user = pgTable('user', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => nanoid()),
  firstName: text('firstName').notNull().default(''),
  lastName: text('lastName').notNull().default(''),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  // twoFactor plugin
  twoFactorEnabled: boolean('two_factor_enabled'),
  // admin plugin
  role: text('role').notNull().default('user'),
  banned: boolean('banned'),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
  // Enterprise SSO: origins an organization's owner has allowlisted, which is
  // where an internal IdP's issuer has to be listed for the SSO plugin to
  // fetch it.
  trustedOrigins: text('trustedOrigins').array(),
  // A person or an Agent — see `userKind` above.
  kind: userKind('kind').notNull().default('human'),
});

export const account = pgTable('account', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => nanoid()),
  accountId: text('account_id')
    .notNull()
    .$defaultFn(() => nanoid()),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  // admin plugin
  impersonatedBy: text('impersonated_by'),
  // organization plugin (teams enabled)
  activeOrganizationId: text('active_organization_id'),
  activeTeamId: text('active_team_id'),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

export const twoFactor = pgTable('two_factor', {
  id: text('id').primaryKey(),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  // better-auth >=1.6 tracks TOTP verification state and sign-in lockout
  // on the twoFactor model; enable/verify write these columns.
  verified: boolean('verified'),
  failedVerificationCount: integer('failed_verification_count'),
  lockedUntil: timestamp('locked_until'),
});

export const apikey = pgTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    start: text('start'),
    prefix: text('prefix'),
    key: text('key').notNull(),
    configId: text('config_id').default('default').notNull(),
    referenceId: text('reference_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at'),
    enabled: boolean('enabled'),
    rateLimitEnabled: boolean('rate_limit_enabled'),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count'),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
    /**
     * An **Agent key**'s expiry, which is Cloudgate's and not the plugin's
     * (ADR-0023). `expiresAt` above stays null on every Agent key.
     *
     * The plugin's own column cannot carry it, because the plugin deletes what
     * it expires: `verifyApiKey` removes a row it finds past `expiresAt`, and
     * `deleteAllExpiredApiKeys` removes every such row instance-wide whenever
     * anybody creates, lists or deletes a personal key. An Agent whose key ran
     * out would then have nothing to show for it, and "why did my Agent stop"
     * would have no answer on screen. A column the plugin has never heard
     * of is one it never reads and never deletes on, so an expired Agent key
     * stays a row until an operator removes it, and whatever authenticates an
     * Agent key checks this column itself.
     */
    agentExpiresAt: timestamp('agent_expires_at'),
    /**
     * What the MCP client holding this **Agent key** last said about itself
     * when it last connected, its self-reported `clientInfo`
     * name and version, and the protocol revision the call was served at.
     *
     * **Self-reported, and never decides anything.** A client can claim to be
     * anything; the dispatcher writes these after the call is authenticated
     * and reads them nowhere, and the console labels them *self-reported*.
     * Columns of their own rather than `metadata`, because `metadata` is
     * writable by whoever holds the key through better-auth's surface and is
     * never read or shown. Null on a personal key and on an Agent key
     * that has never connected.
     */
    lastConnectedAt: timestamp('last_connected_at'),
    lastClientName: text('last_client_name'),
    lastClientVersion: text('last_client_version'),
    lastProtocolRevision: text('last_protocol_revision'),
  },
  (table) => [
    // One expiry per key, and never the plugin's on an Agent key: a row
    // carrying both would be deleted by the plugin at the earlier of the two.
    check(
      'apikey_one_expiry',
      sql`${table.agentExpiresAt} IS NULL OR ${table.expiresAt} IS NULL`,
    ),
  ],
);

/**
 * A pending `cloudgate login`: better-auth's `deviceAuthorization`
 * model, one row per code a CLI asked for. The person claims it by looking the
 * code up in the console with their session (`userId`), approves or denies it
 * (`status`), and the polling CLI's `POST /auth/device/token` consumes the row
 * and is handed a Personal key, never a session. The property names are the
 * plugin's field names, since its adapter reads this table by them.
 */
export const deviceCode = pgTable('device_code', {
  id: text('id').primaryKey(),
  deviceCode: text('device_code').notNull().unique(),
  userCode: text('user_code').notNull().unique(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  status: text('status').notNull(),
  lastPolledAt: timestamp('last_polled_at'),
  pollingInterval: integer('polling_interval'),
  clientId: text('client_id'),
  scope: text('scope'),
});

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type ApiKey = typeof apikey.$inferSelect;
export type DeviceCode = typeof deviceCode.$inferSelect;
