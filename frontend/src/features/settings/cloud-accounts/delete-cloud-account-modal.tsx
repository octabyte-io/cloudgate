import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { CloudAccount } from "@/lib/api/endpoints/cloud-accounts";

import { useDeleteCloudAccount } from "./use-cloud-accounts";
import { cloudName } from "@/lib/api/endpoints/cloud-accounts";

/**
 * Delete a Cloud account: Cloudgate's row, and nothing in the cloud.
 *
 * **The answer is the point.** Cloudgate never made the IAM user, its key or
 * the roles — nor, on Google Cloud, the pool, provider, role and service
 * account — the operator did, from the template or script, so it does not
 * remove them, and the backend's answer names each one. The dialog says so before
 * the click and shows that answer after it, in place, rather than in a toast
 * that is gone before the ARNs can be copied.
 *
 * There is no force: a Cloud account something still uses is refused, and the
 * refusal, naming what uses it, stays in the dialog.
 */
export function DeleteCloudAccountModal({
  account,
  onClose,
}: {
  account: CloudAccount;
  onClose: () => void;
}) {
  const remove = useDeleteCloudAccount();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);

  return (
    <Modal open onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={
          removed ? `${account.name} is removed` : `Delete ${account.name}?`
        }
        description={
          removed
            ? `Nothing was removed in ${cloudName(account.cloud)}.`
            : "This removes the Cloud account from Cloudgate only."
        }
      />
      <Modal.Body>
        {removed ? (
          <p className="text-body wrap-anywhere text-tx-2">{removed}</p>
        ) : account.cloud === "gcp" ? (
          <p className="text-body wrap-anywhere text-tx-2">
            Cloudgate forgets Google Cloud project{" "}
            <span className="font-mono text-tx">{account.cloudId}</span>. The
            workload identity pool and its provider, the custom role and the
            deploy service account{" "}
            <span className="font-mono text-tx">
              {account.deployServiceAccount}
            </span>{" "}
            stay in the project, and are yours to remove. Connecting this
            project again needs a new setup script.
          </p>
        ) : (
          <p className="text-body wrap-anywhere text-tx-2">
            Cloudgate forgets AWS account{" "}
            <span className="font-mono text-tx">{account.cloudId}</span>. The
            IAM user with access key{" "}
            <span className="font-mono text-tx">{account.accessKeyId}</span>,
            that key, the deploy role and the task execution role stay in AWS,
            and are yours to remove. Connecting this account again needs a new
            setup template.
          </p>
        )}
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        {removed ? (
          <Button type="button" variant="pri" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Modal.Close render={<Button type="button">Keep it</Button>} />
            <Button
              type="button"
              variant="dngr"
              disabled={remove.isPending}
              aria-busy={remove.isPending || undefined}
              onClick={async () => {
                setRefusal(null);
                try {
                  const answer = await remove.mutateAsync(
                    account.cloudAccountId,
                  );
                  setRemoved(answer.message);
                } catch (error) {
                  setRefusal(errorMessage(error));
                }
              }}
            >
              Delete Cloud account
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
