import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { RowTime } from "@/components/console/rows/cells";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { OperatorOrphanMachine } from "@/lib/api/endpoints/operator";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { useDeleteOrphanMachine, useOrphanMachines } from "./use-operator";

const TITLE = "Machines nothing owns";

/**
 * The Operator page's **Machines nothing owns** (spec #1387, #1402): the
 * machines the hourly check found in the provider's account with
 * Cloudgate's labels and no live Bought Server behind them, each with its
 * labels and age, and Delete. Nothing deletes them by itself: after a
 * database restored from a backup, one may still be a customer's. Rendered
 * only for an Operator, inside `OperatorSection`.
 */
export function OrphanMachinesSection() {
  const list = useOrphanMachines(true);
  const [deleting, setDeleting] = useState<OperatorOrphanMachine | null>(null);

  const arrival = useArrival(list.isPending);
  if (list.isPending) return <SectionPending title={TITLE} rows={2} />;
  if (list.error) {
    return (
      <SectionFailed
        title={TITLE}
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  }

  return (
    <Card className={arrival}>
      <Card.Header
        title={TITLE}
        sub="Machines with Cloudgate labels and no live Bought Server behind them, as the hourly check last found them. Each is emailed to the Operators once. They go on being billed until deleted."
        headingLevel={2}
      />
      <Card.Body flush>
        <DataTable
          label={TITLE}
          rows={list.data}
          columns={[...COLUMNS, actionsColumn(setDeleting)]}
          getRowId={(row) => String(row.providerServerId)}
          rowName={(row) => row.name}
          empty={
            <EmptyState icon="server" title="No machines nothing owns">
              Every machine with Cloudgate labels has a live Bought Server
              behind it.
            </EmptyState>
          }
        />
      </Card.Body>
      {deleting ? (
        <DeleteOrphanMachineModal
          machine={deleting}
          onOpenChange={(open) => !open && setDeleting(null)}
        />
      ) : null}
    </Card>
  );
}

function DeleteOrphanMachineModal({
  machine,
  onOpenChange,
}: {
  machine: OperatorOrphanMachine;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteOrphanMachine();
  return (
    <ConfirmDeleteModal
      open
      onOpenChange={onOpenChange}
      title={`Delete ${machine.name}?`}
      description="Its disk, backups, Volume and Primary IPs are deleted. This cannot be undone."
      confirmWord={machine.name}
      mismatch="That does not match the machine's name."
      button="Delete this machine"
      onConfirm={async () => {
        await remove.mutateAsync(machine.providerServerId);
        toast.done(`Machine ${machine.name} deleted.`, {
          description:
            "With its Volume and Primary IPs. Recorded in the Instance organization's audit log.",
        });
        onOpenChange(false);
      }}
    >
      <p className="text-body text-tx">
        This deletes machine{" "}
        <strong className="font-medium">{machine.providerServerId}</strong> with
        everything on it, then its Volume and Primary IPs, which would otherwise
        go on being billed. If the database was restored from a backup, check
        its labels first: it may be a customer’s Server whose record was lost. A
        machine a live Bought Server owns again is refused.
      </p>
    </ConfirmDeleteModal>
  );
}

function labelsCell(row: OperatorOrphanMachine): React.ReactNode {
  const entries = Object.entries(row.labels);
  if (entries.length === 0) return "—";
  return (
    <span className="inline-flex flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <Chip key={key} variant="mono">{`${key}=${value}`}</Chip>
      ))}
    </span>
  );
}

const COLUMNS: Column<OperatorOrphanMachine>[] = [
  {
    id: "name",
    head: "Machine",
    tone: "key",
    cell: (row) => row.name,
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    id: "provider-id",
    head: "Provider id",
    cell: (row) => row.providerServerId,
  },
  {
    id: "location",
    head: "Location",
    cell: (row) => <Chip variant="mono">{row.location}</Chip>,
  },
  {
    id: "labels",
    head: "Labels",
    cell: labelsCell,
  },
  {
    id: "age",
    head: "Made",
    cell: (row) => <RowTime iso={row.createdAt} />,
    compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
  },
  {
    id: "found",
    head: "Found",
    cell: (row) => <RowTime iso={row.foundAt} />,
    compare: (a, b) => a.foundAt.localeCompare(b.foundAt),
  },
];

function actionsColumn(
  setDeleting: (machine: OperatorOrphanMachine) => void,
): Column<OperatorOrphanMachine> {
  return {
    id: "actions",
    head: <span className="sr-only">Actions</span>,
    cell: (row) => (
      <Button
        type="button"
        size="xs"
        variant="dngr"
        onClick={() => setDeleting(row)}
      >
        Delete
      </Button>
    ),
  };
}
