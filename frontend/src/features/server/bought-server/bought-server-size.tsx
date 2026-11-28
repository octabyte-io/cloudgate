import { useState } from "react";

import { Chip } from "@/components/console/chip";
import { Modal } from "@/components/console/modal";
import { QARow } from "@/components/console/qa-row";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type {
  BoughtServerView,
  SizeChoice,
} from "@/lib/api/endpoints/bought-servers";
import { usePermission } from "@/lib/auth/use-permission";
import { cn } from "@/lib/utils";

import { FAMILIES, sizeLabel, wholeUsd } from "../buy/buy-model";
import { useBoughtServerSizes, useSetSize } from "../buy/use-bought-servers";

/** Said first, whatever the size: the change means downtime. */
export const SIZE_DOWNTIME_WARNING =
  "The Server is powered off while its size changes, usually for a few minutes. Everything running on it stops until it is back.";

/** Said first too: the disk stays as it is, so a size can always move back down. */
export const SIZE_DISK_NOTE =
  "Its disk isn't grown with the size, so you can always move back down. For more disk, add extra storage.";

function perMonth(cents: number): string {
  return `${wholeUsd(cents / 100)}/month`;
}

/** What the Server would cost a month on `size`, its backups moved with it. */
function monthlyOn(size: SizeChoice, view: BoughtServerView): number {
  return size.monthlyCents + (view.backups ? size.backupsMonthlyCents : 0);
}

/** What the lines a size change moves cost a month now. */
function movedNow(view: BoughtServerView): number {
  return view.lines
    .filter((line) => line.kind === "server" || line.kind === "backups")
    .reduce((sum, line) => sum + line.monthlyCents, 0);
}

/**
 * A Bought Server's size, and the move to another one sold where it is
 * (#1396). The move asks first and warns that the machine is powered off
 * while it changes, and that its disk is not grown; up says the rest of the
 * plan's month is charged now, down that the unused part is credited. A size
 * is described by what it is, never by the provider's code.
 */
export function BoughtServerSizeRow({
  view,
  why,
}: {
  view: BoughtServerView;
  /** Why the Server can't be changed now, or null when it can. */
  why: string | null;
}) {
  const canChange = usePermission({ server: ["create"] });
  const sizes = useBoughtServerSizes(view.id);
  const setSize = useSetSize(view.id);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);

  const all = sizes.data ?? [];
  const current = all.find((size) => size.current);
  const target =
    view.stage === "changing" && view.change?.serverType !== undefined
      ? all.find((size) => size.id === view.change?.serverType)
      : undefined;
  const others = all.filter((size) => !size.current);
  const picked = others.find((size) => size.id === chosen) ?? null;
  const up = picked ? monthlyOn(picked, view) > movedNow(view) : false;
  const blocked =
    why ??
    (others.length === 0 && sizes.isSuccess
      ? "No other size is sold where this Server is."
      : null);

  async function confirm() {
    if (!picked) return;
    setOpen(false);
    try {
      await setSize.mutateAsync(picked.id);
      toast.done(`${view.name} now runs on ${sizeLabel(picked)}.`);
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <>
      <QARow
        title="Size"
        description={
          target
            ? `Moving to ${sizeLabel(target)}.`
            : current
              ? sizeLabel(current)
              : "Up or down, among the sizes sold where it is."
        }
        action={
          <Button
            type="button"
            disabled={
              !canChange.allowed || blocked !== null || setSize.isPending
            }
            title={blocked ?? undefined}
            onClick={() => {
              setChosen(null);
              setOpen(true);
            }}
          >
            Change size
          </Button>
        }
      />

      <Modal open={open} onOpenChange={setOpen}>
        <Modal.Header
          title={`Change the size of ${view.name}?`}
          description={SIZE_DOWNTIME_WARNING}
        />
        <Modal.Body>
          <fieldset>
            <legend className="sr-only">New size</legend>
            <ul className="flex flex-col">
              {others.map((size) => {
                const id = `move-size-${size.id}`;
                const off = !size.available || size.smallerDisk;
                const family = FAMILIES.find((f) => f.value === size.family);
                return (
                  <li
                    key={size.id}
                    data-unavailable={off || undefined}
                    className={cn(
                      "flex h-row items-center gap-3 border-b border-line px-1 text-ui last:border-b-0",
                      off
                        ? "hatch text-tx-3"
                        : chosen === size.id && "bg-brand-tint",
                    )}
                  >
                    <input
                      id={id}
                      type="radio"
                      name="move-size"
                      disabled={off}
                      checked={chosen === size.id}
                      onChange={() => setChosen(size.id)}
                      className="accent-brand"
                    />
                    <label
                      htmlFor={id}
                      className={cn("flex-1", !off && "cursor-pointer")}
                    >
                      {sizeLabel(size)}
                      {family ? (
                        <span className="text-tx-3"> · {family.label}</span>
                      ) : null}
                    </label>
                    {size.smallerDisk ? (
                      <Chip>Disk too small</Chip>
                    ) : off ? (
                      <Chip>Unavailable right now</Chip>
                    ) : null}
                    <span className="num">
                      {perMonth(monthlyOn(size, view))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <p className="mt-3 text-body text-tx-2">{SIZE_DISK_NOTE}</p>
          {picked ? (
            <p className="mt-2 text-body text-tx-2">
              {up
                ? `It costs ${perMonth(monthlyOn(picked, view))}${view.backups ? " with backups" : ""}. The difference for the rest of this month of your plan is charged now.`
                : `It costs ${perMonth(monthlyOn(picked, view))}${view.backups ? " with backups" : ""}. The unused part of this month is credited on your next invoice.`}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="button"
            variant="pri"
            disabled={!canChange.allowed || !picked}
            onClick={() => void confirm()}
          >
            {up ? "Pay and change size" : "Change size"}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
