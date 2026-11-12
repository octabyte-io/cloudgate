import { useState } from "react";

import { Field, FormError } from "@/components/console/field";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";

import { DATABASE_KIND } from "../kinds";
import { wasRefused } from "../use-database";

/**
 * What the dialog says when the rebuild did not come back with an answer
 * a 5xx, a proxy timeout, or a dropped connection.
 *
 * A refusal (4xx) is the backend's own account and is shown as it is — the
 * rebuild answers 409 naming the step that stopped it and what is true
 * afterwards. Anything else cannot be read that way. A rebuild does its work
 * in steps, so by the time it fails the service may already be gone; and it
 * waits for the volume to be released and then converges a fresh service
 * inside the request, which can outlast the connection. "Nothing changed" and
 * "could not reach the backend" are both claims this cannot make. What it can
 * say is where the truth is, and that a second Rebuild finishes the job.
 */
const DID_NOT_COME_BACK =
  "The rebuild did not come back with an answer. It may still be running, or it may have stopped part way with the service already removed. Watch the status beside the name: if it reads error, Rebuild again to finish.";

/**
 * Rebuild, and say plainly that it deletes the data.
 *
 * **The word is the problem this dialog exists to solve.** "Rebuild" reads like
 * an Application's rebuild — throw the container away, build a new one from the
 * same source, nothing of value lost. For a database it is
 * `docker volume rm <appName>-data --force` followed by a fresh deploy
 * (`BaseDatabaseService.rebuild`), which is a factory reset. Somebody reaching for
 * it because the container is wedged is one click from an empty database, and
 * the button's own label will not stop them.
 *
 * So the dialog names the volume, names what survives (nothing), and asks for
 * the database's name to be typed. It is the only typed confirmation in this
 * phase, on the same principle F10 used for a volume restore: every other
 * destructive thing here is a row you can add back in seconds, and this one has
 * no copy anywhere.
 *
 * The pointer at Backups is deliberate and is not a nag — it is the one action
 * that would make this reversible, and the moment to mention it is now.
 */
export function RebuildModal({
  database,
  kind,
  open,
  onOpenChange,
  rebuild,
}: {
  database: Database;
  kind: DatabaseKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rebuild: () => Promise<unknown>;
}) {
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const descriptor = DATABASE_KIND[kind];
  const confirmed = typed.trim() === database.name;
  const volume = `${database.appName}-data`;

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (!confirmed || running) return;
    setRefusal(null);
    setRunning(true);
    try {
      await rebuild();
      toast.done(`${database.name} was rebuilt from an empty volume.`);
      onOpenChange(false);
    } catch (error) {
      setRefusal(wasRefused(error) ? errorMessage(error) : DID_NOT_COME_BACK);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setTyped("");
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={`Rebuild ${database.name}`}
        description="This deletes everything in the database. It cannot be undone."
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-bad">
            Rebuilding drops the Swarm service <em>and its data volume</em>, then
            deploys {descriptor.label} again from the image. Every table, key and
            document in it is gone, and nothing on this platform keeps a copy —
            a Deployment replaces the container and leaves the volume alone, so
            this is the only action here that reaches the data.
          </p>

          <KVList>
            <KVRow label="Volume deleted" value={volume} title={volume} mono />
            <KVRow
              label="Image redeployed"
              value={database.dockerImage}
              title={database.dockerImage}
              mono
            />
            <KVRow
              label="Kept"
              value="The row, its credentials, its variables and its published port"
            />
          </KVList>

          {descriptor.backup ? (
            <p className="text-meta text-tx-2">
              If there is a dump of this database in a destination, the Backups
              tab can restore it afterwards. If there is not, this is the moment
              to stop and take one.
            </p>
          ) : (
            // Redis has no dump command at all, so "take a backup first" would
            // be advice this product cannot act on.
            <p className="text-meta text-tx-2">
              Cloudgate cannot dump {descriptor.label}, so there is nothing to
              restore from afterwards — see the Backups tab.
            </p>
          )}

          <Field
            name="confirm"
            label={`Type ${database.name} to confirm`}
            error={
              typed !== "" && !confirmed
                ? "That does not match the database's name."
                : undefined
            }
          >
            <Input
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
          <FormError message={refusal ?? undefined} />
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="submit"
            variant="dngr"
            disabled={!confirmed || running}
            aria-busy={running || undefined}
          >
            Rebuild and delete the data
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
