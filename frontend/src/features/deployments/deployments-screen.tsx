"use client";

import { useMemo, useState } from "react";

import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import {
  DEFAULT_TIME_RANGE,
  withinRange,
  type TimeRangeValue,
} from "@/components/console/time-range";
import { Button } from "@/components/ui/button";
import type { DeploymentStatus } from "@/lib/api/endpoints/deployments";
import { Icon } from "@/lib/design/icons";

import { DeploymentModal } from "@/features/application/deploy/deployment-modal";

import { DeploymentsFilters, type FeedScope } from "./deployments-filters";
import { DeploymentsTableCard } from "./deployments-table-card";
import { ownedByOneOf, ownerNoun, projectsIn } from "./feed-rows";
import { useDeploymentFeed, useRecentServiceIds } from "./use-feed";

/**
 * Every Deployment in this Organization, newest first.
 *
 * The reference's screen (`viewDeployments`, `e-console.html:3269-3307`) with the
 * parts that were backed by nothing removed.
 *
 * **It reads `GET /deployments`** — the organization-wide feed
 * one request, all
 * five owner kinds. It once
 * did not: it fanned out over the services in Recents and carried a callout
 * saying so, which made a page titled "every attempt to build and release
 * something" answer *what have I looked at lately* — two rows of sixteen on the
 * instance where that was measured, and nothing at all in a fresh session. The
 * callout went with the wiring; a screen that no longer has a limitation must not
 * keep describing one. **Recents survives as a filter**, which is what it was
 * always good for.
 *
 * **What the reference has that this does not:**
 *
 * - Its **By** column. A `deployment` row has no `userId` at all, so "who deployed
 *   this" is not a question this table can answer — `DeploymentTable` omits it
 *   rather than printing a dash in the column people trust most.
 * - Its **Export** button, which has no endpoint.
 * - Its **"Live now"** aside — requests per second, p95 latency and an error rate
 *   across "13 services". The first is on the Requests screen where the data
 *   actually is; the other two are computable from nothing this backend serves.
 * - Its **Deployment triggers** aside, three switches over Organization-wide
 *   settings that do not exist: auto-deploy and previews are **per Application**
 *   columns, and there is no Organization-level notification toggle.
 *
 * **What it keeps** is the status segmented control with counts beside each word,
 * which is the reference's best idea on this screen: it says how many of each there
 * are *before* you filter, so an empty "Error" is visibly empty rather than
 * indistinguishable from a filter that found nothing.
 *
 * The status counts and the project list are computed **after** the time range, the
 * Project and the scope and **before** the status filter, so the numbers on the
 * control describe what choosing it would show. A count that changed when you
 * clicked it would be useless.
 *
 * **The route takes a status and a Project itself and neither is sent**, which is
 * deliberate: both filters have to narrow a pool the screen already holds, or the
 * counts above stop describing it and every click becomes a round trip. The window
 * is the read; the four controls are the browser's.
 */

export function DeploymentsScreen() {
  const [range, setRange] = useState<TimeRangeValue>(DEFAULT_TIME_RANGE);
  const [status, setStatus] = useState<DeploymentStatus | "all">("all");
  const [projectId, setProjectId] = useState("all");
  const [scope, setScope] = useState<FeedScope>("all");
  const [openedId, setOpenedId] = useState<string | null>(null);

  const feed = useDeploymentFeed();
  const recentServiceIds = useRecentServiceIds();

  /** The range, the Project and the scope narrow the pool the counts are taken from. */
  const inScope = useMemo(
    () =>
      feed.rows.filter(
        (row) =>
          withinRange(row.createdAt, range) &&
          (projectId === "all" || row.project?.projectId === projectId) &&
          (scope === "all" || ownedByOneOf(row, recentServiceIds)),
      ),
    [feed.rows, range, projectId, scope, recentServiceIds],
  );

  const counts = useMemo(() => {
    const tally: Record<string, number> = { all: inScope.length };
    for (const row of inScope) {
      tally[row.status] = (tally[row.status] ?? 0) + 1;
    }
    return tally;
  }, [inScope]);

  const shown = useMemo(
    () =>
      status === "all"
        ? inScope
        : inScope.filter((row) => row.status === status),
    [inScope, status],
  );

  const projects = useMemo(() => projectsIn(feed.rows), [feed.rows]);

  const opened = shown.find((row) => row.deploymentId === openedId);

  return (
    <Page>
      <PageHeader
        title="Deployments"
        icon="rocket"
        lede="Every Deployment of the Applications and Compose stacks you can reach."
        actions={
          <Button
            size="sm"
            onClick={() => feed.refetch()}
            disabled={feed.fetching}
          >
            <Icon name="refresh" size={15} />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4.5">
        <DeploymentsFilters
          range={range}
          onRange={setRange}
          status={status}
          onStatus={setStatus}
          projectId={projectId}
          onProjectId={setProjectId}
          scope={scope}
          onScope={setScope}
          recentCount={recentServiceIds.length}
          counts={counts}
          projects={projects}
        />

        <DeploymentsTableCard
          shown={shown}
          total={feed.rows.length}
          pending={feed.pending}
          fetching={feed.fetching}
          error={feed.error}
          truncated={feed.truncated}
          range={range}
          swapKey={`${range}|${status}|${projectId}|${scope}`}
          onOpenLog={setOpenedId}
        />
      </div>

      {/* The log opens here rather than sending you into the service's own tab:
          the feed is the place you are working, and losing your filters to read
          one log is the thing that makes a feed not worth using. It is the same
          `DeploymentModal` F09 built and F12 reuses — a dialog rather than a
          route because there is no `GET /deployments/:id` for an address to
          read on a reload. */}
      <DeploymentModal
        deployment={opened ?? null}
        noun={opened ? ownerNoun(opened) : undefined}
        open={opened !== undefined}
        onOpenChange={(next) => {
          if (!next) setOpenedId(null);
        }}
      />
    </Page>
  );
}
