import { relations } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedText, nanoidPk } from '../../../db/columns';
import { gitProvider } from '../../git-provider.schema';

// A GitLab OAuth application hanging off a gitProvider base row. The
// application secret and both OAuth tokens are encrypted at rest.
export const gitlab = pgTable('gitlab', {
  gitlabId: nanoidPk('gitlab_id'),
  gitlabUrl: text('gitlab_url').notNull().default('https://gitlab.com'),
  // Self-hosted GitLab reachable on a private address from this server.
  gitlabInternalUrl: text('gitlab_internal_url'),
  applicationId: text('application_id'),
  redirectUri: text('redirect_uri'),
  secret: encryptedText('secret'),
  accessToken: encryptedText('access_token'),
  refreshToken: encryptedText('refresh_token'),
  groupName: text('group_name'),
  /** Unix seconds the access token expires at. */
  expiresAt: integer('expires_at'),
  gitProviderId: text('git_provider_id')
    .notNull()
    .references(() => gitProvider.gitProviderId, { onDelete: 'cascade' }),
});

export const gitlabRelations = relations(gitlab, ({ one }) => ({
  gitProvider: one(gitProvider, {
    fields: [gitlab.gitProviderId],
    references: [gitProvider.gitProviderId],
  }),
}));

export type Gitlab = typeof gitlab.$inferSelect;
