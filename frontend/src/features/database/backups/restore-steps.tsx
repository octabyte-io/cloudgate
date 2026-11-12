import { Field } from "@/components/console/field";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Input } from "@/components/ui/input";
import type { BackupFile } from "@/lib/api/endpoints/backups";
import type { Database } from "@/lib/api/endpoints/databases";
import type { Destination } from "@/lib/api/endpoints/destinations";

/**
 * The restore's three steps, as content — the modal beside this is flow control.
 * F10's `restore-steps.tsx` made the same split for the same reason.
 */

/**
 * **A picked file, not a typed key.** This flow has always had
 * `GET /backups/files`, so the object is chosen from what is really in the bucket
 * and cannot be a typo.
 */
export function FileStep({
  file,
  destination,
}: {
  file: BackupFile;
  destination: Destination;
}) {
  return (
    <KVList>
      <KVRow label="File" value={file.Name} title={file.Name} mono />
      <KVRow label="Key" value={file.Path} title={file.Path} mono />
      <KVRow
        label="Destination"
        value={destination.name}
        title={destination.name}
      />
      <KVRow
        label="Bucket"
        value={destination.bucket}
        title={destination.bucket}
        mono
      />
    </KVList>
  );
}

/**
 * **The target database is not implied by the dump.** `POST /backups/restore`
 * takes `databaseName` separately from the service, so a dump of `orders` can be
 * restored into `orders_staging` inside the same engine — and for MongoDB it has to
 * be named, because the root user owns every database on the server and there is no
 * single one to default to.
 */
export function TargetStep({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The engine's own sentence, from its descriptor. */
  hint: string;
}) {
  return (
    <>
      <Field name="databaseName" label="Database" hint={hint}>
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-meta md:text-meta"
        />
      </Field>
      {/* The dump is not inspected first, so the name is not checked against
          the file: a mismatch fails inside the engine, and the error comes
          back from the restore command. Said once, as a fact to act on. */}
      <p className="text-meta text-tx-3">
        A name the dump does not expect fails inside the engine, not here.
      </p>
    </>
  );
}

/**
 * The step that makes this a flow rather than a button.
 *
 * Every engine's restore command **drops as it goes** — `mongorestore --drop`, a
 * `mysql <` over a dump full of `DROP TABLE`, `pg_restore` into a live database.
 * There is no dry run and nothing takes a copy first, which is why this is the one
 * action on these screens that asks for the name to be typed.
 */
export function ConfirmStep({
  database,
  databaseName,
  engineLabel,
  file,
  typed,
  onTyped,
  confirmed,
}: {
  database: Database;
  databaseName: string;
  engineLabel: string;
  file: BackupFile;
  typed: string;
  onTyped: (value: string) => void;
  confirmed: boolean;
}) {
  return (
    <>
      <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-bad">
        Everything in{" "}
        <strong className="font-medium wrap-anywhere">{databaseName}</strong> is
        replaced by the contents of that dump. The restore command drops as it goes,
        nothing takes a copy first, and this cannot be undone.
      </p>
      <KVList>
        <KVRow label="From" value={file.Name} title={file.Path} mono />
        <KVRow label="Into" value={databaseName} title={databaseName} mono />
        <KVRow label="On" value={database.name} title={database.name} />
        <KVRow label="Engine" value={engineLabel} />
      </KVList>
      <Field
        name="typed"
        label={`Type ${database.name} to confirm`}
        error={
          typed !== "" && !confirmed
            ? "That does not match the database's name."
            : undefined
        }
      >
        <Input
          value={typed}
          onChange={(event) => onTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-meta md:text-meta"
        />
      </Field>
    </>
  );
}
