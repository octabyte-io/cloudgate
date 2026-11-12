import type { Column } from "@/components/console/data-table";
import { RowTime } from "@/components/console/rows/cells";
import { StatusPill } from "@/components/console/status-pill";
import { Icon } from "@/lib/design/icons";
import type { PullRequestPreview } from "@/lib/api/endpoints/preview-deployments";

/**
 * A preview deployment as a row — one declaration per column, the way F09's
 * `domain-columns.tsx` does it, so a column inserted here cannot land under the
 * wrong header.
 *
 * **Two of the five columns are links out**, and that is what the row is for:
 * the pull request this preview belongs to, and the host it answers on. A
 * preview exists to be *looked at*, so getting from the row to the running copy
 * has to be one click; both open in a new tab, because leaving the console to
 * check a preview and losing your place in it is the obvious annoyance.
 *
 * The host links at `url`, the one the backend prints for it — `https://` only
 * where a stored certificate covers the host, the same link the pull-request
 * comment carries — and an `http://` link's `urlNote` is its tooltip.
 *
 * `previewStatus` is the real `applicationStatus` enum, so it goes through
 * `StatusPill` untranslated — no second vocabulary for the same four states.
 */
export function previewColumns({
  actions,
}: {
  actions: (row: PullRequestPreview) => React.ReactNode;
}): Column<PullRequestPreview>[] {
  return [
    {
      id: "pullRequest",
      head: "Pull request",
      tone: "key",
      truncate: true,
      cell: (row) => (
        <a
          href={row.pullRequestURL}
          target="_blank"
          rel="noreferrer noopener"
          title={row.pullRequestTitle}
          className="inline-flex max-w-full items-center gap-1.5 text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
        >
          <span className="num">#{row.pullRequestNumber}</span>
          <span className="min-w-0 truncate">{row.pullRequestTitle}</span>
          <Icon name="ext" size={13} className="flex-none" />
        </a>
      ),
      compare: (a, b) => a.pullRequestNumber.localeCompare(b.pullRequestNumber),
    },
    {
      id: "branch",
      head: "Branch",
      cell: (row) => (
        <span className="font-mono text-meta whitespace-normal text-tx-2 wrap-anywhere">
          {row.branch}
        </span>
      ),
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
      cell: (row) => <StatusPill status={row.previewStatus} />,
      compare: (a, b) => a.previewStatus.localeCompare(b.previewStatus),
    },
    {
      id: "createdAt",
      head: "Opened",
      cell: (row) => <RowTime iso={row.createdAt} />,
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      className: "w-0",
      cell: (row) => (
        <span className="inline-flex justify-end gap-1.5 whitespace-nowrap">
          {actions(row)}
        </span>
      ),
    },
  ];
}
