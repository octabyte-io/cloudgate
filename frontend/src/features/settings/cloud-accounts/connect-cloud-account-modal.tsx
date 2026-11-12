import { useState } from "react";
import { z } from "zod";

import { CopyButton } from "@/components/console/copy-button";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { PasswordInput } from "@/components/console/password-input";
import { schemaIssues } from "@/components/console/schema-issues";
import { Segmented } from "@/components/console/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import type { CloudAccountSetup } from "@/lib/api/endpoints/cloud-accounts";

import { ConnectGoogleProject } from "./connect-google-project";
import { downloadCloudFormation, downloadPlainJson } from "./download-template";
import {
  useCloudAccountSetup,
  useConnectCloudAccount,
} from "./use-cloud-accounts";
import { CLOUD_NAMES } from "@/lib/api/endpoints/cloud-accounts";

/**
 * Each step's empty and malformed fields, said under the field with submit on
 * rather than a submit held off with nothing saying why.
 */
const accountSchema = z.object({
  name: z.string().trim().min(1, "Name this Cloud account."),
  cloudId: z
    .string()
    .trim()
    .regex(/^\d{12}$/, "An AWS account id is 12 digits."),
});
const credentialsSchema = z.object({
  accessKeyId: z.string().trim().min(1, "Enter the access key id."),
  secretAccessKey: z.string().min(1, "Enter the secret access key."),
  deployRoleArn: z.string().trim().min(1, "Enter the deploy role ARN."),
  taskExecutionRoleArn: z
    .string()
    .trim()
    .min(1, "Enter the task execution role ARN."),
});

/**
 * Connect an AWS account, in the two steps the backend's order forces.
 *
 * **The template comes first because the role does not exist yet.** The
 * template carries this Cloud account's external id and tag value, which
 * Cloudgate makes and the operator cannot choose, so the dialog asks for the
 * account id, hands out the template, and only then asks for what the
 * operator made with it. Nothing is saved until the connect check passes, and
 * a refusal stays in the dialog naming what to fix — each denied action
 * included — with every value kept, so a fixed role is one click away.
 *
 * **The access key is made by hand**, never by the template: a key made by the
 * stack would sit in its outputs. The role ARNs are prefilled
 * with the names the template gives them.
 *
 * **A Google Cloud project** (slice 6) is the other choice of the cloud
 * chooser on the first step, and its own two steps are
 * {@link ConnectGoogleProject}'s. The name is kept across a change of cloud.
 */
export function ConnectCloudAccountModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setup = useCloudAccountSetup();
  const connect = useConnectCloudAccount();
  const [cloud, setCloud] = useState<"aws" | "gcp">("aws");
  const [googleStep, setGoogleStep] = useState<"account" | "credentials">(
    "account",
  );
  const [name, setName] = useState("");
  const [cloudId, setCloudId] = useState("");
  const [template, setTemplate] = useState<CloudAccountSetup | null>(null);
  // Back keeps `template`, so asking again reuses its token and external id.
  const [step, setStep] = useState<"account" | "credentials">("account");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [deployRoleArn, setDeployRoleArn] = useState("");
  const [taskExecutionRoleArn, setTaskExecutionRoleArn] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  async function getTemplate(event: React.SubmitEvent) {
    event.preventDefault();
    if (setup.isPending) return;
    const invalid = schemaIssues(accountSchema, { name, cloudId });
    setIssues(invalid ?? {});
    if (invalid) return;
    setRefusal(null);
    try {
      const answer = await setup.mutateAsync({
        cloudId: cloudId.trim(),
        setupToken: template?.setupToken,
      });
      setTemplate(answer);
      setStep("credentials");
      const prefix = `arn:aws:iam::${cloudId.trim()}:role/cloudgate-`;
      setDeployRoleArn(`${prefix}deploy-${answer.cloudAccountId}`);
      setTaskExecutionRoleArn(
        `${prefix}task-execution-${answer.cloudAccountId}`,
      );
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (!template || connect.isPending) return;
    const invalid = schemaIssues(credentialsSchema, {
      accessKeyId,
      secretAccessKey,
      deployRoleArn,
      taskExecutionRoleArn,
    });
    setIssues(invalid ?? {});
    if (invalid) return;
    setRefusal(null);
    try {
      await connect.mutateAsync({
        setupToken: template.setupToken,
        name: name.trim(),
        cloudId: cloudId.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey,
        deployRoleArn: deployRoleArn.trim(),
        taskExecutionRoleArn: taskExecutionRoleArn.trim(),
      });
      onOpenChange(false);
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  const chooser = (
    <Segmented
      label="Cloud"
      options={[
        { value: "aws", label: CLOUD_NAMES.aws },
        { value: "gcp", label: CLOUD_NAMES.gcp },
      ]}
      value={cloud}
      onChange={(next) => {
        setRefusal(null);
        setCloud(next);
      }}
    />
  );

  const accountStep = (
    <form method="post" noValidate onSubmit={getTemplate}>
      <Modal.Body>
        {chooser}
        <Field
          name="name"
          error={issues.name}
          label="Name"
          hint="What this Cloud account is called in Cloudgate, such as “Production AWS”."
        >
          <Input
            value={name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          name="cloudId"
          error={issues.cloudId}
          label="AWS account id"
          hint="The 12 digits in the AWS console's account menu. It cannot be changed later."
        >
          <Input
            value={cloudId}
            autoComplete="off"
            inputMode="numeric"
            className="font-mono"
            placeholder="123456789012"
            onChange={(event) => setCloudId(event.target.value)}
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
          disabled={setup.isPending}
          aria-busy={setup.isPending || undefined}
        >
          Get the setup template
        </Button>
      </Modal.Footer>
    </form>
  );

  const credentialStep =
    template && step === "credentials" ? (
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          <ol className="list-decimal space-y-1.5 pl-5 text-meta text-tx-2">
            <li>
              Create a CloudFormation stack in account{" "}
              <span className="font-mono text-tx">{cloudId.trim()}</span> from
              the template, or make the same roles and user by hand from the
              JSON. It makes the deploy role, the task execution role, a
              permissions boundary and an IAM user that can only take on the
              deploy role.
            </li>
            <li>
              In the IAM console, make an access key for that user. The template
              does not make it, so the secret never sits in the stack.
            </li>
            <li>Enter the key and the two role ARNs below.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                downloadCloudFormation(
                  template.cloudAccountId,
                  template.template,
                )
              }
            >
              Download CloudFormation template
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() =>
                downloadPlainJson(template.cloudAccountId, template.template)
              }
            >
              Download as plain JSON
            </Button>
          </div>
          <div className="flex items-center gap-2 text-meta text-tx-2">
            <span>External id</span>
            <span className="font-mono text-tx wrap-anywhere">
              {template.externalId}
            </span>
            <CopyButton value={template.externalId} label="external id" />
          </div>
          <Field
            name="accessKeyId"
            error={issues.accessKeyId}
            label="Access key id"
          >
            <Input
              value={accessKeyId}
              autoComplete="off"
              className="font-mono"
              placeholder="AKIA…"
              onChange={(event) => setAccessKeyId(event.target.value)}
            />
          </Field>
          <Field
            name="secretAccessKey"
            error={issues.secretAccessKey}
            label="Secret access key"
            hint="Stored encrypted and never shown again."
          >
            <PasswordInput
              value={secretAccessKey}
              autoComplete="off"
              onChange={(event) => setSecretAccessKey(event.target.value)}
            />
          </Field>
          <Field
            name="deployRoleArn"
            error={issues.deployRoleArn}
            label="Deploy role ARN"
          >
            <Input
              value={deployRoleArn}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => setDeployRoleArn(event.target.value)}
            />
          </Field>
          <Field
            name="taskExecutionRoleArn"
            error={issues.taskExecutionRoleArn}
            label="Task execution role ARN"
          >
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
          <Button
            type="button"
            onClick={() => {
              setRefusal(null);
              setIssues({});
              setStep("account");
            }}
          >
            Back
          </Button>
          <Modal.Gap />
          <Button
            type="submit"
            variant="pri"
            disabled={connect.isPending}
            aria-busy={connect.isPending || undefined}
          >
            {connect.isPending ? "Checking the role…" : "Check and connect"}
          </Button>
        </Modal.Footer>
      </form>
    ) : null;

  if (cloud === "gcp") {
    return (
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        keepOpen={googleStep === "credentials"}
      >
        <Modal.Header
          title="Connect a Google Cloud project"
          description={
            googleStep === "credentials"
              ? "Cloudgate checks the project fully, creating nothing, and saves the Cloud account only if every step passes."
              : "Cloudgate deploys as a service account in your project, which it reaches only with a key of this Cloud account's own."
          }
        />
        <ConnectGoogleProject
          chooser={chooser}
          name={name}
          onNameChange={setName}
          onStepChange={setGoogleStep}
          onConnected={() => onOpenChange(false)}
        />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      keepOpen={step === "credentials"}
    >
      <Modal.Header
        title="Connect an AWS account"
        description={
          step === "credentials"
            ? "Cloudgate checks the role fully, creating nothing, and saves the Cloud account only if every step passes."
            : "Cloudgate deploys through a role in your account that it can only take on with an id it makes."
        }
      />
      {credentialStep ?? accountStep}
    </Modal>
  );
}
