import { relations } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { encryptedText, nanoidPk } from '../../db/columns';
import { organization } from '../../organizations/organizations.schema';

// The org-scoped license table the phase file specifies — one row per
// organization, so a license belongs to the tenant rather than to whichever
// user happens to own it.
//
// Additions to the phase file's column list, both forced by the per-org shape:
//   * `enableEnterpriseFeatures` — the opt-in toggle, the precondition every
//     activate/validate checks. It has to outlive the key itself (deactivate
//     leaves it set), so it lives on this row and `updateEnterpriseSettings`
//     upserts a row carrying nothing else.
//   * `key` is therefore nullable: the toggle can be on with no key stored,
//     which is exactly the state deactivate leaves behind.
//
// The key is encrypted at rest (registries/ai precedent).

/**
 * Stored license state. `expired` is *not* one of these: expiry is derived from
 * `validUntil` at read time, so a license lapses without anything having to
 * write to the row.
 */
export const licenseStatusEnum = pgEnum('license_status', [
  'inactive',
  'active',
  'invalid',
]);

export type LicenseStatus = (typeof licenseStatusEnum.enumValues)[number];

export const licenseKey = pgTable(
  'license_key',
  {
    id: nanoidPk('id'),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    key: encryptedText('key'),
    status: licenseStatusEnum('status').notNull().default('inactive'),
    validUntil: timestamp('valid_until', { precision: 3 }),
    /** Named features the key grants; `[]` means it enumerates none. */
    features: jsonb('features').$type<string[]>().notNull().default([]),
    enableEnterpriseFeatures: boolean('enable_enterprise_features')
      .notNull()
      .default(false),
    /**
     * The `validUntil` a lapse has already been reported for, or null
     * while none has. Expiry is derived, so the *transition* has no record of
     * its own and the periodic check would otherwise warn about the same lapse
     * on every tick — a warning that repeats forever is one operators learn to
     * ignore. Storing the expiry rather than a boolean re-arms the check by
     * itself: `activate` writes a new `validUntil`, which no longer matches
     * this, so the next lapse is reported again without activate/deactivate
     * having to remember to clear anything.
     */
    lapseReportedFor: timestamp('lapse_reported_for', { precision: 3 }),
    /**
     * The `validUntil` the 14-day and the 3-day `license-expiring` warnings
     * were sent for, or null while none was. The expiry rather than a
     * flag, as `lapseReportedFor`: a renewal writes a new `validUntil`, which
     * re-arms both.
     */
    expiryWarned14For: timestamp('expiry_warned_14_for', { precision: 3 }),
    expiryWarned3For: timestamp('expiry_warned_3_for', { precision: 3 }),
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { precision: 3 }).$onUpdate(
      () => new Date(),
    ),
  },
  (table) => [
    unique('licenseKey_organizationId_unique').on(table.organizationId),
  ],
);

export const licenseKeyRelations = relations(licenseKey, ({ one }) => ({
  organization: one(organization, {
    fields: [licenseKey.organizationId],
    references: [organization.id],
  }),
}));

export type LicenseKey = typeof licenseKey.$inferSelect;
