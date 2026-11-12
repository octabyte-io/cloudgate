import { relations } from 'drizzle-orm';
import { integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { isoTimestamp, nanoidPk } from '../db/columns';
import { organization } from '../organizations/organizations.schema';

// The OAuth/app-backed providers that hang a detail table off the gitProvider
// base row.
export const gitProviderTypeEnum = pgEnum('git_provider_type', [
  'github',
  'gitlab',
  'bitbucket',
  'gitea',
]);

export type GitProviderType = (typeof gitProviderTypeEnum.enumValues)[number];

// Where a service's code/image comes from, for applications and compose alike.
// Strategies are registered per source type, and that is now true of
// every member without exception.
//
// This comment used to end "'drop' (file upload) has no strategy — it is
// handled inline", and there was no inline branch: `deploy` went straight to
// `SourceCloneService.cloneCommand`, which raised. The sentence described a
// design nobody had written, so it read as an explanation of the raise instead
// of as the bug it was. `strategies/drop.strategy.ts` is the branch it
// promised.
export const sourceTypeEnum = pgEnum('source_type', [
  'docker',
  'git',
  'github',
  'gitlab',
  'bitbucket',
  'gitea',
  'drop',
  'raw',
]);

export type SourceType = (typeof sourceTypeEnum.enumValues)[number];

// The gitProvider base table: one row per connected provider account;
// provider-specific credentials hang off detail tables in later phases.
export const gitProvider = pgTable('git_provider', {
  gitProviderId: nanoidPk('git_provider_id'),
  name: text('name').notNull(),
  providerType: gitProviderTypeEnum('provider_type')
    .notNull()
    .default('github'),
  createdAt: isoTimestamp('created_at'),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
});

export const gitProviderRelations = relations(gitProvider, ({ one }) => ({
  organization: one(organization, {
    fields: [gitProvider.organizationId],
    references: [organization.id],
  }),
}));

export type GitProvider = typeof gitProvider.$inferSelect;

/**
 * Which leg of a handshake a `state` belongs to. The `state` is a separate
 * single-use row rather than the connection's own id, which would be guessable
 * and reusable, so a callback can be believed.
 *
 * - `manifest` — GitHub redirected back with an app-manifest conversion code.
 * - `install` — GitHub redirected back with an installation id.
 * - `authorize` — GitLab or Gitea redirected back with an authorization code.
 */
export type GitProviderOauthPurpose = 'manifest' | 'install' | 'authorize';

/**
 * The in-flight leg of a git-provider OAuth handshake.
 *
 * The callback routes are unauthenticated — the provider redirects a browser to
 * them and there is no guarantee a session cookie rides along — so the `state`
 * is the whole of the authority to write to a connection. It is therefore a
 * nanoid nobody can guess, it names exactly which connection and which leg it
 * is good for, it expires, and it is **deleted as it is read**, so a replayed
 * callback finds nothing.
 */
export const gitProviderOauthState = pgTable('git_provider_oauth_state', {
  state: nanoidPk('state'),
  /** A `GitProviderOauthPurpose`. Text rather than an enum: internal plumbing. */
  purpose: text('purpose').notNull(),
  providerType: gitProviderTypeEnum('provider_type').notNull(),
  gitProviderId: text('git_provider_id')
    .notNull()
    .references(() => gitProvider.gitProviderId, { onDelete: 'cascade' }),
  /**
   * The `redirect_uri` the authorize request carried. The token exchange has to
   * repeat it byte-for-byte, so it is remembered rather than re-derived.
   */
  redirectUri: text('redirect_uri'),
  /** Where the browser is sent when the handshake finishes. */
  returnTo: text('return_to').notNull(),
  createdAt: isoTimestamp('created_at'),
  /** Unix seconds this state stops being accepted. */
  expiresAt: integer('expires_at').notNull(),
});

export const gitProviderOauthStateRelations = relations(
  gitProviderOauthState,
  ({ one }) => ({
    gitProvider: one(gitProvider, {
      fields: [gitProviderOauthState.gitProviderId],
      references: [gitProvider.gitProviderId],
    }),
  }),
);

export type GitProviderOauthState = typeof gitProviderOauthState.$inferSelect;
