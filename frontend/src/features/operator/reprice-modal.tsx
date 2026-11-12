import { useState } from "react";

import { Chip } from "@/components/console/chip";
import { DataTable, type Column } from "@/components/console/data-table";
import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { formatDay, formatMoney } from "@/lib/api/endpoints/billing";
import type { RepricePreview } from "@/lib/api/endpoints/operator";
import { errorMessage } from "@/lib/api/error-message";

import { useApplyReprice, useRepricePreview } from "./use-operator";

const usd = (cents: number) => formatMoney(cents, "usd");

/** What happens to each Bought Server, in the preview's words. */
function whenCell(row: RepricePreview): React.ReactNode {
  switch (row.status) {
    case "rise":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Chip variant="warn">Rise</Chip>
          {`from ${formatDay(row.startsAt!)}`}
        </span>
      );
    case "fall":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Chip variant="ok">Fall</Chip>
          at once
        </span>
      );
    case "unchanged":
      return "Already at the list price";
    case "unpriceable":
      return "Not on the provider's list: left as it is";
    case "not-repriceable":
      return "Not sold now: left as it is";
  }
}

const COLUMNS: Column<RepricePreview>[] = [
  { id: "name", head: "Server", tone: "key", cell: (row) => row.name },
  {
    id: "organization",
    head: "Organization",
    truncate: true,
    cell: (row) => row.organization.name,
  },
  {
    id: "old",
    head: "Now",
    tone: "num",
    cell: (row) => usd(row.oldMonthlyCents),
  },
  {
    id: "new",
    head: "New",
    tone: "num",
    cell: (row) =>
      row.newMonthlyCents === null ? "—" : usd(row.newMonthlyCents),
  },
  { id: "when", head: "Applies", cell: whenCell },
];

/** Whether a previewed Bought Server gets a new price on confirm. */
const applies = (row: RepricePreview) =>
  row.status === "rise" || row.status === "fall";

/**
 * The reprice of the chosen Bought Servers (spec #1387, #1400): each one's
 * old price and its price at the provider's current list plus the current
 * Server markup, then Confirm. A rise starts 30 days on, a fall at once,
 * and each Organization's owners are emailed. The confirm carries the prices
 * shown, and the backend refuses it if any has moved since, so what is
 * applied is what was previewed.
 *
 * Held by the list and keyed on each opening, so the preview is asked
 * afresh every time.
 */
export function RepriceModal({
  ids,
  open,
  onOpenChange,
}: {
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useRepricePreview(ids, open);
  const apply = useApplyReprice();
  const [refusal, setRefusal] = useState<string | null>(null);

  const chosen = preview.data?.filter(applies) ?? [];

  return (
    <Modal open={open} onOpenChange={onOpenChange} wide>
      <Modal.Header
        title="Reprice Bought Servers"
        description="At the provider's current list plus the current Server markup. A rise starts 30 days from now, a fall at once, and each Organization's owners are emailed. Recorded in each Organization's audit log."
      />
      <Modal.Body>
        {preview.error ? (
          <FormError message={errorMessage(preview.error)} />
        ) : preview.isPending ? (
          <p aria-busy="true" className="text-body text-tx-2">
            Pricing the chosen Bought Servers…
          </p>
        ) : (
          <DataTable
            label="The reprice of the chosen Bought Servers"
            rows={preview.data}
            columns={COLUMNS}
            getRowId={(row) => row.id}
            rowName={(row) => row.name}
          />
        )}
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Cancel</Button>} />
        <Button
          type="button"
          variant="pri"
          disabled={chosen.length === 0 || apply.isPending}
          aria-busy={apply.isPending || undefined}
          onClick={async () => {
            setRefusal(null);
            try {
              await apply.mutateAsync(
                chosen.map((row) => ({
                  id: row.id,
                  newMonthlyCents: row.newMonthlyCents!,
                })),
              );
              toast.done(
                chosen.length === 1
                  ? `Repriced ${chosen[0].name}.`
                  : `Repriced ${chosen.length} Bought Servers.`,
              );
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
              void preview.refetch();
            }
          }}
        >
          {chosen.length === 1
            ? "Reprice 1 Bought Server"
            : `Reprice ${chosen.length} Bought Servers`}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
