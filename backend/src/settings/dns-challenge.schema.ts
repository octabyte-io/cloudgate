import { relations, isNull } from 'drizzle-orm';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { encryptedJson, isoTimestamp, nanoidPk } from '../db/columns';
import { server } from '../servers/server.schema';

/**
 * The name of the ACME resolver a DNS-01 setup declares in a machine's
 * `traefik.yml`, beside `letsencrypt` and never replacing it. One name
 * on every machine, because a machine has at most one DNS provider.
 */
export const DNS_CHALLENGE_RESOLVER = 'letsencrypt-dns';

// One row per Traefik instance — a deploy Server, or the platform host when
// `serverId` is null — naming the lego DNS provider its DNS-01 resolver uses
// and the credentials Traefik reads from its environment. Per machine,
// as `traefik.yml`, Traefik's env and stored certificates already are, so no
// instance-wide DNS credential is copied onto remote Servers.
//
// `credentials` is `KEY=value` pairs for Traefik's env, encrypted at rest
// (ADR 0006) and never answered: a response carries the key names, not the
// values (ADR 0019).
//
// The partial unique index makes the platform-host row unique the way
// `serverId.unique()` makes the remote ones. **Its `NULLS NOT DISTINCT` is in
// `0083_dns-challenge-local-unique.sql`, not here**: drizzle cannot say it on
// an index, and without it the index constrains nothing, since Postgres counts
// every NULL distinct — two platform-host rows were insertable until then.
export const dnsChallenge = pgTable(
  'dns_challenge',
  {
    dnsChallengeId: nanoidPk('dns_challenge_id'),
    /** A lego provider code, e.g. `cloudflare`, `route53`, `acme-dns`. */
    provider: text('provider').notNull(),
    credentials: encryptedJson<Record<string, string>>('credentials').notNull(),
    /** Null means the platform host. */
    serverId: text('server_id')
      .unique()
      .references(() => server.serverId, { onDelete: 'cascade' }),
    createdAt: isoTimestamp('created_at'),
  },
  (table) => [
    uniqueIndex('dns_challenge_local_unique')
      .on(table.serverId)
      .where(isNull(table.serverId)),
  ],
);

export const dnsChallengeRelations = relations(dnsChallenge, ({ one }) => ({
  server: one(server, {
    fields: [dnsChallenge.serverId],
    references: [server.serverId],
  }),
}));

export type DnsChallenge = typeof dnsChallenge.$inferSelect;
