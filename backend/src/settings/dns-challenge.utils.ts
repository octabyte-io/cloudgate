import { ConflictException } from '@nestjs/common';
import { isMap, parseDocument } from 'yaml';
import { DNS_CHALLENGE_RESOLVER } from './dns-challenge.schema';
import type { DnsChallenge } from './dns-challenge.schema';

/**
 * What every response about a machine's DNS-01 setup carries: the lego
 * provider, and the **names** of the credentials that are set — never a value.
 *
 * ADR-0019's rule, in the one shape it can take for a map whose keys are the
 * operator's: the key names *are* the presence. A `hasCredentials` boolean
 * would have been the rule's letter, and it would have left the console unable
 * to show which of a provider's variables were given, which is the one fact a
 * screen reads them for.
 */
export interface DnsChallengeView {
  provider: string;
  credentialKeys: string[];
}

/**
 * The response projection of a `dns_challenge` row. Built by naming the two
 * fields it answers with rather than by spreading the row minus its secret,
 * because a spread keeps every column added later (ADR-0019's second
 * consequence) — `test/settings/dns-challenge-projection.spec.ts` holds it to
 * the schema's encrypted columns.
 */
export function toDnsChallengeView(row: DnsChallenge): DnsChallengeView {
  return {
    provider: row.provider,
    credentialKeys: Object.keys(row.credentials).sort(),
  };
}

/** The `409` a machine without a `letsencrypt` resolver answers a DNS setup. */
export const NO_LETSENCRYPT_RESOLVER =
  "This machine's traefik.yml has no letsencrypt resolver to take the ACME email and storage from";

/**
 * `traefik.yml` with the DNS-01 resolver written beside `letsencrypt`, or taken
 * out again when `provider` is null.
 *
 * The resolver copies `letsencrypt`'s `email` and **its `storage`**: one
 * `acme.json` holds both resolvers' certificates, keyed by resolver name, so
 * whatever already reads that file for the machine's certificates reads the
 * wildcard too, and no second file needs a mode, a mount or a reader.
 * `letsencrypt` itself is not touched — every HTTP-01 Domain names it.
 *
 * A `Document` rather than parse/stringify, as `toggleRequests` and
 * `toggleDashboardApi` edit the same file: comments an operator wrote, and the
 * access-log rotation note, survive the write. `parseDocument` has no
 * diagnostic channel to close (`TRAEFIK_YAML_PARSE_OPTIONS`' docblock), so it
 * takes no options.
 *
 * Refuses with `409` when there is no `letsencrypt.acme` to copy from, rather
 * than inventing a storage path Traefik might not be able to write.
 */
export function withDnsChallengeResolver(
  config: string,
  provider: string | null,
): string {
  const doc = parseDocument(config);
  const resolverPath = ['certificatesResolvers', DNS_CHALLENGE_RESOLVER];

  if (provider === null) {
    doc.deleteIn(resolverPath);
    return doc.toString();
  }

  const acme: unknown = doc.getIn([
    'certificatesResolvers',
    'letsencrypt',
    'acme',
  ]);
  if (!isMap(acme)) throw new ConflictException(NO_LETSENCRYPT_RESOLVER);
  const email: unknown = acme.get('email');
  const storage: unknown = acme.get('storage');

  doc.setIn(
    resolverPath,
    doc.createNode({
      acme: {
        ...(typeof email === 'string' ? { email } : {}),
        ...(typeof storage === 'string' ? { storage } : {}),
        dnsChallenge: { provider },
      },
    }),
  );
  return doc.toString();
}

/** The key of one `KEY=value` env entry. */
const envKey = (entry: string): string => entry.split('=', 1)[0];

/**
 * Traefik's env with `keys` taken out. Used to keep a machine's DNS
 * credentials out of every read of Traefik's env (`GET /settings/traefik/env`
 * above all), and to drop a removed or replaced credential before Traefik is
 * recreated.
 */
export function withoutEnvKeys(
  env: readonly string[],
  keys: Iterable<string>,
): string[] {
  const drop = new Set(keys);
  return env.filter((entry) => !drop.has(envKey(entry)));
}

/**
 * Traefik's env with the machine's DNS credentials in it, which **win** over a
 * same-named key already there.
 *
 * The console cannot read these back (ADR-0019), so it cannot resubmit them
 * either: the env editor, the dashboard toggle and the port writes all hand
 * `writeTraefikSetup` an env without them, and this merge is what keeps the
 * resolver's credentials on every Traefik the platform recreates. Appended as
 * `KEY=value` without parsing, so no value is ever read as a dotenv line or a
 * `${{…}}` reference.
 */
export function withDnsCredentials(
  env: readonly string[],
  credentials: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!credentials) return [...env];
  return [
    ...withoutEnvKeys(env, Object.keys(credentials)),
    ...Object.entries(credentials).map(([key, value]) => `${key}=${value}`),
  ];
}
