import { relations, isNull } from 'drizzle-orm';
import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { isoTimestamp, nanoidPk } from '../../db/columns';
import { certificateTypeEnum } from '../../domains/domain.schema';
import { server } from '../../servers/server.schema';
import { ssoProvider } from '../sso/sso.schema';

// One row per Traefik instance — a deploy server, or the local one when
// `serverId` is null — carrying the domain that server's oauth2-proxy answers
// /oauth2/* on and the provider it authenticates against.
//
// Deliberately *not* organization-scoped: an auth domain is a property of a
// Traefik instance, and there is one Traefik per server. The local row is
// therefore instance-wide, shared by every organization on the instance; remote
// rows are reached only through their server, which is org-scoped.
//
// The partial unique index makes the local row unique the way
// `serverId.unique()` makes the remote ones, and `setAuthDomain`'s upsert names
// it as its conflict target. **Its `NULLS NOT DISTINCT` is in
// `0084_forward-auth-local-unique.sql`, not here**: drizzle cannot say it on an
// index, and without it the index constrains nothing, since Postgres counts
// every NULL distinct — two local rows were insertable until then.
// `test/coding-standards/nulls-not-distinct.spec.ts` holds every such index to
// the clause.

export const forwardAuthSettings = pgTable(
  'forward_auth_settings',
  {
    forwardAuthSettingsId: nanoidPk('forward_auth_settings_id'),
    /** Host the oauth2-proxy is reached on, e.g. `auth.example.com`. */
    authDomain: text('auth_domain').notNull(),
    /** Cookie/whitelist domain derived from `authDomain`, e.g. `.example.com`. */
    baseDomain: text('base_domain').notNull(),
    https: boolean('https').notNull().default(true),
    certificateType: certificateTypeEnum('certificate_type')
      .notNull()
      .default('letsencrypt'),
    customCertResolver: text('custom_cert_resolver'),
    /** The deployed proxy's identity provider; null until it is deployed. */
    providerId: text('provider_id').references(() => ssoProvider.providerId, {
      onDelete: 'set null',
    }),
    /** Null means the local server. */
    serverId: text('server_id')
      .unique()
      .references(() => server.serverId, { onDelete: 'cascade' }),
    createdAt: isoTimestamp('created_at'),
  },
  (table) => [
    uniqueIndex('forward_auth_settings_local_unique')
      .on(table.serverId)
      .where(isNull(table.serverId)),
  ],
);

export const forwardAuthSettingsRelations = relations(
  forwardAuthSettings,
  ({ one }) => ({
    server: one(server, {
      fields: [forwardAuthSettings.serverId],
      references: [server.serverId],
    }),
    provider: one(ssoProvider, {
      fields: [forwardAuthSettings.providerId],
      references: [ssoProvider.providerId],
    }),
  }),
);

export type ForwardAuthSettings = typeof forwardAuthSettings.$inferSelect;
