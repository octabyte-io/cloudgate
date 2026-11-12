import { relations } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { encryptedText, nanoidPk } from '../../db/columns';
import { organization } from '../../organizations/organizations.schema';

// The table better-auth's SCIM plugin owns, in the column names the plugin's
// own `schema` declaration expects (providerId, scimToken, organizationId), so
// every property name below has to keep matching them.
//
// The plugin, not this codebase, writes these rows: ScimService goes through
// `auth.api.generateSCIMToken` rather than inserting here, because the token it
// hands back is derived from the row it creates.
//
// `scimToken` is encrypted at rest (the sso `oidcConfig` / registries / ai /
// license precedent). It is a live provisioning credential — anyone holding it can
// create, rename and ban users in the organization — and it stays `text` on the
// wire, so the better-auth adapter reads and writes it unchanged.
//
// The plugin declares `scimToken` unique and the constraint is kept to match
// that declaration, but it is vacuous over non-deterministic ciphertext. Nothing relies on it:
// the auth middleware looks a provider up by `providerId` (carried in the
// token's own base64url payload) and only then compares the secret.
//
// `organizationId` is nullable, as in the plugin's declaration —
// the plugin supports personal, org-less tokens. Cloudgate never issues one:
// `/scim/generate-token` is disabled and ScimService always scopes to the
// caller's active organization.
//
// `lastRefusedAddAt` / `lastRefusedAddEmail` are Cloudgate's, not the plugin's
// (ADR-0054): the last create or reactivation this provider pushed while
// its Organization was below the paid features, refused by
// `refuseScimAddWithoutPaidFeatures` before the plugin ran. The plugin never
// names them, so it leaves them as they are; the SCIM page reads them through
// `ScimService.listProviders` to say why someone was not added.

export const scimProvider = pgTable('scim_provider', {
  id: nanoidPk('id'),
  providerId: text('provider_id').notNull().unique(),
  scimToken: encryptedText('scim_token').notNull().unique(),
  organizationId: text('organization_id').references(() => organization.id, {
    onDelete: 'cascade',
  }),
  lastRefusedAddAt: timestamp('last_refused_add_at', { precision: 3 }),
  lastRefusedAddEmail: text('last_refused_add_email'),
});

export const scimProviderRelations = relations(scimProvider, ({ one }) => ({
  organization: one(organization, {
    fields: [scimProvider.organizationId],
    references: [organization.id],
  }),
}));

export type ScimProvider = typeof scimProvider.$inferSelect;
