/**
 * What a Server's address may be: an IP address or a DNS hostname.
 *
 * The console's copy of `backend/src/servers/server-address.ts`, so the dialog
 * refuses `bad host!!` beside the field instead of saving it to fail later as
 * `getaddrinfo ENOTFOUND` on Infrastructure. Both copies are tested against the
 * same cases.
 *
 * IPv4 is a hostname as far as this pattern goes (digits are valid labels), and
 * IPv6 is checked by asking the URL parser to read it in brackets — the browser
 * already knows that grammar, and a hand-written one would be the thing to get
 * wrong.
 */
const HOSTNAME =
  /^(?=.{1,253}\.?$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

export const SERVER_ADDRESS_MESSAGE =
  "An address is an IP address or a hostname, like 203.0.113.10 or vps.example.com — no user, port or scheme.";

function isIPv6(value: string): boolean {
  if (!value.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

export function isServerAddress(value: string): boolean {
  return HOSTNAME.test(value) || isIPv6(value);
}
