import { Chip } from "@/components/console/chip";
import type { Column } from "@/components/console/data-table";
import { Dash } from "@/components/console/dash";
import { RowLink, RowTime } from "@/components/console/rows/cells";
import { StatusPill } from "@/components/console/status-pill";
import type { RequestedPreview } from "@/lib/api/endpoints/preview-deployments";
import { TONE_TEXT, type Mark } from "@/lib/design/status";
import { timeAgo, timeExact } from "@/lib/format/time";
import { cn } from "@/lib/utils";

/** The last stretch of a window, in which the expiry reads as a warning. */
const SOON_MS = 10 * 60_000;

/**
 * An expired Requested preview: nothing more is built into it, and it
 * stays listed until the sweep has its running copy gone. Muted like
 * `cancelled`, whose glyph it borrows, because nothing is wrong with it.
 *
 * **The pill says only "expired"**, and "teardown pending" goes on a line
 * under it ({@link ExpiredStatus}). A pill does not wrap, and the whole phrase
 * in one was wide enough to push the table past its card: it grew a
 * horizontal scrollbar and clipped the Actions column the moment a row
 * expired, which is when the live rows' controls matter most.
 */
const EXPIRED: Mark = {
  glyph: "⊘",
  tone: "mute",
  label: "expired",
};

export const isExpired = (row: RequestedPreview) => row.expiredAt !== null;

/** Whether `expiresAt` is inside its last ten minutes, read against `now`. */
export function expiresSoon(expiresAt: string, now = Date.now()): boolean {
  const left = new Date(expiresAt).getTime() - now;
  return left <= SOON_MS;
}

/**
 * A Requested preview as a row, in the order the spec gives: branch, host, status,
 * requested by, expires, latest build, created — then its controls.
 *
 * **Requested by is the create audit row's name**, not the user row's, so a
 * requester who has since been removed is still named, and tagged with where
 * they stand now. **Expires** is relative, with the exact stamp on hover, and
 * turns to a warning in the last ten minutes, which is the stretch in which
 * somebody watching has to decide to extend. **Latest build** opens the
 * parent's Deployments tab, where a preview's builds are listed among the
 * parent's own — there is no Deployment page of its own to link.
 */
export function requestedPreviewColumns({
  applicationId,
  actions,
}: {
  applicationId: string;
  actions: (row: RequestedPreview) => React.ReactNode;
}): Column<RequestedPreview>[] {
  return [
    {
      id: "branch",
      head: "Branch",
      tone: "key",
      cell: (row) => (
        <span className="font-mono text-meta text-tx">{row.branch}</span>
      ),
      compare: (a, b) => a.branch.localeCompare(b.branch),
    },
    {
      id: "domain",
      head: "Host",
      tone: "wrap",
      cell: (row) => (
        <a
          href={row.url}
          title={row.urlNote}
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono text-meta wrap-anywhere text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
        >
          {row.domain}
        </a>
      ),
    },
    {
      id: "status",
      head: "Status",
      cell: (row) =>
        isExpired(row) ? (
          <ExpiredStatus />
        ) : (
          <StatusPill status={row.previewStatus} />
        ),
    },
    {
      id: "requestedBy",
      head: "Requested by",
      cell: (row) => <RequestedBy row={row} />,
    },
    {
      id: "expiresAt",
      head: "Expires",
      cell: (row) => <Expires row={row} />,
      compare: (a, b) => a.expiresAt.localeCompare(b.expiresAt),
    },
    {
      id: "latestBuild",
      head: "Latest build",
      cell: (row) =>
        row.latestDeploymentId === null ? (
          <Dash word="None yet" />
        ) : (
          <RowLink
            href={`/applications/${applicationId}/deployments`}
            className="font-mono text-meta font-normal"
          >
            <span title="Listed on this Application's Deployments tab">
              {row.latestDeploymentId.slice(0, 8)}
            </span>
          </RowLink>
        ),
    },
    {
      id: "createdAt",
      head: "Created",
      cell: (row) => <RowTime iso={row.createdAt} />,
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      className: "w-0",
      cell: (row) =>
        isExpired(row) ? null : (
          <span className="inline-flex justify-end gap-1.5 whitespace-nowrap">
            {actions(row)}
          </span>
        ),
    },
  ];
}

/** "expired, teardown pending", as a pill no wider than any other status. */
function ExpiredStatus() {
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <StatusPill mark={EXPIRED} />
      <span className="text-meta text-tx-3">
        {/* Read as one phrase, and found as one by the card's tests. */}
        <span className="sr-only">, </span>
        teardown pending
      </span>
    </span>
  );
}

function RequestedBy({ row }: { row: RequestedPreview }) {
  const by = row.requestedBy;
  if (by === null || by.name === null) {
    return <span className="text-tx-3">Not recorded</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-tx">{by.name}</span>
      {by.standing === "member" ? null : <Chip>{by.standing}</Chip>}
    </span>
  );
}

function Expires({ row }: { row: RequestedPreview }) {
  // An expired row's clock is when it went, and it is past warning about.
  const at = row.expiredAt ?? row.expiresAt;
  const soon = !isExpired(row) && expiresSoon(row.expiresAt);
  return (
    <time
      data-expiry=""
      data-soon={soon}
      dateTime={at}
      title={timeExact(at)}
      className={cn(soon ? cn(TONE_TEXT.warn, "font-medium") : "text-tx-2")}
    >
      {timeAgo(at)}
    </time>
  );
}
