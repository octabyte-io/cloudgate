import { relations } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedText, nanoidPk } from '../../../db/columns';
import { gitProvider } from '../../git-provider.schema';

// A Gitea OAuth application hanging off a gitProvider base row. The client
// secret and both OAuth tokens are encrypted at rest.
export const gitea = pgTable('gitea', {
  giteaId: nanoidPk('gitea_id'),
  giteaUrl: text('gitea_url').notNull().default('https://gitea.com'),
  // Self-hosted Gitea reachable on a private address from this server.
  giteaInternalUrl: text('gitea_internal_url'),
  redirectUri: text('redirect_uri'),
  clientId: text('client_id'),
  clientSecret: encryptedText('client_secret'),
  accessToken: encryptedText('access_token'),
  refreshToken: encryptedText('refresh_token'),
  /** Unix seconds the access token expires at. */
  expiresAt: integer('expires_at'),
  scopes: text('scopes').default('repo,repo:status,read:user,read:org'),
  /** Unix seconds of the last successful authentication. */
  lastAuthenticatedAt: integer('last_authenticated_at'),
  gitProviderId: text('git_provider_id')
    .notNull()
    .references(() => gitProvider.gitProviderId, { onDelete: 'cascade' }),
});

export const giteaRelations = relations(gitea, ({ one }) => ({
  gitProvider: one(gitProvider, {
    fields: [gitea.gitProviderId],
    references: [gitProvider.gitProviderId],
  }),
}));

export type Gitea = typeof gitea.$inferSelect;
