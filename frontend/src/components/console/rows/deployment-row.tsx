import { Chip } from "@/components/console/chip";
import { DataTable, type Column } from "@/components/console/data-table";
import { Dot } from "@/components/console/dot";
import { EmptyState } from "@/components/console/empty-state";
import { StatusPill } from "@/components/console/status-pill";
import type { CronRunMark, Deployment } from "@/lib/api/endpoints/deployments";
import { statusMark, type Mark } from "@/lib/design/status";
import { timeTaken } from "@/lib/format/time";

import { Dash } from "@/components/console/dash";

import { RowLink, RowSub, RowTime } from "./cells";

/**
 * A Deployment, as a table row (e-console.html:2696-2712 — `depRow` and
 * `depHead`).
 *
 * Two of the reference's columns cannot be filled from a `deployment` row and are
 * therefore **optional rather than empty**:
 *
 * - **Service** and **Project / environment.** A Deployment carries the id of
 *   whatever it deployed (`applicationId` / `composeId` / three more) and no name
 *   for it, and no route resolves an id to a name in bulk. A screen that already
 *   knows — an Application's own Deployments tab does — passes `owner`, and the
 *   column appears. A screen that does not shows the list without it rather than
 *   printing an id at someone.
 * - **By.** There is no user on the row at all: `deployment.schema.ts` has no
 *   `userId`, so "who deployed this" is not a question this table can answer.
 *   Not omitted because it is hard — omitted because inventing it would be a lie
 *   in the column people trust most.
 *
 * **Duration is derived, never stored.** `startedAt` and `finishedAt`, and a run
 * still going measures against now — which is why this is a Client Component and
 * why `timeTaken` says so out loud.
 */

export type DeploymentOwner =
  | {
      label: string;
      href: string;
      /** The Project and Environment it sits in, when the caller knows them. */
      path?: string;
    }
  | {
      /**
       * A run that owns no service — a Server or Cloudgate-host schedule. There
       * is nothing to name and nowhere to follow, so the cell stays the dash it
       * was, and `path` is the only thing in it: what *kind* of run this was,
       * which is a separate fact from where it ran and the one this row has no
       * other way to say.
       */
      label?: never;
      href?: never;
      path: string;
    };

export type DeploymentColumnOptions = {
  /**
   * What this Deployment deployed. Given one, the table grows a column that
   * links to it.
   */
  owner?: (row: Deployment) => DeploymentOwner | null;
  /** A trailing cell of the owning screen's own controls — "Log", "Cancel". */
  action?: (row: Deployment) => React.ReactNode;
};

/**
 * A Cron service's run ends **succeeded** or **failed** — its
 * command's exit code, 0 or not — where a build ends done or error. The row
 * keeps the one status enum; only the word differs. A run its Cron
 * service's Stop ended is `cancelled` marked `stopped`, and reads
 * **stopped**.
 */
export function runStatusMark(
  status: Deployment["status"],
  cronRun?: Pick<CronRunMark, "stopped"> | null,
): Mark {
  const mark = statusMark(status);
  if (status === "done") return { ...mark, label: "succeeded" };
  if (status === "error") return { ...mark, label: "failed" };
  if (status === "cancelled" && cronRun?.stopped) {
    return { ...mark, label: "stopped" };
  }
  return mark;
}

export function deploymentColumns({
  owner,
  action,
}: DeploymentColumnOptions = {}): Column<Deployment>[] {
  return [
    {
      id: "title",
      head: "Deployment",
      tone: "key",
      truncate: true,
      compare: (a, b) => a.title.localeCompare(b.title),
      cell: (row) => (
        <>
          <span className="flex items-center gap-1.75">
            <Dot status={row.status} className="flex-none" />
            {/* `min-w-0`: a flex item will not shrink below its text without it,
                so `truncate` alone never cut a long commit message short. */}
            <span className="min-w-0 truncate">{row.title}</span>
            {/* A Cron service's run, not one of its builds. */}
            {row.cronRun ? <Chip>Run</Chip> : null}
          </span>
          {row.description ? <RowSub mono>{row.description}</RowSub> : null}
        </>
      ),
    },
    {
      id: "status",
      head: "Status",
      compare: (a, b) => a.status.localeCompare(b.status),
      cell: (row) =>
        row.cronRun ? (
          <StatusPill mark={runStatusMark(row.status, row.cronRun)} />
        ) : (
          <StatusPill status={row.status} />
        ),
    },
    ...(owner
      ? [
          {
            id: "owner",
            head: "Service",
            cell: (row: Deployment) => {
              const it = owner(row);
              if (!it) return <Dash word="Unknown" />;
              return (
                <>
                  {it.href ? (
                    <RowLink href={it.href}>{it.label}</RowLink>
                  ) : (
                    <Dash word="Unknown" />
                  )}
                  {it.path ? <RowSub>{it.path}</RowSub> : null}
                </>
              );
            },
          } satisfies Column<Deployment>,
        ]
      : []),
    {
      id: "took",
      head: "Duration",
      className: "font-mono",
      cell: (row) => timeTaken(row.startedAt, row.finishedAt) ?? <Dash />,
    },
    {
      id: "when",
      head: "When",
      tone: "num",
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
      // Queued, not started: a pending Deployment has no `startedAt`, and the
      // moment someone pressed the button is what "when" means to them.
      cell: (row) => <RowTime iso={row.createdAt} />,
    },
    ...(action
      ? [
          {
            id: "action",
            head: <span className="sr-only">Actions</span>,
            tone: "num",
            cell: action,
          } satisfies Column<Deployment>,
        ]
      : []),
  ];
}

export type DeploymentTableProps = DeploymentColumnOptions & {
  deployments: Deployment[];
  empty?: React.ReactNode;
  label?: string;
  /** Passed to `DataTable`: motion for the one row that just arrived or changed. */
  rowClassName?: (row: Deployment) => string | undefined;
};

export function DeploymentTable({
  deployments,
  owner,
  action,
  empty,
  label = "Deployments",
  rowClassName,
}: DeploymentTableProps) {
  return (
    <DataTable
      label={label}
      columns={deploymentColumns({ owner, action })}
      rows={deployments}
      getRowId={(row) => row.deploymentId}
      rowName={(row) => row.title}
      rowClassName={rowClassName}
      // Newest first, which is the only order anyone wants a deployment list in.
      defaultSort={{ id: "when", dir: "desc" }}
      empty={
        empty ?? (
          <EmptyState icon="rocket" title="No Deployments yet">
            A Deployment is one attempt to build and release. Deploy something
            and its build output shows up here.
          </EmptyState>
        )
      }
    />
  );
}
