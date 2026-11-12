import { relations } from 'drizzle-orm';
import { json, pgTable, serial, text } from 'drizzle-orm/pg-core';
import type { ApplicationCredentialRef } from '../common/credential-refs';
import { isoTimestamp, nanoidPk } from '../db/columns';
import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';
import { deployment } from '../deployments/deployment.schema';

/**
 * The fullContext snapshot deliberately excludes secrets: `full_context` is a
 * plain `json` column, so anything named here would be stored in cleartext next
 * to the encrypted column it came out of (ADR 0006) and handed to every reader
 * of `RollbacksService.findAllByApplicationId`. A rollback re-reads them off
 * the live application row instead.
 *
 * **The credential *ids* are omitted as well as the relations they load**.
 * The list was the seven relations only, so the snapshot persisted
 * `githubId`…`buildRegistryId` and `RollbacksService.rollback` merged it over
 * the live row — which had just been proven to be the arm that
 * mattered. `previewEnv` and `previewBuildArgs` are here for the plaintext
 * reason and were missing for a duller one: both are `encryptedText` and both
 * arrived after this list was written, so they were absent from the
 * type as well as from the runtime list and nothing said so.
 *
 * **`registryUrl` and `username` are omitted too, and not for the plaintext
 * reason**. Neither is encrypted and neither is a secret — but they are
 * the other two thirds of a docker source's registry pull credential, whose
 * third is the `password` above, and a snapshot that holds two of the three
 * pairs the retired host and user with the live secret. See
 * `RollbacksService.EXCLUDED_FROM_CONTEXT` for what that cost. `dockerImage`
 * stays: it is the config a rollback restores, not a credential.
 *
 * **The seven ids are `ApplicationCredentialRef`**, not seven
 * literals. They were spelled out because importing the list from
 * `ApplicationsService` would have pointed a table definition at a service, and
 * `db/schema`'s barrel reaches this file, so that was a real cycle rather than a
 * style objection. `common/credential-refs.ts` imports nothing at all, which is
 * what makes the import legal — and it means an eighth credential arm added to
 * that list is omitted here the moment it is declared, instead of waiting for
 * somebody to notice this union. `RollbacksService.EXCLUDED_FROM_CONTEXT` still
 * checks the two agree from the other side.
 */
export type RollbackContext = Omit<
  DeployableApplication,
  | 'env'
  | 'buildArgs'
  | 'buildSecrets'
  | 'password'
  | 'previewEnv'
  | 'previewBuildArgs'
  | 'refreshToken'
  | 'environment'
  | 'github'
  | 'gitlab'
  | 'gitea'
  | 'bitbucket'
  | 'customGitSSHKey'
  | 'registry'
  | 'buildRegistry'
  | 'registryUrl'
  | 'username'
  | ApplicationCredentialRef
>;

export const rollback = pgTable('rollback', {
  rollbackId: nanoidPk('rollback_id'),
  deploymentId: text('deployment_id')
    .notNull()
    .references(() => deployment.deploymentId, { onDelete: 'cascade' }),
  /** Global sequence the snapshot image is tagged with: `{appName}:v{version}`. */
  version: serial('version').notNull(),
  image: text('image'),
  fullContext: json('full_context').$type<RollbackContext>(),
  /**
   * A `static` site on AWS's rollback point (the spec's "Schema
   * changes"): the folder of its bucket that holds this Deployment's files,
   * `deployments/<folder>/`, which every later Deployment's clean-up spares
   * until the point is removed, and which removing the point deletes. A
   * rollback switches the distribution back to it. Such a point has no
   * `image` and no `fullContext`: it restores files only, never settings.
   * `null` on every Server point.
   */
  folder: text('folder'),
  createdAt: isoTimestamp('created_at'),
});

export const rollbackRelations = relations(rollback, ({ one }) => ({
  deployment: one(deployment, {
    fields: [rollback.deploymentId],
    references: [deployment.deploymentId],
  }),
}));

export type Rollback = typeof rollback.$inferSelect;
