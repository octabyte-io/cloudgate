import { relations } from 'drizzle-orm';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { isoTimestamp, nanoidPk } from '../../db/columns';
import { organization } from '../../organizations/organizations.schema';

/**
 * A **Proven domain** (CONTEXT.md, ADR-0051): an email domain an
 * Organization has shown it owns with a DNS TXT record, on the Hosted instance.
 *
 * One row per Organization and domain, created with its random `challenge` and
 * no `provenAt`; checking it with the record in place stamps `provenAt`, and
 * nothing un-stamps it. Only a proven row lets that Organization's SSO
 * provider route and accept sign-ins for the domain. Two Organizations may each
 * hold a row for the same domain — only whoever controls its DNS can prove it,
 * and which provider an address routes to is still the providers' own
 * first-come claim (`SsoService.assertDomainsUnclaimed`).
 */
export const provenDomain = pgTable(
  'proven_domain',
  {
    provenDomainId: nanoidPk('proven_domain_id'),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Lowercased, as provider domains are (`normalizeDomains`). */
    domain: text('domain').notNull(),
    /**
     * Random per row, and public by design: it is published in DNS. What the
     * TXT record has to carry is `challengeRecordValue(challenge)`.
     */
    challenge: text('challenge').notNull(),
    provenAt: text('proven_at'),
    createdAt: isoTimestamp('created_at'),
  },
  (table) => [
    uniqueIndex('proven_domain_organization_domain_unique').on(
      table.organizationId,
      table.domain,
    ),
  ],
);

export const provenDomainRelations = relations(provenDomain, ({ one }) => ({
  organization: one(organization, {
    fields: [provenDomain.organizationId],
    references: [organization.id],
  }),
}));

export type ProvenDomain = typeof provenDomain.$inferSelect;
