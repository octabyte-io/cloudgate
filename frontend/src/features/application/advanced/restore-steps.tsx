import { Field } from "@/components/console/field";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Picker } from "@/components/console/picker";
import { Input } from "@/components/ui/input";
import type {
  Destination,
  DestinationObject,
} from "@/lib/api/endpoints/destinations";

import { TarballPicker } from "./tarball-picker";
import { example } from "@/components/console/form-spec";

/**
 * The three steps of the restore flow, as three components.
 *
 * Split out of `restore-modal.tsx` so that file is **flow control** — which step
 * we are on, what each transition requires, and what the footer offers — and
 * this one is content. They are three separate components rather than one
 * switch because the steps share no markup: two pickers, a text field and a
 * summary, a warning and a typed confirmation.
 */

export function ChooseTarballStep({
  destinations,
  destinationsPending,
  destinationId,
  onDestinationChange,
  objects,
  objectsPending,
  objectsError,
  objectsFetching,
  onRefreshObjects,
  prefix,
  onPrefixChange,
  bucket,
  backupFileName,
  onChooseTarball,
}: {
  destinations: Destination[];
  destinationsPending: boolean;
  destinationId: string;
  onDestinationChange: (value: string) => void;
  objects: DestinationObject[] | undefined;
  objectsPending: boolean;
  objectsError: unknown;
  objectsFetching: boolean;
  onRefreshObjects: () => void;
  prefix: string;
  onPrefixChange: (value: string) => void;
  bucket: string | undefined;
  /** The chosen object's key, or `""`. */
  backupFileName: string;
  onChooseTarball: (object: DestinationObject) => void;
}) {
  return (
    <>
      <Field
        name="destinationId"
        label="Destination"
        manual
        hint="Where the tarball is."
      >
        <Picker
          options={destinations.map((item) => ({
            value: item.destinationId,
            label: item.name,
            detail: item.bucket,
          }))}
          pending={destinationsPending}
          placeholder="Choose a destination"
          value={destinationId}
          onValueChange={onDestinationChange}
        />
      </Field>

      <Field
        name="backupFileName"
        label="Tarball"
        manual
        hint="Read straight from the bucket, newest first, so this is what a restore can actually use. Everything up to the last slash narrows the listing."
      >
        <TarballPicker
          objects={objects}
          pending={objectsPending}
          error={objectsError}
          waiting={destinationId === ""}
          fetching={objectsFetching}
          prefix={prefix}
          onPrefixChange={onPrefixChange}
          bucket={bucket}
          value={backupFileName}
          onChoose={onChooseTarball}
          onRefresh={onRefreshObjects}
        />
      </Field>
    </>
  );
}

export function ConfirmVolumeStep({
  volumeName,
  onVolumeNameChange,
  serviceName,
  tarball,
  backupFileName,
}: {
  volumeName: string;
  onVolumeNameChange: (value: string) => void;
  serviceName: string;
  /** The key with its bucket, when the destination is known. */
  tarball: string;
  backupFileName: string;
}) {
  return (
    <>
      <Field
        name="volumeName"
        label="Volume"
        hint="The tarball is unpacked into this volume on the Server this Service runs on."
      >
        <Input
          value={volumeName}
          onChange={(event) => onVolumeNameChange(event.target.value)}
          placeholder={example("storefront-uploads")}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-meta md:text-meta"
        />
      </Field>

      <KVList>
        <KVRow label="Into" value={serviceName} />
        <KVRow label="From" value={tarball} title={backupFileName} mono />
      </KVList>
    </>
  );
}

export function ReplaceContentsStep({
  volumeName,
  serviceName,
  tarball,
  backupFileName,
  typed,
  onTypedChange,
}: {
  volumeName: string;
  serviceName: string;
  tarball: string;
  backupFileName: string;
  typed: string;
  onTypedChange: (value: string) => void;
}) {
  return (
    <>
      <p className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-body text-bad">
        Everything currently in{" "}
        <strong className="font-medium">{volumeName}</strong> is replaced by the
        contents of that tarball. There is no copy of what is there now, and this
        cannot be undone.
      </p>

      <KVList>
        <KVRow label="Volume" value={volumeName} mono />
        <KVRow label="Tarball" value={tarball} title={backupFileName} mono />
        <KVRow label="On" value={serviceName} />
      </KVList>

      <Field
        name="typed"
        label={`Type ${volumeName} to confirm`}
        hint="The one action on these screens that asks for this, because it is the one that destroys data with no copy anywhere."
      >
        <Input
          value={typed}
          onChange={(event) => onTypedChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-meta md:text-meta"
        />
      </Field>
    </>
  );
}
