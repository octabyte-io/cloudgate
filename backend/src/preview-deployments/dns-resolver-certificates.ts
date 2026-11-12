import { quote } from 'shell-quote';

import type { DrizzleDB } from '../db/drizzle.module';
import { execOnServer } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { dnsChallengeOn } from '../settings/dns-challenge.read';
import { DNS_CHALLENGE_RESOLVER } from '../settings/dns-challenge.schema';
import { dynamicTraefikDirectory } from '../traefik/traefik-writer.service';

/**
 * A certificate Traefik's DNS-01 resolver issued, read out of one machine's
 * `acme.json`: the machine and the PEM chain, and nothing else.
 */
export interface ResolverCertificate {
  /** The machine whose `acme.json` held it; `null` is the platform host. */
  serverId: string | null;
  /** The PEM chain, leaf first. */
  certificateData: string;
}

/**
 * Where Traefik keeps a machine's ACME account and certificates, on the
 * machine rather than in the container: `dynamic/` is bind-mounted into
 * Traefik at `/etc/cloudgate/traefik/dynamic`, and every resolver's `storage`
 * names `acme.json` there — `servers/server-setup.ts`' `ACME_STORAGE` on a
 * Server, and `deploy/install.sh`'s heredoc (pinned to
 * `deploy/traefik/traefik.yml.example`) on the platform host, whose bind
 * source is `$CLOUDGATE_DIRECTORY/traefik/dynamic`. The DNS-01 resolver shares
 * the file with `letsencrypt`; Traefik keys each resolver's section by name.
 */
export const acmeStoragePath = (serverId: string | null): string =>
  `${dynamicTraefikDirectory(serverId)}/acme.json`;

/**
 * The program that reads `acme.json` **with every private key blanked on the
 * machine**, so no key crosses SSH or reaches this process: each certificate's
 * `key` and the account's `PrivateKey`. Traefik writes the file with Go's
 * `json.MarshalIndent`, where a string value is always on one line and base64
 * carries no `"`, so one substitution per line empties the value and leaves
 * the JSON parseable. Argv, not a shell string: `sed` is the program and the
 * path one word (`remote/exec-dispatch.ts`).
 */
export const acmeCertificatesCommand = (serverId: string | null): string[] => [
  'sed',
  '-E',
  's/"(key|PrivateKey)"[[:space:]]*:[[:space:]]*"[^"]*"/"\\1": ""/g',
  acmeStoragePath(serverId),
];

/**
 * How `acme.json` is read on the machine that holds it: the
 * {@link acmeCertificatesCommand} argv as is on the platform host, where the
 * backend runs as root (`common/files/owner-only.ts`), and on a Server a shell
 * program that runs the same argv as root.
 *
 * On a Server the file is root's, `0600`: Traefik runs as root in its
 * container and creates it through the bind mount, while
 * `servers/server-setup.ts` hands the rest of the Cloudgate tree to the SSH
 * user. So a plain `sed` works only when that user is root. The program
 * decides the way `serverSetupCommand`'s `SUDO_CMD` and `server-audit.ts`'
 * `validateSudoAccess` do — root runs it directly, anyone else through
 * `sudo -n`, which fails rather than prompting when sudo would want a
 * password, and a failed read is "not issued". Every word is `quote()`d, since
 * a program is not argv (`remote/exec-dispatch.ts`).
 */
export const acmeCertificatesRead = (
  serverId: string | null,
): string | string[] => {
  const argv = acmeCertificatesCommand(serverId);
  if (serverId === null) return argv;
  const words = quote(argv);
  return `if [ "$(id -u)" -eq 0 ]; then ${words}; else sudo -n ${words}; fi`;
};

/**
 * The PEM chains `acme.json`'s {@link DNS_CHALLENGE_RESOLVER} section holds,
 * decoded from base64 — and only its `certificate` fields: the other resolvers'
 * certificates are not DNS-01's, and each entry's `key` is never read, even
 * where the machine-side blanking missed one. Anything that is not the shape
 * Traefik writes gives none rather than throwing: an unreadable file is "not
 * issued", never a failed read.
 */
export function dnsResolverCertificatesIn(acmeJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(acmeJson);
  } catch {
    return [];
  }
  const section = (parsed as Record<string, unknown> | null)?.[
    DNS_CHALLENGE_RESOLVER
  ] as { Certificates?: unknown } | undefined;
  const entries = section?.Certificates;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    const encoded = (entry as { certificate?: unknown } | null)?.certificate;
    if (typeof encoded !== 'string' || encoded === '') return [];
    return [Buffer.from(encoded, 'base64').toString('utf8')];
  });
}

/**
 * The DNS-01 resolver's certificates on one machine, for `previewUrl`:
 * none when the machine has no DNS-01 setup — its row is the only thing that
 * says the resolver exists — and otherwise whatever its `acme.json` holds for
 * that resolver. One read per machine: the caller asks once per list, since
 * every preview of an Application runs on its run Server.
 *
 * **Never fails.** A file that is missing, unreadable, or not Traefik's shape
 * is "not issued", so a preview's read answers `http://` with a note rather
 * than an error.
 */
export async function dnsResolverCertificatesOn(
  db: DrizzleDB,
  remoteExec: RemoteExecService,
  serverId: string | null,
): Promise<ResolverCertificate[]> {
  if ((await dnsChallengeOn(db, serverId)) === null) return [];
  let stdout: string;
  try {
    ({ stdout } = await execOnServer(
      remoteExec,
      serverId,
      acmeCertificatesRead(serverId),
    ));
  } catch {
    return [];
  }
  return dnsResolverCertificatesIn(stdout).map((certificateData) => ({
    serverId,
    certificateData,
  }));
}
