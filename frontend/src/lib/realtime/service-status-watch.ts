import {
  QueryObserver,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import type { ApplicationStatus } from "@/lib/api/endpoints/applications";

import type { LiveLog, LogEnding } from "./live-log";

/** A row whose `applicationStatus` says whether its Swarm service runs. */
type StatusRow = { applicationStatus: ApplicationStatus };

/**
 * Have a Service's Runtime log on a Server or the platform host follow its
 * row's status wherever the log is read — on its page, or in the Dock once
 * the page is gone — with the page box's rules (`ServiceOutput`). Shared by a
 * database's Container output and an Application's Logs tab (#1341).
 *
 * A TanStack `QueryObserver` on the app-wide client, on the key the page's
 * own hook uses: while the page is mounted it reads and polls, and this only
 * listens, so there is one fetch, not two. Once this is the row's only
 * observer it polls in the page's place, on the page's rule — while the row
 * says `running`. A Start, Stop or Deploy pressed anywhere in the console
 * invalidates the row, which this, being an observer, reads again.
 *
 * - `stopped` rests the log: the socket stays, and no cursor is drawn.
 * - While the Dock holds the log, `idle` holds it closed — nothing to follow —
 *   and moving to `done` dials it again, since a converge that finished is a
 *   service that exists now. While the page holds it, the page box does both.
 *
 * Returns the stop, which the log calls when it ends.
 */
export function watchServiceStatus<Row extends StatusRow>(options: {
  client: QueryClient;
  queryKey: QueryKey;
  queryFn: () => Promise<Row>;
  /** The status the page last read, before the observer has an answer. */
  status: ApplicationStatus;
  log: LiveLog;
  /** What the log says while the Service is stopped. */
  stopped: LogEnding;
  pollMs: number;
}): () => void {
  const { client, queryKey, queryFn, log, stopped, pollMs } = options;

  const observer = new QueryObserver(client, {
    queryKey,
    queryFn,
    // The row the page already read is current enough; a new observer is not
    // a reason for a second read of it.
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  let was = options.status;
  const settle = (row: Row | undefined) => {
    if (!row) return;
    const status = row.applicationStatus;
    const before = was;
    was = status;
    log.rest(status === "stopped" ? stopped : null);
    if (log.owner !== "dock") return;
    if (status === "idle" && before !== "idle") {
      log.hangUp();
      log.open(null);
    } else if (status === "done" && before !== "done") {
      log.redial();
    }
  };

  const unsubscribe = observer.subscribe((result) => settle(result.data));
  const poll = setInterval(() => {
    const query = client.getQueryCache().find({ queryKey, exact: true });
    // The page's own observer polls while it is mounted.
    if ((query?.getObserversCount() ?? 0) > 1) return;
    if (observer.getCurrentResult().data?.applicationStatus !== "running") {
      return;
    }
    void observer.refetch();
  }, pollMs);
  settle(observer.getCurrentResult().data);

  return () => {
    clearInterval(poll);
    unsubscribe();
  };
}
