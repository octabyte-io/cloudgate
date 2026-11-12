import { createHash } from 'node:crypto';

/**
 * Google's names for what Cloudgate makes (the Google Cloud spec, "Names, labels and the
 * mark", S4). The name is the mark: Google never lets anyone rename a thing,
 * and most of what the definitions make takes no label, so a fixed name
 * built from Cloudgate's ids is how a later search or Delete finds it.
 */

/** Every name starts with it, so every name starts with a letter. */
const PREFIX = 'cloudgate';

/** RFC 4648 base32, lowercased: Google names refuse capitals. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

const KEY_LENGTH = 12;

/**
 * An id's **key**: the first 12 characters of the lowercase base32 form of
 * its SHA-256 digest, so only `a–z` and `2–7` (S4).
 *
 * Cloudgate's ids may hold capitals and `_`, which Google names refuse, and
 * lowercasing alone would give two ids differing only in case one name. 12
 * characters are 60 bits, ample for the ids of one project, and keep a
 * Service's name at 22 characters, inside the service-account limit of 30.
 */
export function idKey(id: string): string {
  const digest = createHash('sha256').update(id, 'utf8').digest();
  let key = '';
  let bits = 0;
  let buffered = 0;
  for (const byte of digest) {
    buffered = (buffered << 8) | byte;
    bits += 8;
    while (bits >= 5 && key.length < KEY_LENGTH) {
      bits -= 5;
      key += BASE32[(buffered >> bits) & 0b11111];
    }
    buffered &= (1 << bits) - 1;
    if (key.length === KEY_LENGTH) break;
  }
  return key;
}

/**
 * The name of each of a Service's own things: its Artifact Registry
 * repository, service account, Cloud Run service, serverless NEG and backend
 * service (22 characters).
 */
export function serviceName(serviceId: string): string {
  return `${PREFIX}-${idKey(serviceId)}`;
}

/** The parts of an Environment network, each a suffix of its name. */
export type NetworkPart =
  | 'net'
  | 'subnet'
  | 'ip'
  | 'https'
  | 'http'
  | 'https-proxy'
  | 'http-proxy'
  | 'urls'
  | 'redirect'
  | 'certs'
  | 'default'
  /** The private link's subnet. */
  | 'psc'
  /** The private link's service connection policy for Cloud SQL. */
  | 'psc-sql'
  /** The private link's service connection policy for Memorystore. */
  | 'psc-redis'
  /** The firewall rule opening Redis's ports to the private link. */
  | 'psc-redis-ports'
  /** The private `run.app` zone of its Private web services. */
  | 'run-app'
  /** The Cloud Router its Stack VMs' Cloud NAT is on. */
  | 'router'
  /** The Cloud NAT its Stack VMs go out through. */
  | 'nat';

/** The name of one of an Environment network's things. */
export function networkName(environmentId: string, part: NetworkPart): string {
  return `${networkNamePrefix(environmentId)}${part}`;
}

/** What every name of an Environment network's things starts with: the one search by name a network's read makes. */
export function networkNamePrefix(environmentId: string): string {
  return `${PREFIX}-${idKey(environmentId)}-`;
}

/**
 * The name of a Domain's DNS authorization, certificate and certificate map
 * entry: three kinds, so one name serves all three.
 */
export function domainName(domainId: string): string {
  return `${PREFIX}-${idKey(domainId)}`;
}

/**
 * The name of a Domain's certificate and its map entry: the Domain's own
 * name for its first, and the attempt after it for each new one (Ask again,
 * a new host), so the new pair never meets the old one's name.
 */
export function domainCertificateName(
  domainId: string,
  attempt: number,
): string {
  const name = domainName(domainId);
  return attempt <= 1 ? name : `${name}-${attempt}`;
}
