import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Stepper } from "@/components/console/stepper";
import { toast } from "@/components/console/toast";
import type {
  BackupDatabaseType,
  BackupFile,
  RestoreBackupInput,
} from "@/lib/api/endpoints/backups";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import type { Destination } from "@/lib/api/endpoints/destinations";
import { errorMessage } from "@/lib/api/error-message";

import { DATABASE_KIND } from "../kinds";
import { RestoreFooter } from "./restore-footer";
import { ConfirmStep, FileStep, TargetStep } from "./restore-steps";

/**
 * Restore a dump into this database, in three steps, with the destructive one
 * named.
 *
 * **Step one is a picked file, not a typed key.** This flow has always had
 * `GET /backups/files`, so the object is chosen from what is really in the
 * bucket and cannot be a typo. F10's volume restore used to be the exception,
 * asking for an S3 key blind; it picks from
 * `GET /destinations/:id/objects` now
 * so the two flows
 * agree. The two routes overlap and should probably converge — this one is
 * non-recursive and puts its credentials in argv.
 *
 * The middle step exists because **the target database is not implied by the
 * dump**. `POST /backups/restore` takes `databaseName` separately from the
 * service, so a dump of `orders` can be restored into `orders_staging` inside
 * the same engine — and for MongoDB it has to be named, because the root user
 * owns every database on the server and there is no single one to default to.
 *
 * The third step is the whole reason this is a flow rather than a button. Every
 * engine's restore command **drops as it goes** — `mongorestore --drop`, a
 * `mysql <` over a dump full of `DROP TABLE`, `pg_restore` into a live database.
 * There is no dry run and nothing takes a copy first.
 */

type Step = "file" | "target" | "confirm";

const STEPS = [
  { id: "file", label: "Choose the dump" },
  { id: "target", label: "Name the database" },
  { id: "confirm", label: "Replace its contents" },
] as const;

export function RestoreModal({
  database,
  kind,
  destination,
  file,
  open,
  onOpenChange,
  restore,
}: {
  database: Database;
  kind: DatabaseKind;
  /** The destination the file came from. Both are needed to restore. */
  destination: Destination | undefined;
  file: BackupFile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restore: (input: RestoreBackupInput) => Promise<unknown>;
}) {
  const descriptor = DATABASE_KIND[kind];
  const [step, setStep] = useState<Step>("file");
  const [databaseName, setDatabaseName] = useState(
    database.databaseName ?? "",
  );
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // The engine has no dump command, so there is nothing this dialog could do.
  // The Backups tab does not offer it in that case; this is the backstop.
  const backupType = descriptor.backup;

  const ready = file !== null && destination !== undefined;
  const named = databaseName.trim() !== "";
  const confirmed = typed.trim() === database.name;

  function close(next: boolean) {
    if (!next) {
      setStep("file");
      setTyped("");
      setRefusal(null);
    }
    onOpenChange(next);
  }

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (!ready || !confirmed || running || !backupType) return;
    setRefusal(null);
    setRunning(true);
    try {
      await restore({
        databaseId: database.databaseId,
        databaseType: backupType as BackupDatabaseType,
        databaseName: databaseName.trim(),
        backupFile: file.Path,
        destinationId: destination.destinationId,
      });
      toast.done(`${file.Name} was restored into ${database.name}.`);
      close(false);
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={close}>
      <Modal.Header
        title={`Restore into ${database.name}`}
        description="This replaces what is in the database now."
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          <Stepper
            label={`Restore a dump into ${database.name}`}
            steps={STEPS.map((entry) => ({
              id: entry.id,
              label: entry.label,
              done: STEPS.findIndex((s) => s.id === step) > STEPS.indexOf(entry),
            }))}
            currentId={step}
          />

          {/* Keyed on the step: each step's body replaces the last in place,
              so it fades in rather than snapping, and the Stepper above says
              where in the flow this is. */}
          <div key={step} className="flex animate-fade flex-col gap-3.5">
            {step === "file" ? (
              !ready ? (
                <p className="text-body text-tx-2">
                  Pick a dump from the table behind this dialog to start.
                </p>
              ) : (
                <FileStep file={file} destination={destination} />
              )
            ) : null}

            {step === "target" ? (
              <TargetStep
                value={databaseName}
                onChange={setDatabaseName}
                hint={
                  descriptor.backupDatabaseHint?.restore ??
                  "The database inside this server the dump goes into."
                }
              />
            ) : null}

            {step === "confirm" && ready ? (
              <ConfirmStep
                database={database}
                databaseName={databaseName}
                engineLabel={descriptor.label}
                file={file}
                typed={typed}
                onTyped={setTyped}
                confirmed={confirmed}
              />
            ) : null}
          </div>

          <FormError message={refusal ?? undefined} />
        </Modal.Body>

        <RestoreFooter
          step={step}
          ready={ready}
          named={named}
          confirmed={confirmed}
          running={running}
          onBack={() => setStep(step === "confirm" ? "target" : "file")}
          onNext={() => setStep(step === "file" ? "target" : "confirm")}
        />
      </form>
    </Modal>
  );
}
