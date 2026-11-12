import { relations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedText, nanoidPk } from '../../../db/columns';
import { gitProvider } from '../../git-provider.schema';

// Basic-auth credentials hanging off a gitProvider base row — either an
// Atlassian API token (paired with the account email) or a legacy app password
// (paired with the username). Both secrets are encrypted at rest.
export const bitbucket = pgTable('bitbucket', {
  bitbucketId: nanoidPk('bitbucket_id'),
  bitbucketUsername: text('bitbucket_username'),
  bitbucketEmail: text('bitbucket_email'),
  appPassword: encryptedText('app_password'),
  apiToken: encryptedText('api_token'),
  bitbucketWorkspaceName: text('bitbucket_workspace_name'),
  gitProviderId: text('git_provider_id')
    .notNull()
    .references(() => gitProvider.gitProviderId, { onDelete: 'cascade' }),
});

export const bitbucketRelations = relations(bitbucket, ({ one }) => ({
  gitProvider: one(gitProvider, {
    fields: [bitbucket.gitProviderId],
    references: [gitProvider.gitProviderId],
  }),
}));

export type Bitbucket = typeof bitbucket.$inferSelect;
