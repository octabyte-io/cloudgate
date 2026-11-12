import { useId, useState } from "react";

import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { KVList, KVRow } from "@/components/console/kv-list";
import { toast } from "@/components/console/toast";
import { Checkbox } from "@/components/ui/checkbox";
import type { Bucket, BucketDeleteReport } from "@/lib/api/endpoints/buckets";
import { bucketKeptNote } from "@/lib/api/endpoints/teardown";

/**
 * Delete a bucket, and never lose its files by accident.
 *
 * A bucket that holds files — any object, old version or delete marker — is
 * kept: on a Server its Garage goes and its volume stays with the files on
 * it; on AWS the S3 bucket stays in its account and region with Cloudgate's
 * tag. The toast names it once, since Cloudgate forgets it
 * afterwards. An empty bucket goes whole. **"Also delete its files"**
 * empties the bucket first and then removes it; it asks for nothing beyond
 * the Delete itself. An emptying that stops partway still finishes the
 * Delete and says the bucket was kept "partly emptied" — on AWS that is
 * something left, so the bucket stays here as Delete incomplete.
 *
 * Whether the bucket holds files is read as the Delete runs, so the dialog
 * promises the rule rather than the outcome, and the toast reports what
 * happened. On AWS an empty or emptied bucket goes by a Cloud run, so the
 * page stays, reading Deleting.
 */
export function DeleteBucketModal({
  bucket,
  open,
  onOpenChange,
  remove,
  onDeleted,
}: {
  bucket: Bucket;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: (deleteFiles: boolean) => Promise<BucketDeleteReport>;
  /** Where to go once its row is gone. This screen cannot stay. */
  onDeleted: () => void;
}) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const boxId = useId();
  const { place } = bucket;
  if (bucket.existing) {
    return (
      <DeleteExistingBucketModal
        bucket={bucket}
        open={open}
        onOpenChange={onOpenChange}
        remove={() => remove(false)}
        onDeleted={onDeleted}
      />
    );
  }
  const onAws = place.kind === "cloud";
  // Its cloud in words: on Google Cloud a Cloud Storage
  // bucket in a project, with Cloudgate's labels; on AWS an S3 bucket.
  // Its "Also delete its files" hint, too: on Google Cloud its HMAC key is
  // destroyed before anything touches the bucket, so an emptying that stops
  // partway leaves the bucket without it.
  const words =
    place.kind === "cloud" && place.cloud === "gcp"
      ? {
          cloud: "Google Cloud",
          bucket: "Cloud Storage bucket",
          account: "Google Cloud project",
          marks: "Cloudgate's labels, named once with its project and region",
          deleteFiles:
            "Destroys its HMAC key first, then empties the bucket, old versions included, and destroys it. If emptying stops partway, its key is already gone, and the bucket stays here as Delete incomplete, partly emptied.",
        }
      : {
          cloud: "AWS",
          bucket: "S3 bucket",
          account: "AWS account",
          marks: "Cloudgate's tag, named once with its account and region",
          deleteFiles:
            "Empties the bucket, old versions and delete markers included, then destroys it. If emptying stops partway, nothing is destroyed and the bucket stays here as Delete incomplete, partly emptied.",
        };
  const volume = `${bucket.appName}-data`;

  return (
    <ConfirmDeleteModal
      open={open}
      onOpenChange={(next) => {
        if (!next) setDeleteFiles(false);
        onOpenChange(next);
      }}
      title={`Delete ${bucket.name}`}
      confirmWord={bucket.name}
      mismatch="That does not match the bucket's name."
      button="Delete bucket"
      onConfirm={async () => {
        const answer = await remove(deleteFiles);
        setDeleteFiles(false);
        onOpenChange(false);
        if (answer.cloudDelete) {
          toast.done(`Deleting ${bucket.name}.`, {
            description: deleteFiles
              ? "A Cloud run empties it, then destroys it. This page shows how it ends."
              : "It held no files, so a Cloud run destroys it. This page shows how it ends.",
          });
          return;
        }
        const kept = answer.bucketLeftBehind;
        toast.done(`${bucket.name} deleted.`, {
          description: kept
            ? "volumeName" in kept
              ? `${bucketKeptNote(kept)} Its volume is ${kept.volumeName}.`
              : bucketKeptNote(kept)
            : answer.volumeLeftBehind
              ? `It was empty, but its volume ${volume} is still on the Server.`
              : "It held no files, so nothing is left on the Server.",
        });
        onDeleted();
      }}
    >
      {onAws ? (
        <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
          This row goes, and with it everything Cloudgate made for{" "}
          <strong className="font-medium">{bucket.bucketName}</strong> in{" "}
          {words.cloud} — unless the bucket holds files.
        </p>
      ) : (
        <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
          Its storage container is removed and this row goes with it. Anything
          reaching <strong className="font-medium">{bucket.bucketName}</strong>{" "}
          with its key stops being able to.
        </p>
      )}

      {place.kind === "cloud" ? (
        <KVList>
          <KVRow
            label={words.bucket}
            value={bucket.bucketName}
            title={bucket.bucketName}
            mono
          />
          <KVRow
            label={words.account}
            value={`${place.cloudId} (${place.cloudAccountName})`}
            title={`${place.cloudId} (${place.cloudAccountName})`}
          />
          <KVRow label="Region" value={place.region} mono />
        </KVList>
      ) : (
        <KVList>
          <KVRow
            label="Swarm service removed"
            value={bucket.appName}
            title={bucket.appName}
            mono
          />
          <KVRow label="Its volume" value={volume} title={volume} mono />
        </KVList>
      )}

      <p className="text-meta text-tx-2">
        <strong className="font-medium text-tx-2">
          A bucket that holds files is kept.
        </strong>{" "}
        Any file, old version or delete marker counts, and so does a bucket
        Cloudgate cannot read.{" "}
        {onAws
          ? `It stays in ${words.cloud} with ${words.marks}, and Cloudgate forgets it. An empty bucket is destroyed by a Cloud run.`
          : "Its volume stays on the Server with the files, named once when the Delete ends, and Cloudgate forgets it. An empty bucket is removed with its volume."}
      </p>

      <div className="flex items-start gap-2.5">
        <Checkbox
          id={boxId}
          checked={deleteFiles}
          onCheckedChange={(next) => setDeleteFiles(next === true)}
        />
        <label htmlFor={boxId} className="text-body text-tx">
          Also delete its files
          <span className="mt-0.5 block text-meta text-tx-2">
            {onAws
              ? words.deleteFiles
              : "Empties the bucket, old versions and delete markers included, then removes it with its volume. If emptying stops partway, the Delete still finishes and the bucket is kept, partly emptied."}
          </span>
        </label>
      </div>
    </ConfirmDeleteModal>
  );
}

/**
 * An existing bucket's Delete (ADR-0033): it removes only Cloudgate's
 * records of it and never touches the bucket or its files, so there is no
 * "also delete its files" box and nothing runs in AWS. On Google Cloud
 * a Cloud run destroys the key and service account Cloudgate made
 * for it, and the report names the grant the operator added. The toast
 * repeats what the API says was left.
 */
function DeleteExistingBucketModal({
  bucket,
  open,
  onOpenChange,
  remove,
  onDeleted,
}: {
  bucket: Bucket;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: () => Promise<BucketDeleteReport>;
  onDeleted: () => void;
}) {
  // On Google Cloud its key and key account are Cloudgate's, and go.
  const onGoogle =
    bucket.place.kind === "cloud" && bucket.place.cloud === "gcp";
  return (
    <ConfirmDeleteModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${bucket.name}`}
      confirmWord={bucket.name}
      mismatch="That does not match the bucket's name."
      button="Delete from Cloudgate"
      onConfirm={async () => {
        const answer = await remove();
        onOpenChange(false);
        toast.done(`${bucket.name} deleted.`, {
          description:
            answer.bucketLeftAsItWas?.message ??
            `${bucket.bucketName} was left as it was, files and all; it is yours.`,
        });
        onDeleted();
      }}
    >
      {onGoogle ? (
        <p className="rounded-lg border border-line bg-panel-2 px-3.5 py-3 text-body text-tx">
          Only what Cloudgate made goes: this Service, and the HMAC key and
          service account it made for it.{" "}
          <strong className="font-medium">{bucket.bucketName}</strong> is left
          as it was — its files, its settings, and the grant you added on it,
          which the report names with the line that removes it.
        </p>
      ) : (
        <p className="rounded-lg border border-line bg-panel-2 px-3.5 py-3 text-body text-tx">
          Only Cloudgate&apos;s records go: this Service.{" "}
          <strong className="font-medium">{bucket.bucketName}</strong> is left
          as it was — its files, its settings, nothing changed in AWS.
        </p>
      )}
      <p className="text-meta text-tx-2">
        If the Project config still lists {bucket.configName}, the next plan
        creates it as a new, empty bucket.
      </p>
    </ConfirmDeleteModal>
  );
}
