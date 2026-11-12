import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { DeploymentTable } from "@/components/console/rows/deployment-row";
import { Skeleton } from "@/components/console/skeleton";
import {
  rangeLabel,
  type TimeRangeValue,
} from "@/components/console/time-range";
import { Button } from "@/components/ui/button";
import type {
  Deployment,
  DeploymentFeedRow,
} from "@/lib/api/endpoints/deployments";
import { errorMessage } from "@/lib/api/error-message";
import { cn } from "@/lib/utils";

import { useSwapFade } from "@/components/console/use-swap-fade";

import { ownerCell } from "./feed-rows";

/**
 * The rows, and the sentence above them that says how many of how many.
 *
 * The strip is also where the vocabulary is defended: a Deployment **has** phases —
 * cloning, building, pushing, updating the service — and *build* is one of them, not
 * a synonym for the whole thing.
 *
 * The empty state distinguishes **no rows at all** from **no rows matching**, which
 * are opposite facts about the Organization and want different next steps. Now
 * the first of those is a statement about the Organization rather than about
 * this session, because the feed is `GET /deployments` rather than a fan-out
 * over what has been opened.
 *
 * **A failed read is not an empty table.** Zero rows and "we could not ask" are
 * opposite claims and the second one has to be said out loud — the same rule the
 * Environment feed's tab keeps.
 */
export function DeploymentsTableCard({
  shown,
  total,
  pending,
  fetching,
  error,
  truncated,
  range,
  swapKey,
  onOpenLog,
}: {
  shown: DeploymentFeedRow[];
  /** Every row the feed read, before any filter — the denominator. */
  total: number;
  pending: boolean;
  fetching: boolean;
  error: unknown;
  /** The read stopped at its page cap with older rows still in the window. */
  truncated: boolean;
  range: TimeRangeValue;
  /** Changes when the filters change which rows are shown. */
  swapKey: string;
  onOpenLog: (deploymentId: string) => void;
}) {
  // Keyed on the filters *and* on the read landing, so the rows fade in once
  // after the skeleton and again whenever a filter swaps them.
  const swap = useSwapFade<HTMLDivElement>(`${swapKey}|${pending}`);
  if (error) {
    return (
      <Card>
        <Card.Body>
          {/* Nothing is listed until the feed can be read: an empty table
              would claim nothing has happened here. */}
          <p className="text-body text-tx-2">{errorMessage(error)}</p>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card>
      {pending ? (
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : (
        <>
          {/* The vocabulary note that used to follow the count ("build is a
              phase, not a synonym") is CONTEXT.md's, not the operator's.
             A truncated read says so, since the feed stops at a
              bounded number of pages rather than walking until it runs out. */}
          <MetaStrip>
            <strong>{shown.length}</strong> of <strong>{total}</strong>{" "}
            {total === 1 ? "Deployment" : "Deployments"}.
            {truncated ? " Older ones in this range are not shown." : null}
          </MetaStrip>
          <Card.Body
            flush
            aria-busy={fetching || undefined}
            className={cn(
              "transition-opacity duration-150 ease-out-strong",
              fetching && "opacity-60",
            )}
          >
            {/* The rows fade in when the filters swap them, not when a
                refetch adds one: a new Deployment is a row, not a new list. */}
            <div ref={swap}>
              <DeploymentTable
                label="Deployments across this Organization"
                deployments={shown}
                owner={(deployment: Deployment) => {
                  const row = shown.find(
                    (each) => each.deploymentId === deployment.deploymentId,
                  );
                  return row ? ownerCell(row) : null;
                }}
                action={(deployment: Deployment) => (
                  <Button
                    size="xs"
                    onClick={() => onOpenLog(deployment.deploymentId)}
                  >
                    Log
                  </Button>
                )}
                empty={
                  <EmptyState
                    icon="rocket"
                    title={
                      total > 0
                        ? "Nothing matches those filters"
                        : "Nothing has been deployed in this Organization yet"
                    }
                  >
                    {total > 0
                      ? `Try a longer range than the last ${rangeLabel(range)}, or set the status to All.`
                      : "Deploy an Application or a Compose stack, and every Deployment of it shows up here."}
                  </EmptyState>
                }
              />
            </div>
          </Card.Body>
        </>
      )}
    </Card>
  );
}
