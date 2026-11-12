import { relations } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedText, nanoidPk } from '../../../db/columns';
import { gitProvider } from '../../git-provider.schema';

// GitHub App credentials hanging off a gitProvider base row. The app's private
// key, OAuth client secret and webhook secret are encrypted at rest.
export const github = pgTable('github', {
  githubId: nanoidPk('github_id'),
  appName: text('app_name'),
  appId: integer('app_id'),
  clientId: text('client_id'),
  clientSecret: encryptedText('client_secret'),
  installationId: text('installation_id'),
  privateKey: encryptedText('private_key'),
  // The value that makes an inbound webhook delivery provable — a shared
  // secret like any other credential, so it is encrypted at rest (ADR 0006).
  webhookSecret: encryptedText('webhook_secret'),
  gitProviderId: text('git_provider_id')
    .notNull()
    .references(() => gitProvider.gitProviderId, { onDelete: 'cascade' }),
});

export const githubRelations = relations(github, ({ one }) => ({
  gitProvider: one(gitProvider, {
    fields: [github.gitProviderId],
    references: [gitProvider.gitProviderId],
  }),
}));

export type Github = typeof github.$inferSelect;
