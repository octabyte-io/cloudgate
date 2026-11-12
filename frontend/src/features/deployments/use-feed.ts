import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { TIME_RANGES } from "@/components/console/time-range";
import { useRecents } from "@/components/shell/recents";
import {
  deploymentsApi,
  type DeploymentFeedPage,
  type DeploymentFeedRow,
} from "@/lib/api/endpoints/deployments";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The Organization's Deployment feed — **`GET /deployments`, the route this
 * screen has always documented**.
 *
 * **What this used to be, and why the change is not a refactor.** It assembled
 * the feed by fanning out over the services in Recents, because when it was
 * written the only reads were `GET /applications/:id/deployments` and its
 * Compose sibling. That made the page answer *"what have I looked at lately"*
 * where it promised *"what has deployed lately"*: on an instance with sixteen
 * runs across five services it showed two, both belonging to the one
 * Application opened earlier in the session, and on a fresh session it showed
 * nothing at all.
 * The route answers the whole Organization in one request and had done for some
 * time; nothing was wired to it.
 *
 * **Recents is now a filter over the feed, not the feed's query** — the
 * distinction the fix turns on. "Only the services I have open" is a useful
 * thing to ask a complete list for. It is not an acceptable definition of the
 * list.
 *
 * **All five owner kinds arrive.** The old feed could reach two of them: it
 * walked services, and a scheduled run or a volume backup belongs to a cron
 * entry rather than to the service it ran against. The route resolves every run
 * to its service in SQL (`deployments/service-scope.ts`), so those rows are in
 * this feed like any build, and the screen's callout about them is deleted
 * rather than kept.
 */

/** The route's own cap (`listDeploymentsSchema`); anything higher is a 400. */
const PAGE = 100;

/**
 * How far back one read goes: the widest window the screen offers. Every range
 * on the control is a slice of what this loads, so changing the range filters
 * rows already in hand rather than re-reading — which is what makes the status
 * counts beside each word mean anything.
 */
const HORIZON_SECONDS = Math.max(...TIME_RANGES.map((range) => range.seconds));

/**
 * The ceiling on that walk. Ten pages is a thousand runs inside the widest
 * window, which no instance this console is built for reaches; an instance that
 * does gets a truthful sentence saying the oldest of the window is missing
 * rather than a page that walks for a minute.
 */
const MAX_PAGES = 10;

/** What one read of the feed found, and whether it reached the far end. */
export interface FeedWindow {
  rows: DeploymentFeedRow[];
  /**
   * True when the walk stopped at `MAX_PAGES` with older rows still inside the
   * window — the one case where the screen holds a partial list and has to say so.
   */
  truncated: boolean;
}

export interface Feed extends FeedWindow {
  pending: boolean;
  /** True while a refetch is in flight, for the hold-the-frame treatment. */
  fetching: boolean;
  /** Non-null when the read failed. The table says so instead of showing zero rows. */
  error: unknown;
  refetch: () => void;
}

/** One page of the feed, as the walk below asks for it. */
type ReadPage = (cursor: string | undefined) => Promise<DeploymentFeedPage>;

/**
 * Walk the cursor until the window is covered.
 *
 * Rows arrive newest first, so the first row older than the horizon means every
 * row after it is older too and the walk is done — the pages are ordered, which
 * is the whole reason a keyset cursor is worth having. Exported for its test:
 * the behaviour worth pinning is that it stops at the horizon, stops at the last
 * page, and stops at the cap, and each of those is a different reason.
 */
export async function readFeedWindow(
  read: ReadPage,
  oldest: number,
): Promise<FeedWindow> {
  const rows: DeploymentFeedRow[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await read(cursor);
    rows.push(...answer.rows);

    const last = answer.rows[answer.rows.length - 1];
    const reachedHorizon =
      last !== undefined && Date.parse(last.createdAt) < oldest;
    if (reachedHorizon || !answer.nextCursor) return { rows, truncated: false };

    cursor = answer.nextCursor;
  }

  return { rows, truncated: true };
}

/**
 * Every Deployment in this Organization inside the widest window the screen
 * offers, newest first.
 *
 * Keyed on `deployments.all` with no filter in the key, deliberately: the two
 * filters the route accepts — a status and a Project — are applied on the screen
 * instead, because the counts beside the status words have to describe the pool
 * *before* the status filter, and a count that changed when you clicked it would
 * be useless. One read, filtered four ways in the browser.
 */
export function useDeploymentFeed(): Feed {
  const { organizationId } = useActiveOrganizationId();

  const query = useQuery({
    queryKey: keys.deployments.all(organizationId),
    queryFn: ({ signal }) =>
      readFeedWindow(
        (cursor) => deploymentsApi.list({ limit: PAGE, cursor }, signal),
        Date.now() - HORIZON_SECONDS * 1_000,
      ),
    enabled: organizationId !== null,
  });

  return {
    rows: query.data?.rows ?? [],
    truncated: query.data?.truncated ?? false,
    // `enabled: false` while the session loads reads as pending, which is what
    // the screen wants: a skeleton, never an empty table claiming the
    // Organization has deployed nothing.
    pending: query.isPending,
    fetching: query.isFetching,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/**
 * The Applications and Compose stacks this session has opened, by id — the pool
 * the "services you have opened" filter narrows the feed to.
 *
 * Recents holds five entries shared with Servers, Projects, Environments and
 * databases, so this is a handful at most and often empty. That is fine for a
 * filter and was never fine for a query.
 */
export function useRecentServiceIds(): string[] {
  const recents = useRecents();
  // Recents changes identity on every write, so the derived list is memoized on
  // the hrefs rather than on the array.
  const hrefs = recents.map((entry) => entry.href).join("|");
  return useMemo(() => recentServiceIds(hrefs.split("|")), [hrefs]);
}

/**
 * The service ids among a set of Recents hrefs.
 *
 * A managed database is in Recents too and contributes nothing: its deploy
 * writes no `deployment` row, so no row in this feed is owned by one. Its
 * *backups* do write rows — and those are owned by the backup, not by the
 * database, so they are not matched by an id here either.
 */
export function recentServiceIds(hrefs: readonly string[]): string[] {
  const ids: string[] = [];
  for (const href of hrefs) {
    const match = /^\/(?:applications|compose)\/([^/]+)$/.exec(href);
    if (match) ids.push(match[1]);
  }
  return ids;
}
