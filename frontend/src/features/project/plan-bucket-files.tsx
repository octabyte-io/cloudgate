import { useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import type { BucketFiles } from "@/lib/api/endpoints/project-config";
import { Icon } from "@/lib/design/icons";

/**
 * A bucket destroy's files, as the plan read them: *holds
 * files*, *empty* or *can't tell* — no counts, no sizes. *Can't tell* is kept
 * as if it holds files. The step reads them again as it runs.
 */
const FILES: Record<BucketFiles, { label: string; then: string }> = {
  "holds-files": {
    label: "Holds files",
    then: "Kept with its volume and named in the result, unless you tick the box.",
  },
  empty: {
    label: "Empty",
    then: "Removed with its volume.",
  },
  unknown: {
    label: "Can't tell",
    then: "Kept as if it holds files, unless you tick the box.",
  },
};

export function BucketFilesLine({ files }: { files: BucketFiles }) {
  const { label, then } = FILES[files];
  return (
    <p
      aria-label="Bucket files"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-tx-2"
    >
      <Icon
        name={files === "empty" ? "check" : "hdd"}
        className="flex-none text-tx-3"
      />
      <span className="font-medium text-tx">{label}</span>
      <span>{then}</span>
    </p>
  );
}

/**
 * A Compose stack destroy's volumes (ADR-0069): its Delete removes the
 * volumes its compose file declares, named as its last successful deploy
 * recorded them, or said to be unknown when none has.
 */
export function ComposeVolumesLine({
  volumes,
  keptInSnapshot = false,
}: {
  volumes: string[] | null;
  /** A Stack VM's: its volumes go with its data disk, kept as a final snapshot. */
  keptInSnapshot?: boolean;
}) {
  const kept = keptInSnapshot ? ", kept in its final snapshot" : "";
  return (
    <p
      aria-label="Volumes removed"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-tx-2"
    >
      <Icon name="hdd" className="flex-none text-tx-3" />
      {volumes === null ? (
        <span>
          Removes the volumes its compose file declares{kept}; no deploy has
          recorded them yet.
        </span>
      ) : volumes.length === 0 ? (
        <span>Removes no volume.</span>
      ) : (
        <span>
          Removes its volumes{keptInSnapshot ? kept : " and their data"}:{" "}
          {volumes.map((volume, index) => (
            <span key={volume}>
              {index > 0 ? ", " : null}
              <span className="font-mono text-tx">{volume}</span>
            </span>
          ))}
        </span>
      )}
    </p>
  );
}

/**
 * An existing bucket's or database's destroy (ADR-0033): only
 * Cloudgate's records go, and what it uses as given is left as it was —
 * so a bucket's files are not read and there is no box to delete them.
 */
export function ExistingLeftLine({
  kind,
  identifier,
}: {
  kind: string;
  identifier: string;
}) {
  return (
    <p
      aria-label="Left as it was"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-tx-2"
    >
      <Icon name="check" className="flex-none text-tx-3" />
      <span>
        Uses the existing {kind === "bucket" ? "bucket" : "database"}{" "}
        <span className="font-mono text-tx">{identifier}</span>, which is left
        as it was{kind === "bucket" ? ", files and all" : ""}: only
        Cloudgate&apos;s records go.
      </span>
    </p>
  );
}

/** "Also delete its files", one per bucket this plan destroys. */
export function DeleteFilesBox({
  configName,
  checked,
  onCheckedChange,
}: {
  configName: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <label htmlFor={id} className="text-body text-tx">
        Also delete the files of{" "}
        <span className="font-mono font-medium">{configName}</span>
        <span className="mt-0.5 block text-meta text-tx-2">
          Empties the bucket, old versions and delete markers included, then
          removes it with its volume.
        </span>
      </label>
    </div>
  );
}
