import { useState } from "react";

import {
  environmentHeading,
  useAccessTree,
} from "@/components/console/access-tree";
import { serviceKindLabel } from "@/components/console/rows/service-row";
import { Skeleton } from "@/components/console/skeleton";
import type { Agent } from "@/lib/api/endpoints/agents";
import { strandedGrants } from "@/lib/auth/access-grants";
import { Icon } from "@/lib/design/icons";
import { counted } from "@/lib/format/plural";
import { cn } from "@/lib/utils";

import { accessSummary, grantIsEmpty } from "./agent-facts";

/**
 * What an Agent can reach: a count line that opens into the named list.
 *
 * The count is the row's own data; the names are not — the member row holds
 * ids — so they are read only when somebody opens the list, through the same
 * reads Manage access makes (`useAccessTree`). A page of Agents therefore
 * costs one request, not one fan-out per row.
 *
 * An empty grant has nothing to open, and reads as the deliberate state it is.
 */
export function AgentAccess({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);

  if (grantIsEmpty(agent)) {
    return <p className="text-body text-warn">{accessSummary(agent)}</p>;
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-1.5 text-body text-tx"
      >
        <Icon
          name="chevR"
          size={15}
          className={cn(
            "flex-none text-tx-3 transition-transform duration-150 ease-out-strong",
            open && "rotate-90",
          )}
        />
        {accessSummary(agent)}
      </button>
      {open ? <GrantList agent={agent} /> : null}
    </div>
  );
}

function GrantList({ agent }: { agent: Agent }) {
  const grants = {
    projects: agent.accessedProjects,
    environments: agent.accessedEnvironments,
    services: agent.accessedServices,
  };
  const tree = useAccessTree(grants);
  const stranded = strandedGrants(grants, tree.inventory);
  const strandedIds = [
    ...stranded.projects,
    ...stranded.environments,
    ...stranded.services,
  ];
  const gone = new Set(strandedIds);

  if (tree.projects.isPending) {
    return (
      <div className="mt-2 grid gap-2" aria-busy="true">
        <Skeleton className="h-ctl" />
      </div>
    );
  }

  const named = (ids: string[], name: (id: string) => string | undefined) =>
    ids
      .filter((id) => !gone.has(id))
      .map((id) => ({ id, label: name(id) }));

  const groups = [
    {
      title: "Projects",
      rows: named(grants.projects, (id) => tree.projectName.get(id)),
    },
    {
      title: "Environments",
      rows: named(grants.environments, (id) =>
        tree.environmentRows.has(id) ? environmentHeading(tree, id) : undefined,
      ),
    },
    {
      title: "Services",
      rows: named(grants.services, (id) => {
        const service = tree.serviceRows.get(id);
        return service
          ? `${service.name} (${serviceKindLabel(service.serviceType)})`
          : undefined;
      }),
    },
  ];

  return (
    <div className="mt-2 grid gap-2.5 rounded-lg border border-line px-3 py-2.5">
      {groups.map((group) =>
        group.rows.length === 0 ? null : (
          <div key={group.title}>
            <p className="text-meta font-medium text-tx-2">{group.title}</p>
            <ul className="mt-0.5 text-body text-tx">
              {group.rows.map((row) => (
                <li key={row.id} className="wrap-anywhere">
                  {row.label ?? (
                    // Not read yet, or unreadable — the id, not a guess.
                    <span className="font-mono text-meta text-tx-3">
                      {row.id}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
      {strandedIds.length > 0 ? (
        <p className="text-meta text-tx-2">
          {counted(strandedIds.length, "grant names", "grants name")} something
          this Agent cannot reach — it has been deleted, or it sits under a
          Project or Environment it is not granted:{" "}
          <span className="font-mono wrap-anywhere text-tx-3">
            {strandedIds.join(", ")}
          </span>
        </p>
      ) : null}
    </div>
  );
}
