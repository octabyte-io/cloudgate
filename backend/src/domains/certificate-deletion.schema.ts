import { pgTable, text } from 'drizzle-orm/pg-core';
import { cloudAccount } from '../cloud-accounts/cloud-account.schema';
import { isoTimestamp } from '../db/columns';

/**
 * **A Domain's certificate waiting for ACM to let go**: one no Domain
 * names any more, taken out of its Infrastructure state by the run that
 * removed it, so that run never waits on ACM. CloudFront drops a certificate
 * at once, but ACM keeps calling it in use for 20–40 minutes after, and
 * refuses to delete it meanwhile; a load balancer's lags too, for less. The
 * Domain poller asks ACM to delete it about once a minute for an hour, then
 * about every 10 minutes, and the row goes once ACM has deleted it or no
 * longer has it.
 *
 * Kept by its ARN and Cloud account only, not by its Service: it outlives
 * the Service's Delete, whose check calls it being deleted, not left. It
 * goes with its Cloud account.
 */
export const certificateDeletion = pgTable('certificate_deletion', {
  certificateArn: text('certificate_arn').primaryKey(),
  cloudAccountId: text('cloud_account_id')
    .notNull()
    .references(() => cloudAccount.cloudAccountId, { onDelete: 'cascade' }),
  /** The region it was requested in: `us-east-1` for a static site's. */
  region: text('region').notNull(),
  /** The Infrastructure state that held it, whose tag it still carries. */
  stateId: text('state_id').notNull(),
  /** The host it was for, for the log and the Delete's report. */
  host: text('host'),
  forgottenAt: isoTimestamp('forgotten_at'),
  lastTriedAt: text('last_tried_at'),
});

export type CertificateDeletion = typeof certificateDeletion.$inferSelect;
