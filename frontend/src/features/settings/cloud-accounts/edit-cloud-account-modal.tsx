import { useState } from "react";

import { CopyButton } from "@/components/console/copy-button";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { PasswordInput } from "@/components/console/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import type {
  AwsCloudAccount,
  UpdateCloudAccountInput,
} from "@/lib/api/endpoints/cloud-accounts";

import { useUpdateCloudAccount } from "./use-cloud-accounts";

/**
 * Edit a connected Cloud account, in a way that cannot break it.
 *
 * **Only what changed is sent.** The backend keeps every field left out, so
 * the secret access key is an empty box saying one is stored, and leaving it
 * empty keeps it (ADR-0019) — the console never holds the secret to send back.
 *
 * **A changed key or role ARN is checked before it is saved.** The backend
 * reruns the connect check with the new values and saves nothing if it fails;
 * the refusal stays in the dialog, each denied action named, with every value
 * kept so a fixed role is one click away. The AWS account id and the external
 * id never change, so they are shown, not edited.
 */
export function EditCloudAccountModal({
  account,
  onClose,
}: {
  account: AwsCloudAccount;
  onClose: () => void;
}) {
  const update = useUpdateCloudAccount(account.cloudAccountId);
  const [name, setName] = useState(account.name);
  const [accessKeyId, setAccessKeyId] = useState(account.accessKeyId);
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [deployRoleArn, setDeployRoleArn] = useState(account.deployRoleArn);
  const [taskExecutionRoleArn, setTaskExecutionRoleArn] = useState(
    account.taskExecutionRoleArn,
  );
  const [refusal, setRefusal] = useState<string | null>(null);

  const changes: UpdateCloudAccountInput = {};
  if (name.trim() !== account.name) changes.name = name.trim();
  if (accessKeyId.trim() !== account.accessKeyId) {
    changes.accessKeyId = accessKeyId.trim();
  }
  if (secretAccessKey !== "") changes.secretAccessKey = secretAccessKey;
  if (deployRoleArn.trim() !== account.deployRoleArn) {
    changes.deployRoleArn = deployRoleArn.trim();
  }
  if (taskExecutionRoleArn.trim() !== account.taskExecutionRoleArn) {
    changes.taskExecutionRoleArn = taskExecutionRoleArn.trim();
  }
  const checks =
    changes.accessKeyId !== undefined ||
    changes.secretAccessKey !== undefined ||
    changes.deployRoleArn !== undefined ||
    changes.taskExecutionRoleArn !== undefined;
  const blank =
    name.trim() === "" ||
    accessKeyId.trim() === "" ||
    deployRoleArn.trim() === "" ||
    taskExecutionRoleArn.trim() === "";

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (update.isPending || Object.keys(changes).length === 0) return;
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
        description="A changed key or role ARN is checked against AWS first; nothing is saved unless the check passes."
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta text-tx-2">
            <dt>AWS account</dt>
            <dd className="font-mono text-tx">{account.cloudId}</dd>
            <dt>External id</dt>
            <dd className="flex items-center gap-2">
              <span className="font-mono text-tx wrap-anywhere">
                {account.externalId}
              </span>
              <CopyButton value={account.externalId} label="external id" />
            </dd>
          </dl>
          <Field name="name" label="Name">
            <Input
              value={name}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field name="accessKeyId" label="Access key id">
            <Input
              value={accessKeyId}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => setAccessKeyId(event.target.value)}
            />
          </Field>
          <Field
            name="secretAccessKey"
            label="Secret access key"
            hint="One is stored. Leave this empty to keep it; a new key needs its new secret."
          >
            <PasswordInput
              value={secretAccessKey}
              autoComplete="off"
              placeholder="Stored — leave empty to keep"
              onChange={(event) => setSecretAccessKey(event.target.value)}
            />
          </Field>
          <Field name="deployRoleArn" label="Deploy role ARN">
            <Input
              value={deployRoleArn}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => setDeployRoleArn(event.target.value)}
            />
          </Field>
          <Field name="taskExecutionRoleArn" label="Task execution role ARN">
            <Input
              value={taskExecutionRoleArn}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => setTaskExecutionRoleArn(event.target.value)}
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
            disabled={
              blank || Object.keys(changes).length === 0 || update.isPending
            }
            aria-busy={update.isPending || undefined}
          >
            {update.isPending
              ? "Checking the role…"
              : checks
                ? "Check and save"
                : "Save"}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
