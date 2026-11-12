"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { DeploymentTable } from "@/components/console/rows/deployment-row";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { newestLive, watchingOther } from "@/lib/format/deployment-facts";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { DeployButton, deployUnavailable } from "../deploy/deploy-button";
import { liveBuildSub } from "../deploy/deployment-facts";
import { DeploymentLog } from "../deploy/deployment-log";
import { DeploymentModal } from "../deploy/deployment-modal";
import { PhasesCard } from "../deploy/phases-card";
import { BuildNowButton } from "@/components/console/build-now-button";
import { CancelBuildButton } from "../lifecycle/cancel-build-button";
import { ReviewPlanButton } from "../lifecycle/review-plan-button";
import { StopRunButton } from "../lifecycle/stop-run-button";
import { useApplication, useApplicationDeployments } from "../use-application";
import { sourceSummary } from "../source/providers";

/**
 * Every attempt to build and release this Application, and the one that is
 * running right now.
 *
 * **The live log is on this page, not behind a click.** A build in progress is the
 * only thing anyone opens this tab for while it is happening, so the newest
 * running Deployment's output is already streaming when the tab loads; the table
 * under it is the history. A finished Deployment's log opens in a dialog, because
 * there is no `GET /deployments/:id` for a route to read on a reload.
 *
 * The list **polls while a build is live** and stops when nothing is. The status
 * column moves through pending → running → done from the row rather than from the
 * socket: the socket carries output, and a build whose last line has arrived is
 * not necessarily a build the engine has marked done.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const deployments = useApplicationDeployments(id);
  const rows = deployments.data ?? [];
  const live = newestLive(rows);

  const application = useApplication(id, { live: live !== null });
  // **Ids, not rows.** A `Deployment` held in state is the row as it was at the
  // moment it was captured, and its `status` is the field that moves — so a row
  // kept from the deploy response says `pending` for ever, and the log's header
  // read "pending" beside a table row reading "running". Found by driving a real
  // build. State holds the id; the row is always the current one from the list.
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [watchingId, setWatchingId] = useState<string | null>(null);

  const byId = (deploymentId: string | null) =>
    deploymentId === null
      ? null
      : (rows.find((row) => row.deploymentId === deploymentId) ?? null);

  const opened = byId(openedId);
  const watching = byId(watchingId);

  // What is streaming: the build someone just started, else the one that is
  // running. `watching` outranks it so pressing Deploy twice does not swap the
  // well to a build that started first.
  const streaming = watching ?? live;

  const source = application.data ? sourceSummary(application.data) : null;
  // Where a stopped cloud deploy's plan is reviewed.
  const place = application.data
    ? {
        projectId: application.data.environment.projectId,
        environmentId: application.data.environmentId,
      }
    : null;

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede="A Deployment is one attempt to build this Application and release it. Newest first."
        actions={
          <DeployButton
            applicationId={id}
            environmentId={application.data?.environmentId}
            unavailable={deployUnavailable(application.data)}
            onDeployed={(deployment) => setWatchingId(deployment.deploymentId)}
          />
        }
      />

      <Cols aside={<PhasesCard />} asideLabel="About Deployments">
        {streaming ? (
          <Card>
            <Card.Header
              title="Build output"
              sub={
                streaming === live
                  ? liveBuildSub(live)
                  : "The Deployment you just started."
              }
              headingLevel={2}
              actions={
                <>
                  <CancelBuildButton
                    deployment={streaming}
                    applicationId={id}
                  />
                  {/* A running Cloud run only. */}
                  <StopRunButton deployment={streaming} applicationId={id} />
                  {/* A cloud deploy that stopped for review. */}
                  <ReviewPlanButton deployment={streaming} place={place} />
                  {/* Only while a *different* Deployment is running.
                      Offered whenever `watching` was set, it sat beside the
                      build it would switch to, and once that build finished,
                      pressing it left nothing to stream and took the card. */}
                  {watchingOther(watching, live) ? (
                    <Button size="xs" onClick={() => setWatchingId(null)}>
                      Follow the newest instead
                    </Button>
                  ) : null}
                </>
              }
            />
            <Card.Body>
              <DeploymentLog
                deployment={streaming}
                subject={application.data?.name}
              />
            </Card.Body>
          </Card>
        ) : null}

        <Card>
          <Card.Header
            title="Deployments"
            sub={
              rows.length > 0
                ? `${rows.length} ${rows.length === 1 ? "attempt" : "attempts"} recorded.`
                : undefined
            }
            headingLevel={2}
          />
          {deployments.error ? (
            <Card.Body>
              <p className="text-body text-tx-2">
                {errorMessage(deployments.error)}
              </p>
            </Card.Body>
          ) : deployments.isPending ? (
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          ) : (
            <>
              {/* `pending` is a build waiting for a slot, not one running
                  — the sentence said "running" of both. */}
              {live ? (
                <MetaStrip>
                  A build is{" "}
                  <strong>
                    {live.status === "pending" ? "queued" : "running"}
                  </strong>
                  . Its output is above, and this table updates as the engine
                  records each step.
                </MetaStrip>
              ) : null}
              <Card.Body flush>
                <DeploymentTable
                  deployments={rows}
                  label={`Deployments of this Application`}
                  action={(row) => (
                    <>
                      {/* Renders for a `pending`, `running` or `held` row
                          — the states in which there is
                          still a build to stop. */}
                      <CancelBuildButton deployment={row} applicationId={id} />
                      {/* A running Cloud run only. */}
                      <StopRunButton deployment={row} applicationId={id} />
                      {/* Renders for a `held` row: a build a push
                          held for its plan, released here at once. */}
                      <BuildNowButton deployment={row} applicationId={id} />
                      {/* A cloud deploy that met more than its image
                          and left its plan open. */}
                      <ReviewPlanButton deployment={row} place={place} />
                      <Button
                        size="xs"
                        onClick={() => setOpenedId(row.deploymentId)}
                      >
                        Open
                      </Button>
                    </>
                  )}
                  empty={
                    <EmptyState
                      icon="rocket"
                      title="Nothing has been deployed yet"
                      action={
                        <DeployButton
                          applicationId={id}
                          environmentId={application.data?.environmentId}
                          unavailable={deployUnavailable(application.data)}
                          onDeployed={(deployment) =>
                            setWatchingId(deployment.deploymentId)
                          }
                          size="sm"
                        />
                      }
                    >
                      {source?.branch
                        ? `The first Deployment clones ${source.detail ?? "the source"} at ${source.branch} and builds it.`
                        : "A Deployment builds this Application's source and releases the result. Set a source first if it has none."}
                    </EmptyState>
                  }
                />
              </Card.Body>
            </>
          )}
        </Card>
      </Cols>

      <DeploymentModal
        deployment={opened}
        open={opened !== null}
        onOpenChange={(next) => {
          if (!next) setOpenedId(null);
        }}
      />
    </Page>
  );
}
