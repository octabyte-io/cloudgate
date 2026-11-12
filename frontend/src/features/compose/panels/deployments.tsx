"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { DeploymentTable } from "@/components/console/rows/deployment-row";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import { newestLive, watchingOther } from "@/lib/format/deployment-facts";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { DeploymentLog } from "@/features/application/deploy/deployment-log";
import { DeploymentModal } from "@/features/application/deploy/deployment-modal";

import { ComposeFactsCard } from "../compose-facts-card";
import { ComposePanel } from "../compose-panel";
import { ComposeActions } from "../lifecycle/compose-actions";
import { composeSourceSummary } from "../source/compose-source";
import { useComposeDeployments } from "../use-compose";

/**
 * Every attempt to bring this stack up, and the one running right now.
 *
 * **The same screen F09 built for an Application, on the same components** —
 * `DeploymentLog`, `DeploymentModal` and F07's `DeploymentTable` are imported, not
 * reimplemented, because `POST /compose/:id/deployments` writes the same
 * `deployment` row through the same engine and streams over the same gateway. Two
 * differences, both from the row rather than from taste:
 *
 * - **The log Server is just `serverId`.** A `compose` row has no `buildServerId`
 *   (only an `application` does), so F09's build-server precedence had nothing
 *   to choose between here.
 * - **Deploy is the only action, and it is not a workaround.** There is no compose
 *   redeploy or rebuild route to leave out — deploying *is* the rebuild, since it
 *   re-reads the file and runs `up -d --build` every time.
 */
export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      aside={(row) => <ComposeFactsCard compose={row} />}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`A Deployment reads ${row.name}'s compose file, applies it, and records what Docker said. Newest first.`}
        />
      )}
    >
      {(row) => <Body compose={row} />}
    </ComposePanel>
  );
}

function Body({ compose }: { compose: ComposeDetail }) {
  const deployments = useComposeDeployments(compose.composeId);
  const rows = deployments.data ?? [];
  const live = newestLive(rows);

  // **Ids, not rows** (F09's defect 5): a `Deployment` held in state keeps the
  // `pending` status it had when it was captured, and `status` is the field that
  // moves — so the log's header would read `pending` beside a table row reading
  // `running`. State holds the id; the row is always the current one from the list.
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [watchingId, setWatchingId] = useState<string | null>(null);

  const byId = (deploymentId: string | null) =>
    deploymentId === null
      ? null
      : (rows.find((row) => row.deploymentId === deploymentId) ?? null);

  const opened = byId(openedId);
  const watching = byId(watchingId);
  const streaming = watching ?? live;
  const source = composeSourceSummary(compose);

  return (
    <>
      {streaming ? (
        <Card>
          <Card.Header
            title="Deployment output"
            sub={
              streaming === live
                ? "Streaming as the deploy writes it."
                : "The Deployment you just started."
            }
            headingLevel={2}
            actions={
              // Only when the two genuinely differ. While the Deployment someone
              // just started *is* the newest one, offering to follow the newest
              // instead is an offer to do what is already happening — found by
              // pressing Deploy and reading the header it produced.
              //
              // **And only while something is running**. This card shows
              // a finished Deployment only because someone started it here, so
              // with nothing live, "the newest" is nothing: the offer grew on
              // every finished deploy, and pressing it removed the card.
              watchingOther(watching, live) ? (
                <Button size="xs" onClick={() => setWatchingId(null)}>
                  Follow the newest instead
                </Button>
              ) : null
            }
          />
          <Card.Body>
            <DeploymentLog
              deployment={streaming}
              // A `compose` row has no build Server of its own.
              label={`Deployment output for ${compose.name}`}
              subject={compose.name}
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
          actions={
            <ComposeActions
              compose={compose}
              size="sm"
              onDeployed={(deployment) =>
                setWatchingId(deployment.deploymentId)
              }
            />
          }
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
            {live ? (
              <MetaStrip>
                A deploy is <strong>running</strong>. Its output is above, and
                this table updates as the engine records each step.
              </MetaStrip>
            ) : null}
            <Card.Body flush>
              <DeploymentTable
                deployments={rows}
                label={`Deployments of ${compose.name}`}
                action={(row) => (
                  <Button
                    size="xs"
                    onClick={() => setOpenedId(row.deploymentId)}
                  >
                    Open
                  </Button>
                )}
                empty={
                  <EmptyState
                    icon="rocket"
                    title="This stack has never been deployed"
                    action={
                      <ComposeActions
                        compose={compose}
                        size="sm"
                        deployOnly
                        onDeployed={(deployment) =>
                          setWatchingId(deployment.deploymentId)
                        }
                      />
                    }
                  >
                    {compose.sourceType === "raw"
                      ? "The first Deployment writes the compose file to the deploy target and brings its services up."
                      : `The first Deployment clones ${source.detail ?? "the repository"}${source.branch ? ` at ${source.branch}` : ""} and applies the compose file in it.`}
                  </EmptyState>
                }
              />
            </Card.Body>
          </>
        )}
      </Card>

      <DeploymentModal
        deployment={opened}
        noun="stack"
        open={opened !== null}
        onOpenChange={(next) => {
          if (!next) setOpenedId(null);
        }}
      />
    </>
  );
}
