import { isIP } from 'node:net';

/**
 * What a Server's `ipAddress` may hold: an IP address (v4 or v6) or a DNS
 * hostname.
 *
 * The column was `.min(1)`, so `bad host!!` was saved and the mistake surfaced
 * only later, as `getaddrinfo ENOTFOUND bad host!!` on Infrastructure — after
 * the operator had left the dialog where it could be fixed. A hostname is
 * labels of letters, digits and hyphens, each 1–63 characters and not starting
 * or ending in a hyphen, at most 253 in all (RFC 1123), with an optional
 * trailing dot. No scheme, no port, no path: `ssh2` is handed this as `host`.
 *
 * Mirrored in `frontend/src/features/server/fleet/server-address.ts`, so the
 * dialog refuses the same strings before a request is sent.
 */
const HOSTNAME =
  /^(?=.{1,253}\.?$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

export const SERVER_ADDRESS_MESSAGE =
  'ipAddress must be an IP address or a hostname, like 203.0.113.10 or vps.example.com';

export function isServerAddress(value: string): boolean {
  return isIP(value) !== 0 || HOSTNAME.test(value);
}
