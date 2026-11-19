import Link from "next/link";

import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import type { Domain } from "@/lib/api/endpoints/domains";
import { Icon } from "@/lib/design/icons";

import { CertificateCell, ServedCertificateLine } from "./served-certificate";
import { useApplicationDomains } from "./use-domains";

const LINK =
  "font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline";

/**
 * How this Application is reached, in the rail on the Overview tab.
 *
 * The reference has a "Domain" card here with a URL, a port, a certificate and a
 * previews row (`e-console.html:4190-4198`). This is the same card with the
 * previews row gone — preview deployments are a whole feature with its own columns
 * and no screen yet — and with the honest plural: an Application can have several
 * domains, and a rail card that names only the first would hide the rest.
 *
 * With no domains at all it says so and points at the tab that adds one, rather
 * than disappearing. A missing card is a question nobody knows to ask.
 */
export function DomainsAside({ applicationId }: { applicationId: string }) {
  const domains = useApplicationDomains(applicationId);
  return (
    <DomainsAsideCard
      rows={domains.data}
      pending={domains.isPending}
      tab={`/applications/${applicationId}/domains`}
      noun="Application"
      unreached="its internal name reaches it"
    />
  );
}

/**
 * The rail card itself, for any parent with domains: the Application's
 * above, and a Compose stack's (`ComposeDomainsAside`).
 */
export function DomainsAsideCard({
  rows = [],
  pending,
  tab,
  noun,
  unreached,
  service = false,
}: {
  rows?: readonly Domain[];
  pending: boolean;
  /** The Domains tab, where a domain is added and the rest are listed. */
  tab: string;
  noun: string;
  /** What reaches it while it has no domain. */
  unreached: string;
  /** Whether to name the compose service the first domain routes into. */
  service?: boolean;
}) {
  const first = rows[0];

  return (
    <Card>
      <Card.Header
        title={rows.length > 1 ? "Domains" : "Domain"}
        sub={
          rows.length > 1
            ? `${rows.length} hosts route to this ${noun}.`
            : undefined
        }
        headingLevel={2}
      />
      <Card.Body>
        {pending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        ) : !first ? (
          <p className="text-body text-tx-2">
            <Link href={tab} className={LINK}>
              Add a domain
            </Link>{" "}
            to reach this {noun} from the internet. Until then only {unreached}.
          </p>
        ) : (
          <KVList>
            <KVRow
              label="URL"
              title={first.host}
              value={
                <span className="grid min-w-0 gap-0.5">
                  <a
                    href={`${first.https ? "https" : "http"}://${first.host}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex max-w-full min-w-0 items-center gap-1.5 font-mono text-meta tracking-mono text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                  >
                    <span className="truncate">{first.host}</span>
                    <Icon
                      name="ext"
                      size={12}
                      className="flex-none opacity-70"
                    />
                  </a>
                  {/* While its certificate is being issued, or is not: beside
                      the address a browser would warn about (#130). */}
                  <ServedCertificateLine row={first} />
                </span>
              }
            />
            {service ? (
              <KVRow
                label="Service"
                value={first.serviceName ?? "unset"}
                mono
              />
            ) : null}
            <KVRow
              label="Container port"
              value={first.port === null ? "unset" : `:${first.port}`}
              mono
            />
            <KVRow
              label="Certificate"
              value={<CertificateCell row={first} />}
            />
            {rows.length > 1 ? (
              <KVRow
                label="Others"
                value={
                  <Link href={tab} className={LINK}>
                    {rows.length - 1} more
                  </Link>
                }
              />
            ) : null}
          </KVList>
        )}
      </Card.Body>
    </Card>
  );
}
