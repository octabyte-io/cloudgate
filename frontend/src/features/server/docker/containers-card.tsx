import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Skeleton } from "@/components/console/skeleton";
import { useDock } from "@/components/shell/dock-context";
import { Button } from "@/components/ui/button";
import { isUnreachableHost } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type { ContainerListItem } from "@/lib/api/endpoints/docker";
import { Icon } from "@/lib/design/icons";

import { ContainerActions } from "./container-actions";
import { containerColumns } from "./container-columns";
import { InspectContainerModal } from "./container-detail-modals";
import { useServerContainers } from "./use-server-docker";
import { ServerUnreachable } from "../server-unreachable";

/**
 * Every container on this host.
 *
 * **Six states, and five of them say something different.** This is the card where
 * conflating any two would be a confident claim about somebody's machine made because
 * a request behaved oddly:
 *
 * - *In flight* — `docker ps` is running over SSH.
 * - *Not reached* — **the SSH connection failed, so no command ran** (X11-4). This
 *   was the state that did not exist: the route swallowed the transport failure and
 *   answered `[]`, so an unreachable Server rendered the empty state below and an
 *   operator opening it mid-incident was told their containers were gone. It is a
 *   503 carrying `HOST_UNREACHABLE` now.
 * - *Refused* — this role cannot read docker, or the request failed some other way.
 * - *`null`* — **docker would not say**: the command reached the daemon and it wrote
 *   to stderr or exited nonzero. That is not "no containers". Usually it means Docker
 *   is not installed or not running, which is what the Infrastructure tab checks.
 * - *`[]`* — docker answered, and there are none.
 * - *Rows.*
 *
 * The order below is §3.5's, with one insertion: *not reached* goes ahead of the
 * generic error for `isRefusal`'s reason — it is not one, and the sentence for the
 * status alone would name the wrong machine.
 *
 * The inspect dialog is **held here rather than in a row**: one mounted inside a cell
 * unmounts the moment the table re-sorts or the query refetches, which closes it under
 * the person using it (F08's defect, and this table refetches after every action).
 *
 * **The header no longer promises everything.** It used to say "whether Cloudgate
 * deployed it or not" full stop, which was true and was the disclosure: the route handed
 * any owner or admin every other organization's Swarm task name, image, published ports
 * and container id on the shared platform host. It now hides a container whose Docker
 * labels resolve to a Service in another organization; a container belonging to no
 * Service at all is *unmanaged* and is still listed, which is the half of that sentence
 * that was always the point.
 */
export function ContainersCard({
  serverId,
  serverName,
}: {
  serverId: string;
  serverName: string;
}) {
  const containers = useServerContainers(serverId);
  const [inspecting, setInspecting] = useState<ContainerListItem | null>(null);
  const dock = useDock();

  // Straight into the docked terminal, with no dialog in between: the
  // page stays usable above it, and the shell stays open across navigation.
  // `sh`, because it is the one most images carry — the gateway accepts seven
  // and rejects the rest, and offering `bash` on an Alpine image is a session
  // that dies at once. Most, not every: an image with no shell at all is
  // closed with its own code, which the Dock's status line words.
  const openShell = (row: ContainerListItem) =>
    dock?.open({
      kind: "container",
      containerId: row.containerId,
      serverId,
      name: row.name,
      host: serverName,
      shell: "sh",
    });

  const rows = containers.data ?? [];
  const running = rows.filter((row) => row.state === "running").length;

  const columns: Column<ContainerListItem>[] = [
    ...containerColumns(),
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      className: "w-0",
      cell: (row) => (
        <ContainerActions
          container={row}
          serverId={serverId}
          onInspect={setInspecting}
          onShell={openShell}
          dockFull={dock?.shellsFull ?? false}
        />
      ),
    },
  ];

  return (
    <>
      <Card>
        <Card.Header
          title="Containers"
          sub="Everything docker ps reports on this host, whether Cloudgate deployed it or not — except containers belonging to another Organization's Services."
          headingLevel={2}
          actions={
            <Button
              size="sm"
              onClick={() => void containers.refetch()}
              disabled={containers.isFetching}
              aria-busy={containers.isFetching || undefined}
            >
              <Icon name="refresh" size={14} />
              Refresh
            </Button>
          }
        />

        {containers.isPending ? (
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        ) : isUnreachableHost(containers.error) ? (
          <Card.Body>
            <ServerUnreachable
              serverId={serverId}
              ran={<code className="font-mono">docker ps</code>}
            >
              nothing here is a statement about what this Server is running
              &mdash; a Server nobody reached is not an empty one.
            </ServerUnreachable>
          </Card.Body>
        ) : containers.error ? (
          <Card.Body>
            <p className="text-body text-tx-2">
              {errorMessage(containers.error)}
            </p>
          </Card.Body>
        ) : containers.data === null ? (
          <Card.Body>
            <p className="text-body text-tx">
              Docker on this host did not answer.
            </p>
            <p className="mt-1.5 text-meta text-tx-2">
              {/* The Server answered and the docker command did not: it wrote
                  to stderr or exited nonzero, and the route returns nothing
                  for either — so this is the daemon, not the list. */}
              Docker is most likely not installed or not running; the
              Infrastructure tab checks which.
            </p>
          </Card.Body>
        ) : (
          <>
            {rows.length > 0 ? (
              <MetaStrip>
                <strong>{running}</strong> of <strong>{rows.length}</strong>{" "}
                running. Cloudgate&rsquo;s own containers are filtered out by
                the backend, so Traefik is not in this list even though setup
                started it.
              </MetaStrip>
            ) : null}
            <Card.Body flush>
              <DataTable
                label={`Containers on ${serverName}`}
                rows={rows}
                columns={columns}
                getRowId={(row) => row.containerId}
                rowName={(row) => row.name}
                defaultSort={{ id: "name", dir: "asc" }}
                empty={
                  <EmptyState icon="box" title="Nothing is running here">
                    Deploy to an Environment on this Server and its containers
                    appear here. Docker answered with none.
                  </EmptyState>
                }
              />
            </Card.Body>
          </>
        )}
      </Card>

      <InspectContainerModal
        container={inspecting}
        serverId={serverId}
        onOpenChange={(next) => {
          if (!next) setInspecting(null);
        }}
      />
    </>
  );
}
