/**
 * Trims, lowercases and de-duplicates a provider's domains, dropping empty
 * entries. The email domains that route to a provider are matched by equality
 * against the stored comma-joined list, so they have to be normalized before
 * they are compared or stored — and that has to happen wherever the write
 * enters, not only at the HTTP edge.
 */
export const normalizeDomains = (domains: string[]): string[] =>
  Array.from(
    new Set(
      domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
    ),
  );

/**
 * Trims and drops trailing slashes, so `https://example.com/` and
 * `https://example.com` are one entry.
 */
export const normalizeTrustedOrigin = (value: string): string =>
  value.trim().replace(/\/+$/, '');

/** The stored comma-joined `domain` column, back as a normalized list. */
export const parseDomainList = (domain: string): string[] =>
  normalizeDomains(domain.split(','));
