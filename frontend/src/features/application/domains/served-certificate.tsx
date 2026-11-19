import Link from "next/link";

import type { Domain } from "@/lib/api/endpoints/domains";
import { useServedCertificate } from "@/lib/api/use-served-certificate";

import { certificateCell } from "./domain-columns";

const VALID_UNTIL = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * Whether a row's certificate is the one Traefik serves on its Server or
 * this Cloudgate host, which the served-certificate read can see. A cloud
 * Domain's is its cloud's (ACM, Certificate Manager), with its own states.
 */
function servedByTraefik(row: Domain): boolean {
  return row.https && row.cloud === undefined;
}

/**
 * A Domain's *Certificate*, with what its host **serves** right now beside
 * what it is set to (#130): set to Let's Encrypt is not the same as issued,
 * and until it is, Traefik serves its own self-signed certificate and every
 * browser warns. Read once per page load, and again every few seconds only
 * while it is being issued (`useServedCertificate`); the wait is counted from
 * the Domain's `createdAt`, so an old Domain is never called "issuing".
 *
 * A Let's Encrypt row says issuing, valid until a date, or not issued yet
 * with what to check. A stored or custom certificate keeps its own words,
 * with a warning only when what is served would not be trusted.
 *
 * `serverId` is the Server the Domain is served on, for the Traefik log the
 * ACME attempts are in; left out, the hint names the log without a link.
 */
export function CertificateCell({
  row,
  serverId,
}: {
  row: Domain;
  serverId?: string | null;
}) {
  const applies = servedByTraefik(row);
  const served = useServedCertificate(applies ? row.domainId : null, {
    enabled: applies,
    since: Date.parse(row.createdAt),
  });
  const base = certificateCell(row);
  if (!applies || served.state === "reading") return base;

  const letsEncrypt =
    row.certificateType === "letsencrypt" && !row.storedCertificate;
  if (!letsEncrypt) {
    if (served.state === "issued") return base;
    return (
      <span className="grid gap-0.5">
        <span>{base}</span>
        <span className="text-meta text-bad">
          Browsers warn here: what this host serves is not a trusted certificate
          for it.
        </span>
      </span>
    );
  }

  if (served.state === "issued") {
    return (
      <span>
        Let&apos;s Encrypt
        {served.notAfter ? (
          <span className="text-tx-2">
            {" "}
            · valid until {VALID_UNTIL.format(new Date(served.notAfter))}
          </span>
        ) : null}
      </span>
    );
  }
  if (served.state === "issuing") {
    return (
      <span className="grid gap-0.5">
        <span>
          Let&apos;s Encrypt
          <span className="text-tx-2"> · issuing, usually under a minute</span>
        </span>
        <span className="text-meta text-tx-2">
          Until it is, browsers warn about this address.
        </span>
      </span>
    );
  }
  return (
    <span className="grid gap-0.5">
      <span>
        Let&apos;s Encrypt
        <span className="text-bad"> · not issued yet</span>
      </span>
      <span className="text-meta text-tx-2">
        Check that the A record for {row.host}{" "}
        points at this Server&rsquo;s
        address and that port 80 is reachable. Each attempt is in{" "}
        {serverId ? (
          <Link
            href={`/servers/${encodeURIComponent(serverId)}/docker`}
            className="text-brand-tx underline-offset-3 hover:underline"
          >
            the Server&rsquo;s Traefik log
          </Link>
        ) : (
          "the Server's Traefik log"
        )}
        .
      </span>
    </span>
  );
}

/**
 * The line beside a Service's address on its Overview (#130): said while its
 * certificate is being issued or is not issued, and nothing once it is.
 */
export function ServedCertificateLine({ row }: { row: Domain }) {
  const applies = servedByTraefik(row);
  const served = useServedCertificate(applies ? row.domainId : null, {
    enabled: applies,
    since: Date.parse(row.createdAt),
  });
  if (!applies) return null;
  if (served.state === "issuing") {
    return (
      <span className="text-meta text-tx-2">
        HTTPS certificate issuing: your browser may warn for a minute.
      </span>
    );
  }
  if (served.state === "not-issued") {
    return (
      <span className="text-meta text-bad">
        HTTPS certificate not issued yet: browsers warn about this address.
      </span>
    );
  }
  return null;
}
