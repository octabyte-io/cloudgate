import { useState } from "react";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import type {
  GcpCloudAccount,
  UpdateGoogleCloudAccountInput,
} from "@/lib/api/endpoints/cloud-accounts";

import { useUpdateCloudAccount } from "./use-cloud-accounts";

/**
 * Edit a connected Google Cloud account, by the AWS dialog's
 * rules: only what changed is sent, and the backend keeps the rest.
 *
 * **A changed provider or service account is checked before it is saved.**
 * The backend reruns the connect check, signed with the key that signs
 * today, and saves nothing if it fails; the refusal stays in the dialog with
 * every value kept. The project, its number, the key and the issuer never
 * change here, so they are shown, not edited — the key changes through
 * "New key".
 */
export function EditGoogleCloudAccountModal({
  account,
  onClose,
}: {
  account: GcpCloudAccount;
  onClose: () => void;
}) {
  const update = useUpdateCloudAccount(account.cloudAccountId);
  const [name, setName] = useState(account.name);
  const [provider, setProvider] = useState(account.workloadIdentityProvider);
  const [serviceAccount, setServiceAccount] = useState(
    account.deployServiceAccount,
  );
  const [refusal, setRefusal] = useState<string | null>(null);

  const changes: UpdateGoogleCloudAccountInput = { cloud: "gcp" };
  if (name.trim() !== account.name) changes.name = name.trim();
  if (provider.trim() !== account.workloadIdentityProvider) {
    changes.workloadIdentityProvider = provider.trim();
  }
  if (serviceAccount.trim() !== account.deployServiceAccount) {
    changes.deployServiceAccount = serviceAccount.trim();
  }
  const changed = Object.keys(changes).length > 1;
  const checks =
    changes.workloadIdentityProvider !== undefined ||
    changes.deployServiceAccount !== undefined;
  const blank =
    name.trim() === "" ||
    provider.trim() === "" ||
    serviceAccount.trim() === "";

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (update.isPending || !changed) return;
    setRefusal(null);
    try {
      await update.mutateAsync(changes);
      onClose();
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  return (
    <Modal open onOpenChange={(next) => !next && onClose()} keepOpen={checks}>
      <Modal.Header
        title={`Edit ${account.name}`}
        description="A changed provider or service account is checked against Google Cloud first; nothing is saved unless the check passes."
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta text-tx-2">
            <dt>Project</dt>
            <dd className="font-mono text-tx">{account.cloudId}</dd>
            <dt>Project number</dt>
            <dd className="font-mono text-tx">{account.projectNumber}</dd>
            <dt>Key id</dt>
            <dd className="font-mono text-tx wrap-anywhere">
              {account.signingKeyId}
            </dd>
            <dt>Issuer</dt>
            <dd className="font-mono text-tx wrap-anywhere">
              {account.tokenIssuer}
            </dd>
          </dl>
          <Field name="name" label="Name">
            <Input
              value={name}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            name="workloadIdentityProvider"
            label="Workload identity provider"
            hint="projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>"
          >
            <Input
              value={provider}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => setProvider(event.target.value)}
            />
          </Field>
          <Field name="deployServiceAccount" label="Deploy service account">
            <Input
              value={serviceAccount}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => setServiceAccount(event.target.value)}
            />
          </Field>
          <FormError message={refusal ?? undefined} />
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="submit"
            variant="pri"
            disabled={blank || !changed || update.isPending}
            aria-busy={update.isPending || undefined}
          >
            {update.isPending
              ? "Checking the project…"
              : checks
                ? "Check and save"
                : "Save"}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
