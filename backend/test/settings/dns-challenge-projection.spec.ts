import { getTableColumns } from 'drizzle-orm';
import { dnsChallenge } from '../../src/db/schema';
import type { DnsChallenge } from '../../src/settings/dns-challenge.schema';
import { toDnsChallengeView } from '../../src/settings/dns-challenge.utils';

/**
 * ADR-0019 for the `dns_challenge` row: the projection every response
 * about a machine's DNS-01 setup goes through carries no value any
 * encrypted-at-rest column holds.
 *
 * The withheld set is derived from the schema — every `PgCustomColumn`, which
 * is what `encryptedText` and `encryptedJson` both are — rather than listed,
 * so a second secret column added to the table is held here with no edit.
 * `secret-bearing-columns.spec.ts` is the other half: it holds the credential
 * map to being encrypted at all.
 */
describe('toDnsChallengeView', () => {
  const encryptedColumns = Object.entries(getTableColumns(dnsChallenge))
    .filter(([, column]) => column.columnType === 'PgCustomColumn')
    .map(([key]) => key);

  const row: DnsChallenge = {
    dnsChallengeId: 'dns-1',
    provider: 'cloudflare',
    credentials: {
      CF_DNS_API_TOKEN: 'value-one-7f3a',
      CF_ZONE_API_TOKEN: 'value-two-9c1d',
    },
    serverId: null,
    createdAt: '2026-09-23T00:00:00.000Z',
  };

  /** Every string a column's value holds, however deep. */
  const stringsIn = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(stringsIn)
        : [];

  it('finds the credential map among the encrypted columns', () => {
    expect(encryptedColumns).toEqual(['credentials']);
  });

  it('carries no value of an encrypted column, at any depth', () => {
    const answered = JSON.stringify(toDnsChallengeView(row));
    const leaked = encryptedColumns.flatMap((key) =>
      stringsIn(row[key as keyof DnsChallenge]).filter((value) =>
        answered.includes(value),
      ),
    );

    expect(leaked).toEqual([]);
  });

  it('answers the provider and the credential key names, and nothing else', () => {
    expect(toDnsChallengeView(row)).toEqual({
      provider: 'cloudflare',
      credentialKeys: ['CF_DNS_API_TOKEN', 'CF_ZONE_API_TOKEN'],
    });
  });
});
