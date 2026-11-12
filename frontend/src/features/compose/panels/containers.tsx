"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Modal } from "@/components/console/modal";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { runsOnStackVm, type ComposeDetail } from "@/lib/api/endpoints/compose";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposeFactsCard } from "../compose-facts-card";
import { ComposePanel } from "../compose-panel";
import { ContainerActions } from "../containers/container-actions";
import { containerColumns } from "../containers/container-columns";
import {
  useStackContainers,
  type StackContainer,
} from "../containers/use-stack-containers";
import { ComposeActions } from "../lifecycle/compose-actions";
import { whyNothingRuns } from "../lifecycle/nothing-running";
import { ContainerOutput } from "../logs/container-output";

/**
 * What this stack actually produced.
 *
 * **The table is a join, and the join is the design.** The file says which services
 * should exist; Docker says which containers do. Showing only the second is what
 * every other console does and it cannot answer the question people arrive with
 * after a half-finished deploy — *which part of my stack is not there* — so a
 * service the file declares with nothing running for it gets a row of its own.
 * `use-stack-containers.ts` has the endpoint audit that made this three reads
 * rather than one.
 *
 * The output of one container opens in a **dialog, not a route**: a container id
 * changes on every deploy, so a URL carrying one would be dead by the time anyone
 * followed it — F09's argument about a Deployment's log, and the same conclusion.
 */
export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      live
      aside={(row) => <ComposeFactsCard compose={row} />}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`The containers ${row.name} is running, against the services its compose file declares.`}
          actions={<ComposeActions compose={row} size="sm" />}
        />
      )}
    >
      {(row) => <Body compose={row} />}
    </ComposePanel>
  );
}

function Body({ compose }: { compose: ComposeDetail }) {
  const containers = useStackContainers(compose);
  const [opened, setOpened] = useState<StackContainer | null>(null);
  const swarm = compose.composeType === "stack";
  const rows = containers.rows;

  return (
    <>
      <Card>
        <Card.Header
          title="Containers"
          sub={
            rows.length > 0
              ? `${rows.filter((row) => row.state === "running").length} of ${rows.length} running.`
              : undefined
          }
          headingLevel={2}
          actions={
            <Button
              size="xs"
              onClick={containers.refetch}
              aria-busy={containers.isFetching || undefined}
            >
              <Icon name="refresh" size={14} />
              Re-read
            </Button>
          }
        />

        {containers.error ? (
          <Card.Body>
            <p className="text-body text-tx-2">
              {/* This reads `docker ps` on the deploy target, so an unreachable
                  Server would look exactly like a stack with nothing running —
                  which is why this is the refusal, not an empty table. */}
              {errorMessage(containers.error)} The containers could not be read,
              which is not the same as nothing running.
            </p>
          </Card.Body>
        ) : containers.isPending ? (
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        ) : (
          <>
            {containers.imagesUnavailable && rows.length > 0 ? (
              <MetaStrip>
                The <strong>Image</strong> and <strong>Ports</strong> columns
                are empty. {containers.imagesMissingBecause}{" "}
                Everything else
                here is from this stack&rsquo;s own read.
              </MetaStrip>
            ) : null}
            <Card.Body flush>
              <DataTable
                label={`Containers of ${compose.name}`}
                rows={rows}
                getRowId={(row) => row.containerId ?? `declared:${row.service}`}
                defaultSort={{ id: "service", dir: "asc" }}
                columns={containerColumns({
                  swarm,
                  imagesUnavailable: containers.imagesUnavailable,
                  action: (row) => (
                    <ContainerActions
                      container={row}
                      serverId={compose.serverId}
                      onStackVm={runsOnStackVm(compose)}
                      onLogs={setOpened}
                    />
                  ),
                })}
                empty={
                  <EmptyState
                    icon="box"
                    title="Nothing is running for this stack"
                    action={
                      <ComposeActions compose={compose} size="sm" deployOnly />
                    }
                  >
                    {whyNothingRuns(compose, "containers")}
                  </EmptyState>
                }
              />
            </Card.Body>
          </>
        )}
      </Card>

      <Modal
        open={opened !== null}
        onOpenChange={(next) => {
          if (!next) setOpened(null);
        }}
        wide
      >
        <Modal.Header
          title={opened?.service ?? opened?.name ?? "Container output"}
          description={
            opened
              ? `Live output from ${opened.name}. It follows the tail until you scroll up.`
              : undefined
          }
        />
        <Modal.Body>
          {opened?.containerId ? (
            <ContainerOutput
              containerId={opened.containerId}
              serverId={compose.serverId}
              label={`Output of ${opened.name}`}
              subject={compose.name}
              container={opened.service ?? opened.name}
              describe={`${opened.name}'s output`}
            />
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Close</Button>} />
        </Modal.Footer>
      </Modal>
    </>
  );
}
