import { useId, useState } from "react";

import { Modal } from "@/components/console/modal";
import { QARow } from "@/components/console/qa-row";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BoughtServerView } from "@/lib/api/endpoints/bought-servers";

import { storageMonthly, wholeUsd } from "../buy/buy-model";
import {
  useBoughtServerCatalogue,
  useGrowStorage,
} from "../buy/use-bought-servers";

/** Where the machine mounts the extra storage (`bought-servers/storage.ts`). */
export const STORAGE_MOUNT_POINT = "/mnt/storage";

/** Said beside extra storage, and when growing it (ADR-0071). */
export const STORAGE_NOT_IN_BACKUPS =
  "It isn't in backups: back it up to a Destination outside this Server with volume backups.";

/**
 * A Bought Server's **extra storage** on its Settings: its size and price,
 * where it is mounted, that it isn't in backups, and *Grow*. Growing asks
 * first with the new price, says the rest of the plan's month is charged
 * now and that it can never shrink again; the filesystem is grown for the
 * customer. Nothing is shown for a Server bought without it.
 */
export function ExtraStorageRow({
  view,
  why,
}: {
  view: BoughtServerView;
  /** Why it can't be grown now (role, or not Ready), or null. */
  why: string | null;
}) {
  const grow = useGrowStorage(view.id);
  const catalogue = useBoughtServerCatalogue(view.storageGb !== null);
  const [asking, setAsking] = useState(false);
  const [sizeGb, setSizeGb] = useState<number | null>(null);
  const inputId = useId();

  if (view.storageGb === null) return null;
  const current = view.storageGb;
  const shownGb =
    view.stage === "changing" && view.change?.storageGb !== undefined
      ? view.change.storageGb
      : current;
  const line = view.lines.find((entry) => entry.kind === "storage");
  const storage = catalogue.data?.storage;
  const maxGb = storage?.maxGb ?? 10240;

  const tooSmall = sizeGb !== null && sizeGb <= current;
  const tooBig = sizeGb !== null && sizeGb > maxGb;
  const valid =
    sizeGb !== null && Number.isInteger(sizeGb) && !tooSmall && !tooBig;
  const hint = tooSmall
    ? `Extra storage can only grow. Choose more than ${current} GB.`
    : tooBig
      ? `Extra storage is at most ${maxGb.toLocaleString("en-US")} GB.`
      : sizeGb !== null && !Number.isInteger(sizeGb)
        ? "Extra storage is a whole number of GB."
        : null;

  async function confirm() {
    if (!valid) return;
    setAsking(false);
    try {
      await grow.mutateAsync(sizeGb);
      toast.done(`The extra storage of ${view.name} is now ${sizeGb} GB.`);
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <>
      <QARow
        title="Extra storage"
        description={`${shownGb} GB${line ? ` · ${wholeUsd(line.monthlyCents / 100)}/month` : ""}, mounted at ${STORAGE_MOUNT_POINT}. ${STORAGE_NOT_IN_BACKUPS} It can grow but never shrink.`}
        action={
          <Button
            type="button"
            disabled={why !== null || grow.isPending}
            title={why ?? undefined}
            onClick={() => {
              setSizeGb(null);
              setAsking(true);
            }}
          >
            Grow
          </Button>
        }
      />

      <Modal open={asking} onOpenChange={(open) => !open && setAsking(false)}>
        <Modal.Header
          title={`Grow the extra storage of ${view.name}?`}
          description="The rest of this month of your plan is charged now, then it renews with it. The filesystem is grown for you."
        />
        <Modal.Body className="grid gap-2">
          <label htmlFor={inputId} className="text-body text-tx">
            New size, now {current} GB
            {valid && storage
              ? ` · ${wholeUsd(storageMonthly(sizeGb, storage.perGbMonthly))}/month`
              : ""}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={current + 1}
              max={maxGb}
              step={10}
              aria-invalid={hint !== null || undefined}
              value={sizeGb ?? ""}
              onChange={(event) => {
                const value = event.target.value.trim();
                setSizeGb(value === "" ? null : Number(value));
              }}
              className="max-w-40"
            />
            <span className="text-ui text-tx-3">GB</span>
          </div>
          {hint ? <p className="text-meta text-bad">{hint}</p> : null}
          <p className="text-body text-tx-2">
            Extra storage can&rsquo;t shrink again, so grow it only as far as
            you need. {STORAGE_NOT_IN_BACKUPS}
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="button"
            variant="pri"
            disabled={!valid}
            onClick={() => void confirm()}
          >
            {valid ? `Pay and grow to ${sizeGb} GB` : "Pay and grow"}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
