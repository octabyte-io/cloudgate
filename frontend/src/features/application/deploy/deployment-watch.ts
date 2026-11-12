import {
  QueryObserver,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import {
  deploymentsApi,
  type Deployment,
  type DeploymentStatus,
} from "@/lib/api/endpoints/deployments";
import { keys, type OrganizationScope } from "@/lib/api/keys";
import type { LiveLog, LogEnding } from "@/lib/realtime/live-log";

/**
 * How often a Deployment log polls its Deployment's status on its own — the
 * page's `LIVE_POLL_MS`, which it does in the page's place once the page is
 * gone.
 */
const WATCH_POLL_MS = 4_000;

/** The statuses a build does not leave, and what its log says about each. */
const FINAL: Partial<Record<DeploymentStatus, LogEnding>> = {
  done: {
    mark: "finished",
    words: "Succeeded",
    sentence: "The build succeeded.",
  },
  error: { mark: "failed", words: "Failed", sentence: "The build failed." },
  cancelled: {
    mark: "stopped",
    words: "Cancelled",
    sentence: "The build was cancelled.",
  },
};

/**
 * The page's own Deployments query for this row — the same key and the same
 * read `useApplicationDeployments` and `useComposeDeployments` make — or
 * `null` for a Deployment that is neither an Application's nor a stack's.
 */
function feedOf(
  organizationId: OrganizationScope,
  deployment: Deployment,
): { queryKey: QueryKey; queryFn: () => Promise<Deployment[]> } | null {
  if (deployment.applicationId) {
    const id = deployment.applicationId;
    return {
      queryKey: keys.deployments.byApplication(organizationId, id),
      queryFn: () => deploymentsApi.listByApplication(id),
    };
  }
  if (deployment.composeId) {
    const id = deployment.composeId;
    return {
      queryKey: keys.deployments.byCompose(organizationId, id),
      queryFn: () => deploymentsApi.listByCompose(id),
    };
  }
  return null;
}

/**
 * How a Deployment's log ended, by its status, or `null` for one not over —
 * `pending`, `running`, or `held`, which waits to build. What a live log ends
 * with when its build does, and what a finished one is docked with.
 */
export function deploymentEnding(status: DeploymentStatus): LogEnding | null {
  return FINAL[status] ?? null;
}

/**
 * Have a Deployment log learn when its build is over, wherever the log is
 * read — on its page or in the Dock after the page is gone.
 *
 * A TanStack `QueryObserver` on the app-wide client, on the key the page
 * uses: while the page is mounted it polls and this only listens, so there is
 * one fetch, not two. Once this is the query's only observer it polls in the
 * page's place. On a final status the log ends — its socket closes, every line
 * it holds stays, and it says how the build ended. It does not switch to the
 * settled REST read the page makes: the lines it holds are the record.
 *
 * Returns the stop, which the log calls when it ends, or `null` before the
 * Organization is known — nothing started, so `LiveLog.watch` tries again. A
 * Deployment that is neither an Application's nor a stack's has no feed to
 * watch at all and gets a stop that does nothing.
 */
export function watchDeployment(
  client: QueryClient,
  organizationId: OrganizationScope,
  deployment: Deployment,
  log: LiveLog,
): (() => void) | null {
  if (organizationId === null) return null;
  const feed = feedOf(organizationId, deployment);
  if (!feed) return () => {};

  const observer = new QueryObserver(client, {
    ...feed,
    // Rows the page already read are current enough; a new observer is not a
    // reason for a second read of them.
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const settle = (rows: Deployment[] | undefined) => {
    const row = rows?.find(
      (each) => each.deploymentId === deployment.deploymentId,
    );
    const ending = row ? deploymentEnding(row.status) : null;
    if (ending) log.end(ending);
  };

  const unsubscribe = observer.subscribe((result) => settle(result.data));
  const poll = setInterval(() => {
    const query = client
      .getQueryCache()
      .find({ queryKey: feed.queryKey, exact: true });
    // The page's own observer polls while it is mounted.
    if ((query?.getObserversCount() ?? 0) > 1) return;
    void observer.refetch();
  }, WATCH_POLL_MS);
  settle(observer.getCurrentResult().data);

  return () => {
    clearInterval(poll);
    unsubscribe();
  };
}
