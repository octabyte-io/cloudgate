import { relations, sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';
import { organization } from '../organizations/organizations.schema';

/**
 * The clouds a Cloud account can be at. `gcp` joined in its own migration
 * (slice 6): a Google Cloud account's row can be held before anything
 * can connect one.
 */
export const cloudKindEnum = pgEnum('cloud_kind', ['aws', 'gcp']);

export type CloudKind = (typeof cloudKindEnum.enumValues)[number];

/** How a Cloud account's last connect check ended. */
export const cloudAccountCheckResultEnum = pgEnum(
  'cloud_account_check_result',
  ['passed', 'failed'],
);

/**
 * An `aws` row has every AWS column; any other row has none (S12).
 *
 * Both checks read `cloud` as text: `gcp` joined `cloud_kind` in 0154, and an
 * install upgrading across 0154 and the migration that added these runs both
 * in one transaction, where Postgres refuses an enum value added in that same
 * transaction ("unsafe use of new value", as `volume-backup.schema.ts` found).
 */
const cloudAccountAwsWhole = check(
  'cloud_account_aws_whole',
  sql`CASE WHEN "cloud"::text = 'aws'
    THEN num_nulls("access_key_id", "secret_access_key", "deploy_role_arn", "task_execution_role_arn", "external_id") = 0
    ELSE num_nonnulls("access_key_id", "secret_access_key", "deploy_role_arn", "task_execution_role_arn", "external_id") = 0
  END`,
);

/**
 * A `gcp` row has every Google column but the pending key, which only a key
 * change holds; any other row has none of them (S12). The token issuer
 * joined in 0156, before any install could hold a `gcp` row.
 */
const cloudAccountGcpWhole = check(
  'cloud_account_gcp_whole',
  sql`CASE WHEN "cloud"::text = 'gcp'
    THEN num_nulls("project_number", "workload_identity_provider", "deploy_service_account", "signing_key", "signing_key_id", "signing_public_key", "token_issuer") = 0
    ELSE num_nonnulls("project_number", "workload_identity_provider", "deploy_service_account", "signing_key", "signing_key_id", "signing_public_key", "pending_signing_key", "token_issuer") = 0
  END`,
);

/**
 * A **Cloud account** (CONTEXT.md): one Organization's link to one
 * account at one cloud, through a credential only that cloud understands.
 *
 * - `cloudId` is the cloud's own id for the account — an AWS account id — and
 *   never changes, because every Service in it records it and its Delete must
 *   reach the same account. No route edits it.
 * - `secretAccessKey` is encrypted at rest (ADR-0006) and no response carries
 *   it, only `hasSecretAccessKey` (ADR-0019). The access key id is not a
 *   secret and is shown.
 * - `externalId` is made by Cloudgate, random, shown whenever anyone looks and
 *   never changed; AWS does not treat it as a secret, so it is plain.
 * - `policyVersion` is the generated policy version the last passing check
 *   held the role to, which "permissions out of date" compares. On
 *   Google Cloud it is the custom role's version.
 *
 * **Two clouds, one row (slice 6, S12).** The AWS columns and the Google
 * columns sit side by side, each set nullable, and {@link cloudAccountAwsWhole}
 * and {@link cloudAccountGcpWhole} hold an `aws` row to all of its own and none
 * of Google's and a `gcp` row to the mirror. A Google Cloud account holds no
 * Google secret: it signs its own short-lived proof with a key pair of its own
 * so `signingKey` and `pendingSigningKey` — the private halves — are
 * encrypted at rest (ADR-0006) and no response carries either, only whether
 * one is on file (ADR-0019). The key id and the public half are shown, since
 * the operator uploads the public half to Google.
 *
 * Code that needs AWS's credential reaches it through `awsAccountOf`
 * (`cloud-accounts.service.ts`), which refuses a Google row.
 *
 * There is no region: each Environment that uses it names one.
 */
export const cloudAccount = pgTable(
  'cloud_account',
  {
    cloudAccountId: nanoidPk('cloud_account_id'),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    cloud: cloudKindEnum('cloud').notNull(),
    cloudId: text('cloud_id').notNull(),
    // AWS's, all set on an `aws` row and none on a `gcp` one.
    accessKeyId: text('access_key_id'),
    secretAccessKey: encryptedText('secret_access_key'),
    deployRoleArn: text('deploy_role_arn'),
    taskExecutionRoleArn: text('task_execution_role_arn'),
    externalId: text('external_id'),
    // Google's, all set on a `gcp` row (bar the pending key) and none on an
    // `aws` one.
    /** The project's number, read at connect and fixed, so the project reached is pinned. */
    projectNumber: text('project_number'),
    /** The OIDC provider's full resource name, the audience of every token. */
    workloadIdentityProvider: text('workload_identity_provider'),
    /** The email of the deploy service account Cloudgate steps into. */
    deployServiceAccount: text('deploy_service_account'),
    /** The private half of the key Cloudgate signs its tokens with. */
    signingKey: encryptedText('signing_key'),
    /** That key's id, its tokens' `kid`. */
    signingKeyId: text('signing_key_id'),
    /** That key's public half, which the operator uploads to the provider. */
    signingPublicKey: text('signing_public_key'),
    /** A new key's private half while a key change waits for a check to pass with it. */
    pendingSigningKey: encryptedText('pending_signing_key'),
    /**
     * The issuer every token names (S16), fixed when the setup script is
     * handed out, since the provider the script made matches it exactly: a
     * later change to the install's address must not lock the Cloud account
     * out.
     */
    tokenIssuer: text('token_issuer'),
    policyVersion: integer('policy_version').notNull(),
    lastCheckedAt: text('last_checked_at').notNull(),
    lastCheckResult: cloudAccountCheckResultEnum('last_check_result').notNull(),
    /** Why the last check failed, in the words the operator was shown; null after a pass. */
    lastCheckReason: text('last_check_reason'),
    createdAt: isoTimestamp('created_at'),
  },
  // One Cloud account per cloud account per Organization, so two never fight
  // over the same resources. Other Organizations may connect
  // the same one; their tags tell them apart.
  (table) => [
    uniqueIndex('cloud_account_organization_cloud_id_unique').on(
      table.organizationId,
      table.cloud,
      table.cloudId,
    ),
    cloudAccountAwsWhole,
    cloudAccountGcpWhole,
  ],
);

export const cloudAccountRelations = relations(cloudAccount, ({ one }) => ({
  organization: one(organization, {
    fields: [cloudAccount.organizationId],
    references: [organization.id],
  }),
}));

export type CloudAccount = typeof cloudAccount.$inferSelect;
