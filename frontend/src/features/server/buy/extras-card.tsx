import { Card } from "@/components/console/card";
import { example } from "@/components/console/form-spec";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { BuyNote } from "./buy-note";
import { storageMonthly, wholeUsd } from "./buy-model";

/**
 * Backups and extra storage, each with its price and ADR-0071's warnings,
 * shown while the extra is on: backups leave extra storage out and are all
 * deleted when turned off; extra storage is not in backups, only grows, and
 * belongs in volume backups to a Destination outside the Server.
 */
export function ExtrasCard({
  backups,
  onBackups,
  backupsMonthly,
  storageGb,
  onStorageGb,
  storage,
}: {
  backups: boolean;
  onBackups: (on: boolean) => void;
  /** Null until a size and Location are chosen. */
  backupsMonthly: number | null;
  /** The typed size, or null for none. */
  storageGb: number | null;
  onStorageGb: (gb: number | null) => void;
  storage: { minGb: number; maxGb: number; perGbMonthly: number };
}) {
  const outOfRange =
    storageGb !== null &&
    (storageGb < storage.minGb || storageGb > storage.maxGb);

  return (
    <Card>
      <Card.Header title="3. Extras" headingLevel={2} />
      <Card.Body className="grid gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-body text-tx">
              <span className="font-medium">Backups</span>{" "}
              <span className="text-tx-3">
                ·{" "}
                {backupsMonthly === null
                  ? "priced once you pick a size"
                  : `${wholeUsd(backupsMonthly)}/month`}
              </span>
            </p>
            <p className="text-meta text-tx-3">
              A copy of the Server&rsquo;s own disk every day, the last 7 kept.
            </p>
            {backups ? (
              <BuyNote tone="warn" className="animate-rise">
                Backups don&rsquo;t include extra storage. Turning backups off
                later deletes every backup at once.
              </BuyNote>
            ) : null}
          </div>
          <Switch
            checked={backups}
            aria-label="Backups"
            onCheckedChange={(next) => onBackups(Boolean(next))}
          />
        </div>

        <div className="grid gap-1.5 border-t border-line pt-4">
          <label htmlFor="extra-storage" className="text-body text-tx">
            <span className="font-medium">Extra storage</span>{" "}
            <span className="text-tx-3">
              ·{" "}
              {storageGb !== null && !outOfRange
                ? `${wholeUsd(storageMonthly(storageGb, storage.perGbMonthly))}/month`
                : `from ${storage.minGb} GB to ${(storage.maxGb / 1024).toLocaleString("en-US")} TB`}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="extra-storage"
              type="number"
              inputMode="numeric"
              min={storage.minGb}
              max={storage.maxGb}
              step={10}
              placeholder={example("100")}
              aria-invalid={outOfRange || undefined}
              aria-describedby="extra-storage-hint"
              value={storageGb ?? ""}
              onChange={(event) => {
                const value = event.target.value.trim();
                onStorageGb(value === "" ? null : Number(value));
              }}
              className="max-w-40"
            />
            <span className="text-ui text-tx-3">GB</span>
          </div>
          <p id="extra-storage-hint" className="text-meta text-tx-3">
            {outOfRange
              ? `Extra storage is between ${storage.minGb} GB and ${storage.maxGb.toLocaleString("en-US")} GB.`
              : "A separate disk; leave it empty for none. It can grow later but never shrink."}
          </p>
          {storageGb !== null && !outOfRange ? (
            <BuyNote tone="warn">
              Extra storage isn&rsquo;t in backups. Back it up to a Destination
              outside this Server with volume backups.
            </BuyNote>
          ) : null}
        </div>
      </Card.Body>
    </Card>
  );
}
