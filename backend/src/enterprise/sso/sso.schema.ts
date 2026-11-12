import { relations } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from '../../auth/auth.schema';
import { encryptedText, nanoidPk } from '../../db/columns';
import { organization } from '../../organizations/organizations.schema';

// The table better-auth's SSO plugin owns, in the column names the plugin
// expects. Phase 50 (forward-auth) read it to find the identity provider a
// server's oauth2-proxy authenticates against; phase 51 registered the plugin,
// so the plugin itself now writes these rows through the drizzle adapter
// (SsoService goes through its API rather than inserting here) and every
// property name below has to keep matching the field names it declares.
//
// Two columns are shaped by Cloudgate rather than the plugin:
//   * `oidcConfig`/`samlConfig` are encrypted at rest — both blobs carry the
//     provider's client secret (the registries/ai/license precedent). They stay
//     `text` on the wire, so the better-auth adapter reads and writes them
//     unchanged.
//   * `id` defaults to a nanoid rather than requiring the caller to supply one,
//     so a row can be created without going through better-auth.

export const ssoProvider = pgTable('sso_provider', {
  id: nanoidPk('id'),
  issuer: text('issuer').notNull(),
  oidcConfig: encryptedText('oidc_config'),
  samlConfig: encryptedText('saml_config'),
  providerId: text('provider_id').notNull().unique(),
  userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
  organizationId: text('organization_id').references(() => organization.id, {
    onDelete: 'cascade',
  }),
  domain: text('domain').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const ssoProviderRelations = relations(ssoProvider, ({ one }) => ({
  organization: one(organization, {
    fields: [ssoProvider.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [ssoProvider.userId],
    references: [user.id],
  }),
}));

export type SsoProvider = typeof ssoProvider.$inferSelect;
