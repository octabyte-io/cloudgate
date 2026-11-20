import { checkServerIdentity, connect } from 'node:tls';
import type { PeerCertificate } from 'node:tls';

/**
 * What a Domain's host serves on 443 right now, as a browser would judge it
 * (#130): `valid` when the chain verifies against the trust store and the
 * certificate's names cover the host. Traefik's built-in "TRAEFIK DEFAULT
 * CERT", served until Let's Encrypt has answered, fails both.
 *
 * `issuer` and `notAfter` describe the certificate that was served, valid or
 * not; both are null when nothing was (refused, timed out, not TLS).
 */
export type ServedCertificate = {
  valid: boolean;
  issuer: string | null;
  notAfter: string | null;
};

const NOTHING_SERVED: ServedCertificate = {
  valid: false,
  issuer: null,
  notAfter: null,
};

/** A handshake that has not finished in this long is answered as nothing served. */
export const SERVED_CERTIFICATE_TIMEOUT_MS = 5_000;

/**
 * Reads the certificate `host` serves, by a TLS handshake with SNI set to it.
 *
 * **A handshake and nothing else.** No request is written and no byte is
 * read: the socket ends the moment the handshake does, so this cannot be
 * used to fetch anything from the address, only to see its certificate.
 * The callers pass a Domain's own stored host, never an address a request
 * named (`DomainsService.servedCertificate`).
 *
 * `rejectUnauthorized: false` so an untrusted certificate is still read and
 * reported rather than ending as an error; whether it is trusted is
 * `socket.authorized`, and whether it names the host is Node's own
 * `checkServerIdentity`, the check an HTTPS request makes.
 */
export function readServedCertificate(
  host: string,
  {
    port = 443,
    timeoutMs = SERVED_CERTIFICATE_TIMEOUT_MS,
    ca,
  }: {
    port?: number;
    timeoutMs?: number;
    /** Trust anchors in place of Node's own; the tests' local CA. */
    ca?: string | string[];
  } = {},
): Promise<ServedCertificate> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: ServedCertificate) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const socket = connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: false,
      ...(ca === undefined ? {} : { ca }),
    });
    const timer = setTimeout(() => finish(NOTHING_SERVED), timeoutMs);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      if (!certificate || Object.keys(certificate).length === 0) {
        finish(NOTHING_SERVED);
        return;
      }
      finish({
        valid:
          socket.authorized &&
          checkServerIdentity(host, certificate) === undefined,
        issuer: issuerName(certificate),
        notAfter: notAfterOf(certificate),
      });
    });
    socket.once('error', () => finish(NOTHING_SERVED));
  });
}

/** The issuing organization, as a browser's padlock names it; else its CN. */
function issuerName(certificate: PeerCertificate): string | null {
  const issuer = certificate.issuer as
    Partial<Record<'O' | 'CN', string | string[]>> | undefined;
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  return first(issuer?.O) ?? first(issuer?.CN);
}

function notAfterOf(certificate: PeerCertificate): string | null {
  const at = new Date(certificate.valid_to);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
