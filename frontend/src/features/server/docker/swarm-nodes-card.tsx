import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { DataTable, type Column } from "@/components/console/data-table";
import { Dot } from "@/components/console/dot";
import { EmptyState } from "@/components/console/empty-state";
import { RemoveNodeModal } from "./remove-node-modal";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { isUnreachableHost } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type { SwarmNode } from "@/lib/api/endpoints/docker";
import { Icon } from "@/lib/design/icons";

import { useRemoveNode, useSwarmNodes } from "./use-server-docker";
import { ServerUnreachable } from "../server-unreachable";

/**
 * The Swarm this host belongs to.
 *
 * **`null` here is almost always a worker rather than a failure**, and that is the
 * whole reason this card exists as its own component. `docker node ls` is a
 * manager-only command: ask a worker and it writes to stderr, and the route answers
 * with nothing. A card that read that as an empty list would tell an operator their
 * Swarm has no nodes while standing inside it.
 *
 * **Which made X11-4 worse here than anywhere.** A Server that could not be reached
 * arrived as that same `null`, so the sentence written to reassure a worker's
 * operator — *"the cluster is fine and this machine is not the one that can describe
 * it"* — was said about a machine nothing had spoken to. The backend tells the two
 * apart now, and the branch below is ahead of every other because it is neither a
 * worker nor an error worth a status-derived sentence.
 *
 * **Docker's words stay Docker's.** Manager, worker, Leader, Reachable, Drain — the
 * vocabulary rule covers our nouns, and these are the Engine's own. `Availability` and
 * `Status` are two different questions and the columns keep them apart: a node can be
 * `Ready` and `Drain` at once, which is exactly a node being taken out of service, and
 * merging them into one pill would hide the state somebody deliberately set.
 */
export function SwarmNodesCard({
  serverId,
  serverName,
}: {
  serverId: string;
  serverName: string;
}) {
  const nodes = useSwarmNodes(serverId);
  const [removing, setRemoving] = useState<SwarmNode | null>(null);
  const remove = useRemoveNode(serverId);

  const rows = nodes.data ?? [];

  const columns: Column<SwarmNode>[] = [
    {
      id: "hostname",
      head: "Hostname",
      tone: "key",
      compare: (a, b) => a.Hostname.localeCompare(b.Hostname),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.75">
          <span className="min-w-0 wrap-anywhere">{row.Hostname}</span>
          {row.Self ? <Chip variant="brand">This Server</Chip> : null}
        </span>
      ),
    },
    {
      id: "role",
      head: "Role",
      cell: (row) =>
        row.ManagerStatus ? `Manager · ${row.ManagerStatus}` : "Worker",
    },
    {
      id: "status",
      head: "Status",
      cell: (row) => (
        <span className="flex items-baseline gap-1.75">
          <Dot
            mark={{
              tone: row.Status === "Ready" ? "ok" : "bad",
              glyph: row.Status === "Ready" ? "●" : "○",
              label: row.Status,
            }}
          />
          {row.Status}
        </span>
      ),
    },
    {
      id: "availability",
      head: "Availability",
      cell: (row) => (
        <span className="flex items-baseline gap-1.75">
          <Dot
            mark={{
              tone: row.Availability === "Active" ? "ok" : "warn",
              glyph: row.Availability === "Active" ? "●" : "○",
              label: row.Availability,
            }}
          />
          {row.Availability}
        </span>
      ),
    },
    {
      id: "engine",
      head: "Docker",
      className: "font-mono",
      cell: (row) => row.EngineVersion || <Dash word="Unknown" />,
    },
    {
      id: "id",
      head: "Node id",
      className: "font-mono",
      cell: (row) => <span title={row.ID}>{row.ID.slice(0, 12)}</span>,
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      className: "w-0",
      cell: (row) =>
        // Removing the node the command ran on would take out the manager answering
        // for the whole cluster, and `docker node rm` refuses it anyway.
        row.Self ? (
          <span className="text-meta text-tx-3">This Server</span>
        ) : (
          <Button size="xs" variant="dngr" onClick={() => setRemoving(row)}>
            Remove
          </Button>
        ),
    },
  ];

  return (
    <>
      <Card>
        <Card.Header
          title="Swarm nodes"
          sub="Read with docker node ls on this host."
          headingLevel={2}
          actions={
            <Button
              size="sm"
              onClick={() => void nodes.refetch()}
              disabled={nodes.isFetching}
              aria-busy={nodes.isFetching || undefined}
            >
              <Icon name="refresh" size={14} />
              Refresh
            </Button>
          }
        />

        {nodes.isPending ? (
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        ) : isUnreachableHost(nodes.error) ? (
          <Card.Body>
            <ServerUnreachable
              serverId={serverId}
              ran={<code className="font-mono">docker node ls</code>}
            >
              this says nothing about the Swarm &mdash; not that it has no
              nodes, and not that this Server is a worker.
            </ServerUnreachable>
          </Card.Body>
        ) : nodes.error ? (
          <Card.Body>
            <p className="text-body text-tx-2">{errorMessage(nodes.error)}</p>
          </Card.Body>
        ) : nodes.data === null ? (
          <Card.Body>
            <p className="text-body text-tx">
              This host cannot list the Swarm&rsquo;s nodes.
            </p>
            <p className="mt-1.5 text-meta text-tx-2">
              <code className="font-mono">docker node ls</code> only works on a
              manager, so this is the normal answer from a worker — the cluster
              is fine and this machine is not the one that can describe it. It
              is also what a host with no Swarm at all says; the Infrastructure
              tab checks which.
            </p>
          </Card.Body>
        ) : (
          <Card.Body flush>
            <DataTable
              label={`Swarm nodes seen from ${serverName}`}
              rows={rows}
              columns={columns}
              getRowId={(row) => row.ID}
              rowName={(row) => row.Hostname}
              defaultSort={{ id: "hostname", dir: "asc" }}
              empty={
                <EmptyState icon="server" title="No nodes reported">
                  Docker answered with an empty list, which is unusual — a host
                  in a Swarm is always a node of it. Check again, and check the
                  Infrastructure tab.
                </EmptyState>
              }
            />
          </Card.Body>
        )}
      </Card>

      <RemoveNodeModal
        node={removing}
        pending={remove.isPending}
        onClose={() => setRemoving(null)}
        onRemoved={() => void nodes.refetch()}
        remove={(nodeId) => remove.mutateAsync(nodeId)}
      />
    </>
  );
}
