import { useState } from "react";

import { FormError } from "@/components/console/field";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Rollback } from "@/lib/api/endpoints/rollbacks";
import { errorMessage } from "@/lib/api/error-message";

/**
 * What rolling a `static` site on AWS back does, in the words of the static-site
 * spec ("Rollback"): its files come back, never the distribution's settings.
 */
export const STATIC_ROLLBACK_RESTORES =
  "Rolling back restores this version's files. The distribution's settings stay as the Project config says.";

/** Where a point's files are in the site's bucket. */
export function pointFolder(rollback: Rollback): string {
  return `deployments/${rollback.folder ?? ""}/`;
}

/**
 * Roll a `static` site on AWS back to a rollback point.
 *
 * Unlike a Server's rollback (`rollback-modal.tsx`) this **is a Deployment**:
 * `POST /rollbacks/:id/rollback` answers its id, and it waits in the
 * Service's own queue behind any push, then switches CloudFront back to the
 * point's folder, clears the cache and waits for both, with its own log on
 * the Deployments tab. Nothing is built or uploaded, and only the files come
 * back: the distribution keeps what the Project config says.
 */
export function StaticRollbackModal({
  rollback,
  applicationName,
  open,
  onOpenChange,
  run,
}: {
  rollback: Rollback | null;
  applicationName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: (rollbackId: string) => Promise<unknown>;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!rollback) return null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={`Roll ${applicationName} back to v${rollback.version}?`}
        description={STATIC_ROLLBACK_RESTORES}
      />
      <Modal.Body>
        <KVList>
          <KVRow label="Files" value={pointFolder(rollback)} mono />
          <KVRow
            label="Captured"
            value={new Date(rollback.createdAt).toLocaleString()}
          />
        </KVList>
        <p className="text-body text-tx-2">
          This runs as a{" "}
          <strong className="font-medium text-tx">Deployment</strong> of the
          site, after any push already queued: CloudFront is switched back to
          these files, its cache is cleared, and the Deployment ends once both
          have spread. Follow it on the Deployments tab. Nothing is built or
          uploaded.
        </p>
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Cancel</Button>} />
        <Button
          type="button"
          variant="pri"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={async () => {
            setRefusal(null);
            setPending(true);
            try {
              await run(rollback.rollbackId);
              toast.done(`Rolling back to v${rollback.version}.`, {
                description:
                  "Its Deployment is queued; follow it on the Deployments tab.",
              });
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            } finally {
              setPending(false);
            }
          }}
        >
          Restore v{rollback.version}&rsquo;s files
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * Delete a `static` site on AWS's rollback point: its folder goes
 * from the bucket with it, unless the site serves those files now, when the
 * next Deployment removes them. A folder that cannot be deleted keeps the
 * point, and the refusal says so.
 */
export function DeleteStaticRollbackModal({
  rollback,
  open,
  onOpenChange,
  remove,
}: {
  rollback: Rollback | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: (rollbackId: string) => Promise<unknown>;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!rollback) return null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={`Delete the v${rollback.version} rollback point?`}
        description="This deletes its files from the site's bucket, not just the row."
      />
      <Modal.Body>
        <p className="text-body text-tx-2">
          <strong className="font-medium text-tx">
            You will not be able to roll back to this version again.
          </strong>{" "}
          The folder{" "}
          <span className="font-mono text-meta wrap-anywhere">
            {pointFolder(rollback)}
          </span>{" "}
          is deleted. If the site serves these files now, they stay until the
          next Deployment switches away from them.
        </p>
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Keep it</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={async () => {
            setRefusal(null);
            setPending(true);
            try {
              await remove(rollback.rollbackId);
              toast.done(`v${rollback.version} deleted.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            } finally {
              setPending(false);
            }
          }}
        >
          Delete the files
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
