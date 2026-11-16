/**
 * The address as sslip.io can answer from it, or `null` if it cannot.
 *
 * sslip.io resolves the literal written into the name and nothing else, so a
 * value that is not one is an unresolvable host by the time it reaches a
 * browser — which is the whole point. Settings → Instance now saves only an IP
 * (`SettingsService.updateServerIp`), but an instance that saved a hostname
 * there before keeps it, and `SettingsService.getInstanceUrl` still builds
 * links out of it, so a hostname can still be read here and names nothing.
 *
 * Shape only — an IPv4 quad, or the hex-and-colons of an IPv6 address. Nothing
 * here asks whether the address reaches this machine, which is not a question
 * this process can answer about its own NAT.
 *
 * **Shared by the generated hosts that name a machine by address**: the
 * domains dialog's `DomainsService.generateDomain` and a Preview
 * deployment's host when its Application sets no wildcard. The census in
 * `test/domains/generated-host-address.spec.ts` drives both readers of
 * `server_ip` over the same values.
 *
 * A literal check, not an extraction: the console's `dns-helper.tsx` reads an
 * address back *out of* a finished sslip.io name, which is the opposite job,
 * and the two carry different names so neither reads as the other.
 */
export const ipLiteral = (value: string): string | null => {
  const trimmed = value.trim();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
    const octets = trimmed.split('.').map(Number);
    return octets.every((octet) => octet <= 255) ? trimmed : null;
  }
  if (trimmed.includes(':') && /^[0-9a-f:]+$/i.test(trimmed)) return trimmed;
  return null;
};
