import type { Column } from "@/components/console/data-table";
import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { Icon } from "@/lib/design/icons";
import type { Domain } from "@/lib/api/endpoints/domains";

/**
 * A domain, as a table row (the reference's `svcDomainsTab`,
 * `e-console.html:4250-4276`).
 *
 * **The reference's Status column is absent.** It renders `pill("active")` on every
 * row, and there is no such column: a `domain` row has a host, a port and a
 * certificate type, and nothing anywhere says whether Traefik is currently serving
 * it or whether a certificate was actually issued. A green "active" on every domain
 * — including one whose DNS points nowhere — is the most confident possible lie in
 * the place people trust most. What replaces it is **Check DNS**, which asks a
 * resolver and reports what it actually found.
 *
 * The host is a link when it is reachable at all, and a link is honest here even
 * before DNS resolves: it goes where the operator said it should go, and finding
 * out that it does not work yet is the point of clicking it.
 */
export function domainColumns({
  action,
  service,
  gate,
  troubled,
}: {
  action: (row: Domain) => React.ReactNode;
  /**
   * The compose service this host routes into — **F12 only**.
   *
   * An Application has one container, so there is nothing to say; a stack has
   * several, and a domain that does not name one makes the *deploy* throw
   * (`addDomainsToComposeSpec`). Passing this adds the column; omitting it leaves
   * the table exactly as F09 built it.
   */
  service?: (row: Domain) => string | null;
  /**
   * The forward-auth switch — **F18 only, and Applications only**.
   *
   * The same additive shape `service` established: passing it adds the column,
   * omitting it leaves the table as it was. F18 owns
   * `features/enterprise/**` and the switch itself lives there; this is the one
   * line that puts it where the domain is.
   *
   * **It has to be here rather than on F18's own screen** because nothing
   * enumerates an Organization's domains. Enumerating the *services* works now,
   * so assembling that list is now a fan-out to decide on rather than a route
   * to wait for — while a switch on a row that already holds its `domainId`
   * needs neither. Deliberately not passed by F12: `findApplicationDomain`
   * refuses a Compose domain outright, because a stack's routers travel as
   * deploy-time labels which carry no middleware.
   */
  gate?: (row: Domain) => React.ReactNode;
  /**
   * Whether Traefik refused a router serving this host — **H-38's report, per
   * row**.
   *
   * It renders *inside* the Host cell rather than as a column of its own, and
   * that is the same decision this file's docblock makes about the reference's
   * Status column, arrived at from the other side. A column needs a value in
   * every row, and the only value the other rows could carry is silence: Traefik
   * logs nothing at all for a configuration it accepted, so a blank cell under a
   * "Routing" heading would be read as "fine" on rows nothing is known about.
   * A mark that appears only where there is something to say cannot make that
   * claim.
   */
  troubled?: (row: Domain) => boolean;
}): Column<Domain>[] {
  const columns: Column<Domain>[] = [
    {
      id: "host",
      head: "Host",
      tone: "key",
      className: "font-mono",
      // The host is what widened this table past its card at desktop width, and
      // the Actions went behind the scroll. It takes what the other
      // columns leave, and the link is capped to that so the host is what gets
      // the ellipsis — not the whole link, which is what an overflowing
      // `inline-flex` would be replaced with.
      truncate: true,
      compare: (a, b) => a.host.localeCompare(b.host),
      cell: (row) => (
        <span className="grid gap-0.5">
          <a
            href={`${row.https ? "https" : "http"}://${row.host}${row.path && row.path !== "/" ? row.path : ""}`}
            target="_blank"
            rel="noreferrer noopener"
            title={row.host}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            <span className="truncate">{row.host}</span>
            <Icon name="ext" size={12} className="flex-none opacity-70" />
          </a>
          {troubled?.(row) ? (
            // Words, not a dot: the meaning never rests on a hue
            // (`design-system.md`), and this row's link still looks exactly like
            // a working one — which is the point, since it is a host that
            // resolves and answers, with the wrong thing.
            <span className="text-meta whitespace-normal text-bad wrap-anywhere">
              Not being routed — Traefik refused this host&rsquo;s router
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "path",
      head: "Path",
      // A path has no space to wrap at; without this a long one widens the
      // table and pushes Actions behind the scroll.
      className: "font-mono whitespace-normal wrap-anywhere",
      // `flex-wrap`, so the "stripped" chip goes under the path rather than
      // adding its width to the column's minimum.
      cell: (row) =>
        row.path && row.path !== "/" ? (
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {row.path}
            {row.stripPath ? <Chip>stripped</Chip> : null}
          </span>
        ) : (
          <span className="text-tx-3">/</span>
        ),
    },
    {
      id: "port",
      head: "Port",
      tone: "num",
      className: "font-mono",
      compare: (a, b) => (a.port ?? 0) - (b.port ?? 0),
      cell: (row) => (row.port === null ? <Dash word="Unset" /> : row.port),
    },
    {
      id: "scheme",
      head: "Scheme",
      cell: (row) =>
        row.https ? (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="lock" size={13} className="text-tx-3" />
            HTTPS
          </span>
        ) : (
          <span className="text-tx-2">HTTP</span>
        ),
    },
    {
      id: "certificate",
      head: "Certificate",
      // Words, so they may wrap: "Not managed here" on one line was the widest
      // thing in its column, and every column's minimum is what put Remove
      // behind the scroll.
      className: "whitespace-normal",
      compare: (a, b) => a.certificateType.localeCompare(b.certificateType),
      cell: certificateCell,
    },
    {
      id: "action",
      head: <span className="sr-only">Actions</span>,
      tone: "num",
      cell: action,
    },
  ];

  if (gate) {
    columns.splice(columns.length - 1, 0, {
      id: "gate",
      head: "Sign-in",
      cell: gate,
    });
  }

  if (service) {
    columns.splice(1, 0, {
      id: "service",
      head: "Service",
      className: "font-mono",
      compare: (a, b) => (service(a) ?? "").localeCompare(service(b) ?? ""),
      // No `truncate`, which in an unbounded cell clipped nothing, and
      // not a truncating column either: a compose service name is short by
      // convention, and a second column sharing the slack would halve the
      // host's, which is the value that is actually long.
      cell: (row) => {
        const name = service(row);
        return name ? (
          name
        ) : (
          // Not a `Dash`: this is not a value that happens to be absent, it is a
          // domain the next deploy will refuse. Saying "None" would read as fine.
          <span className="text-meta text-bad">Names no service</span>
        );
      },
    });
  }

  return columns;
}

/**
 * The `certificateType` values, in words.
 *
 * `none` is not "no certificate" in the alarming sense — it is Traefik's own value
 * for "do not manage one here", which is right for a host behind a CDN that
 * terminates TLS itself. So it reads as a statement, not a warning.
 */
const CERTIFICATE: Record<
  Domain["certificateType"],
  (resolver: string | null) => React.ReactNode
> = {
  letsencrypt: () => "Let's Encrypt",
  none: () => <span className="text-tx-2">Not managed here</span>,
  custom: (resolver) => (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      Custom
      {resolver ? <Chip variant="mono">{resolver}</Chip> : null}
    </span>
  ),
  stored: () => "Stored certificate",
};

/**
 * Which certificate Traefik serves for the row, which is not always the one its
 * `certificateType` asks for.
 *
 * A stored certificate covering the host wins over a resolver — Traefik looks in
 * its store before it asks ACME — so a Let's Encrypt row the backend reports a
 * `storedCertificate` for is named by that certificate, with the choice it
 * overrides beside it, rather than called Let's Encrypt. A `stored` row with
 * nothing covering it (the certificate was deleted since) is the one warning:
 * Traefik answers it with its own self-signed default, which browsers refuse.
 * With HTTPS off no certificate is served, so the row says so whatever its
 * `certificateType`: a row saved before the backend stored none for
 * HTTPS off read "HTTP / Let's Encrypt".
 *
 * Shared with the Overview rail's `DomainsAside`, so the two cannot disagree.
 */
export function certificateCell(row: Domain): React.ReactNode {
  const stored = row.storedCertificate;
  if (!row.https) return CERTIFICATE.none(null);
  if (row.certificateType === "stored" && !stored) {
    return (
      <span className="text-meta text-bad">
        No stored certificate covers this host
      </span>
    );
  }
  if (!stored || row.certificateType === "none") {
    return CERTIFICATE[row.certificateType](row.customCertResolver);
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      Stored
      <Chip variant="mono">{stored.name}</Chip>
      {row.certificateType === "letsencrypt" ? (
        <span className="text-meta text-tx-2">
          instead of Let&apos;s Encrypt
        </span>
      ) : row.certificateType === "custom" ? (
        <span className="text-meta text-tx-2">instead of the resolver</span>
      ) : null}
    </span>
  );
}
