import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

import { Card } from "@/components/console/card";
import type { Column } from "@/components/console/data-table";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import {
  teardownReportIsEmpty,
  type TeardownReport,
} from "@/lib/api/endpoints/teardown";
import { errorMessage } from "@/lib/api/error-message";
import {
  readGate,
  roleRefusal,
  usePermission,
  type Gate,
} from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { DeleteResourceModal } from "./delete-resource-modal";
import { ResourceFormModal } from "./resource-form-modal";
import type { ResourceSpec } from "./resource-spec";
import { TeardownReportModal } from "./teardown-report-modal";

/**
 * **A table of child records, once.** Mounts, schedules, volume backups, patches,
 * ports, redirects and security are all this component with a different
 * `ResourceSpec` — the last three since
 * they got a list route, which is the clearest evidence the pattern was worth
 * extracting: they cost three configuration files and no component.
 *
 * Three decisions live here rather than in each configuration file, because
 * they are the ones that go quietly wrong when repeated:
 *
 * 1. **The dialogs are held at list level, never in a row.** A dialog mounted
 *    inside a table cell unmounts the moment the table re-sorts or the query
 *    refetches — which closes it under the person using it. F08 found this on
 *    the Projects list, and every list in the console has been built this way
 *    since.
 * 2. **Every opening mounts a fresh form.** The edit dialog is keyed on the
 *    row's id and the add dialog on a counter, because `useApiForm` reads
 *    `defaultValues` once: without the key, cancelling an add and opening it
 *    again shows what was typed the first time (F09's add-a-domain defect), and
 *    opening a second row's edit shows the first row's values.
 * 3. **A refusal is not an empty list.** `error` and `isPending` are answered
 *    before `rows.length === 0` is even looked at, so a 403 on the list never
 *    renders an empty state — which would be a confident claim about this
 *    Application's configuration, made because a request failed. That is the
 *    single easiest lie to tell on these screens, and F09 told it twice.
 * 4. **Add, Edit and Remove are off for a role that cannot use them**
 * with the
 *    reason on the button, from `spec.permissions` — `usePermission`'s rule, in
 *    the one place every list inherits it from. All three hooks run on every
 *    render whatever the spec says, so the hook order never depends on it.
 */
export function ResourceList<Row, Values extends Record<string, unknown>>({
  spec,
  query,
  /** Rendered above the table, inside the card — a note about when a change lands. */
  note,
}: {
  spec: ResourceSpec<Row, Values>;
  query: UseQueryResult<Row[]>;
  note?: React.ReactNode;
}) {
  const [editing, setEditing] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const [opening, setOpening] = useState(0);
  // What a remove left on a machine — a schedule's or a backup's run logs
  // — held here rather than in the delete dialog, which closes the
  // moment the remove resolves.
  const [leftBehind, setLeftBehind] = useState<{
    report: TeardownReport;
    name: string;
  } | null>(null);

  const statements =
    spec.permissions === "same-as-list" ? null : spec.permissions;
  const canCreate = usePermission(statements?.create ?? {});
  const canUpdate = usePermission(statements?.update ?? {});
  const canRemove = usePermission(statements?.remove ?? {});
  const listed = readGate(query);
  const gate = (allowed: boolean, action: string): Gate =>
    statements ? { allowed, refusal: roleRefusal(action) } : listed;
  const add = gate(canCreate.allowed, lowerFirst(spec.addLabel));
  const edit = gate(canUpdate.allowed, `change this ${spec.noun}`);
  const drop = gate(canRemove.allowed, `remove this ${spec.noun}`);

  function openAddDialog() {
    setOpening((n) => n + 1);
    setAdding(true);
  }

  const rows = query.data ?? [];
  const empty = !query.error && !query.isPending && rows.length === 0;

  const columns: Column<Row>[] = [
    ...spec.columns,
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      className: "w-0",
      cell: (row) => (
        <span className="inline-flex justify-end gap-1.5 whitespace-nowrap">
          {spec.rowExtras?.(row)}
          <Button
            size="xs"
            disabled={!edit.allowed}
            title={edit.allowed ? undefined : edit.refusal}
            onClick={() => edit.allowed && setEditing(row)}
          >
            Edit
          </Button>
          <Button
            size="xs"
            variant="dngr"
            disabled={!drop.allowed}
            title={drop.allowed ? undefined : drop.refusal}
            onClick={() => drop.allowed && setRemoving(row)}
          >
            Remove
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <Card>
        <Card.Header
          title={spec.title}
          sub={spec.lede}
          headingLevel={2}
          actions={
            // Once, not twice: an empty list's state carries the
            // first Add, so the header does not repeat it beside it.
            empty ? undefined : (
              (spec.addInstead ?? (
                <Button
                  size="sm"
                  variant="pri"
                  disabled={!add.allowed}
                  title={add.allowed ? undefined : add.refusal}
                  onClick={() => add.allowed && openAddDialog()}
                >
                  <Icon name="plus" size={14} />
                  {spec.addLabel}
                </Button>
              ))
            )
          }
        />

        {query.error ? (
          <Card.Body>
            <p className="text-body text-tx-2">{errorMessage(query.error)}</p>
          </Card.Body>
        ) : query.isPending ? (
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        ) : (
          <>
            {note && rows.length > 0 ? note : null}
            {/* Mounts once, when the skeleton above gives way: the rows arrive
                as one block. A refetch keeps this mounted, so it never replays. */}
            <Card.Body flush className="animate-rise">
              <DataTable
                label={spec.tableLabel ?? spec.title}
                rows={rows}
                columns={columns}
                getRowId={spec.getRowId}
                defaultSort={spec.defaultSort}
                empty={
                  <EmptyState
                    icon={spec.icon}
                    title={spec.emptyTitle}
                    action={
                      spec.addInstead ?? (
                        <Button
                          size="sm"
                          variant="pri"
                          disabled={!add.allowed}
                          title={add.allowed ? undefined : add.refusal}
                          onClick={() => add.allowed && openAddDialog()}
                        >
                          {spec.addLabel}
                        </Button>
                      )
                    }
                  >
                    {spec.emptyBody}
                  </EmptyState>
                }
              />
            </Card.Body>
          </>
        )}
      </Card>

      <ResourceFormModal
        key={`add-${opening}`}
        spec={spec}
        row={null}
        open={adding}
        onOpenChange={setAdding}
      />
      <ResourceFormModal
        key={editing ? spec.getRowId(editing) : "none"}
        spec={spec}
        row={editing}
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
      />
      <DeleteResourceModal
        spec={spec}
        row={removing}
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        onRemoved={(answer, name) => {
          const report =
            typeof answer === "object" && answer !== null
              ? (answer as TeardownReport)
              : undefined;
          if (!teardownReportIsEmpty(report)) {
            setLeftBehind({ report: report as TeardownReport, name });
          }
        }}
      />
      <TeardownReportModal
        report={leftBehind?.report}
        serviceName={leftBehind?.name ?? ""}
        open={leftBehind !== null}
        onOpenChange={(next) => {
          if (!next) setLeftBehind(null);
        }}
        copy={{
          title: `${leftBehind?.name ?? ""} was removed, but not everything was cleaned up`,
          description: `Cloudgate could not confirm it removed everything this ${spec.noun} left on a machine. It is listed below, on the machine that still holds it.`,
          footnote: `This list is not stored anywhere. The ${spec.noun}’s row has been deleted, so once you close this it cannot be shown again.`,
        }}
      />
    </>
  );
}

/** "Add a mount" → "add a mount", for the middle of `roleRefusal`'s sentence. */
function lowerFirst(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
