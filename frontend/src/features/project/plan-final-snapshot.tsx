import { useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { cloudName } from "@/lib/api/endpoints/cloud-accounts";
import type { FinalSnapshotOnDestroy } from "@/lib/api/endpoints/project-config";
import { Icon } from "@/lib/design/icons";
import { usd } from "@/lib/format/money";

/**
 * What a cloud keeps of a deleted database, and where it is deleted. A
 * Stack VM's data disk (`dataDisk`) is kept as a disk snapshot on either
 * cloud.
 */
export function keptCopy(
  cloud: "aws" | "gcp" | undefined,
  dataDisk = false,
): {
  copy: string;
  where: string;
} {
  const where = cloudName(cloud);
  if (dataDisk) return { copy: "snapshot", where };
  return cloud === "gcp"
    ? { copy: "backup", where }
    : { copy: "snapshot", where };
}

/**
 * A cloud database's destroy line: it keeps a
 * final snapshot, named, with about what it costs — or, with its box ticked,
 * its data is deleted for good. On Google Cloud it keeps a final backup.
 */
export function FinalSnapshotLine({
  snapshot,
  deleteData,
}: {
  snapshot: FinalSnapshotOnDestroy;
  deleteData: boolean;
}) {
  const { copy, where } = keptCopy(snapshot.cloud, snapshot.of === "data-disk");
  return (
    <p
      aria-label="Final snapshot"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-tx-2"
    >
      <Icon
        name={deleteData ? "alert" : "hdd"}
        className="flex-none text-tx-3"
      />
      {deleteData ? (
        <span className="font-medium text-tx">Data deleted for good</span>
      ) : (
        <span>
          Keeps a final {copy}{" "}
          <span className="font-mono font-medium text-tx">{snapshot.name}</span>
          {snapshot.monthlyUsd === null
            ? ", which Cloudgate has no price for in this region,"
            : `, about ${usd(snapshot.monthlyUsd)} a month,`}{" "}
          until you delete it in {where}.
        </span>
      )}
    </p>
  );
}

/**
 * "Also delete its data (no final snapshot)", one per cloud database this
 * plan destroys, sent as `deleteDataOf`. It needs no statement beyond
 * the destroy's own `service: delete`.
 */
export function DeleteDataBox({
  configName,
  cloud,
  dataDisk = false,
  checked,
  onCheckedChange,
}: {
  configName: string;
  cloud?: "aws" | "gcp";
  /** A Stack VM's data disk, kept as a disk snapshot, rather than a database. */
  dataDisk?: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  const { copy } = keptCopy(cloud, dataDisk);
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <label htmlFor={id} className="text-body text-tx">
        Also delete the data of{" "}
        <span className="font-mono font-medium">{configName}</span> (no final{" "}
        {copy})
        <span className="mt-0.5 block text-meta text-tx-2">
          No {copy} is taken, so nothing of it can be restored.
        </span>
      </label>
    </div>
  );
}
