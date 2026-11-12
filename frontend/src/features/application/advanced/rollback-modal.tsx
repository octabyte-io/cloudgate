import { useState } from "react";

import { Chip } from "@/components/console/chip";
import { FormError } from "@/components/console/field";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Rollback } from "@/lib/api/endpoints/rollbacks";
import { errorMessage } from "@/lib/api/error-message";

/**
 * Roll back to a snapshot — **saying exactly what will happen before it
 * happens**, which is the one thing F10's brief asks of this screen.
 *
 * Five facts, and each is one an operator would otherwise find out afterwards:
 *
 * 1. **Nothing is built.** `rollbacks.service.ts` calls
 *    `mechanizeDockerContainer` with the snapshot's image directly. No clone, no
 *    builder, no queue — the Swarm service is updated to an image that already
 *    exists on the Server, which is why this is seconds rather than minutes.
 * 2. **It produces no Deployment.** Nothing writes a `deployment` row, so this
 *    will not appear on the Deployments tab and there is no log to open. The
 *    Application's own status does not move either.
 * 3. **The variables are today's, not the snapshot's.** `fullContext` excludes
 *    `env`, `buildArgs`, `buildSecrets`, the preview equivalents and every
 *    credential — the id columns included — by design
 *    (`rollback.schema.ts`), and the rollback re-reads them from the live row.
 *    So this restores the **image and its spec** — an Application whose
 *    `DATABASE_URL` changed since will come back pointing at the new one.
 * 4. **It is not a new snapshot.** Rolling back does not capture the version it
 *    replaced, so going forward again means deploying again.
 * 5. **The next Deployment builds from today's settings.** Rolling back leaves
 *    the Application row as it is (CONTEXT.md, "Rollback"), so a redeploy or
 *    an auto-deploy brings the newer `dockerImage` or branch straight back.
 *    Found the first time it happened, as a bug (#1416); the dialog says it
 *    and points at the source, the setting to change to stay put.
 */
export function RollbackModal({
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
  const context = rollback.fullContext ?? {};

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
        description="The running service is updated to this snapshot's image. Nothing is rebuilt."
      />
      <Modal.Body>
        <KVList>
          <KVRow
            label="Image"
            value={rollback.image ?? ""}
            title={rollback.image ?? undefined}
            mono
          />
          {typeof context.branch === "string" ? (
            <KVRow label="Branch" value={context.branch} mono />
          ) : null}
          {typeof context.buildType === "string" ? (
            <KVRow label="Built with" value={<Chip>{context.buildType}</Chip>} />
          ) : null}
          <KVRow label="Captured" value={new Date(rollback.createdAt).toLocaleString()} />
        </KVList>

        <p className="text-body text-tx-2">
          The Swarm service is updated in place, so this takes seconds rather than
          a build. It writes <strong className="font-medium text-tx">no
          Deployment</strong>, which means it will not appear on the Deployments
          tab and there is no log to follow.
        </p>
        <p className="text-body text-tx-2">
          Variables are <strong className="font-medium text-tx">not</strong> rolled
          back. A snapshot deliberately holds no secrets, so this Application keeps
          the environment, build arguments and credentials it has now — only the
          image and its service spec go back.
        </p>
        <p className="text-body text-tx-2">
          This Application&rsquo;s settings are not changed, so the next
          Deployment builds from them as they are now: to stay on v
          {rollback.version}, change its source first.
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
              toast.done(`Rolled back to v${rollback.version}.`, {
                description: "The Swarm service is updating to that image now.",
              });
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            } finally {
              setPending(false);
            }
          }}
        >
          Roll back to v{rollback.version}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
