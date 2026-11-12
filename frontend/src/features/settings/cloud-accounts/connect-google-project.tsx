import { useState } from "react";
import { z } from "zod";

import { CopyButton } from "@/components/console/copy-button";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { schemaIssues } from "@/components/console/schema-issues";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import type { GoogleCloudAccountSetup } from "@/lib/api/endpoints/cloud-accounts";

import { downloadGoogleSetup } from "./download-template";
import {
  useConnectCloudAccount,
  useGoogleCloudAccountSetup,
} from "./use-cloud-accounts";

/** A Google Cloud project id: 6–30 lowercase letters, digits and hyphens. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Each step's fields, said under the field with submit on. */
const accountSchema = z.object({
  name: z.string().trim().min(1, "Name this Cloud account."),
  cloudId: z
    .string()
    .trim()
    .regex(
      PROJECT_ID,
      "A project id is 6 to 30 lower case letters, digits and dashes, starting with a letter.",
    ),
});
const credentialsSchema = z.object({
  workloadIdentityProvider: z
    .string()
    .trim()
    .min(1, "Enter the workload identity provider the script printed."),
  deployServiceAccount: z
    .string()
    .trim()
    .min(1, "Enter the deploy service account."),
});

/**
 * Connect a Google Cloud project (slice 6), in the two steps the
 * backend's order forces, as the AWS dialog does.
 *
 * **The script comes first because the key does not exist anywhere else.**
 * Cloudgate makes the Cloud account's key pair when the setup is asked for,
 * and the script uploads its public half to the provider it makes, so the
 * dialog asks for the project id, hands out the script — with the JWKS and
 * the role as files — and only then asks for what the script printed.
 * Nothing is saved until the connect check passes; a refusal stays in the
 * dialog naming what to fix, every value kept. Back keeps the setup's token,
 * so asking again keeps the key the operator may already have uploaded.
 *
 * **"A project of its own"** is said where the script is handed out: each
 * Service has a service account of its own, so Cloudgate can act as any
 * service account in the project.
 */
export function ConnectGoogleProject({
  chooser,
  name,
  onNameChange,
  onStepChange,
  onConnected,
}: {
  /** The cloud chooser, shown on the first step. */
  chooser: React.ReactNode;
  name: string;
  onNameChange: (name: string) => void;
  onStepChange: (step: "account" | "credentials") => void;
  onConnected: () => void;
}) {
  const setup = useGoogleCloudAccountSetup();
  const connect = useConnectCloudAccount();
  const [projectId, setProjectId] = useState("");
  const [answer, setAnswer] = useState<GoogleCloudAccountSetup | null>(null);
  const [step, setStep] = useState<"account" | "credentials">("account");
  const [provider, setProvider] = useState("");
  const [serviceAccount, setServiceAccount] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  function go(next: "account" | "credentials") {
    setStep(next);
    onStepChange(next);
  }

  async function getScript(event: React.SubmitEvent) {
    event.preventDefault();
    if (setup.isPending) return;
    const invalid = schemaIssues(accountSchema, { name, cloudId: projectId });
    setIssues(invalid ?? {});
    if (invalid) return;
    setRefusal(null);
    try {
      const given = await setup.mutateAsync({
        cloudId: projectId.trim(),
        setupToken: answer?.setupToken,
      });
      setAnswer(given);
      setServiceAccount(given.template.names.serviceAccountEmail);
      go("credentials");
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (!answer || connect.isPending) return;
    const invalid = schemaIssues(credentialsSchema, {
      workloadIdentityProvider: provider,
      deployServiceAccount: serviceAccount,
    });
    setIssues(invalid ?? {});
    if (invalid) return;
    setRefusal(null);
    try {
      await connect.mutateAsync({
        cloud: "gcp",
        setupToken: answer.setupToken,
        name: name.trim(),
        cloudId: projectId.trim(),
        workloadIdentityProvider: provider.trim(),
        deployServiceAccount: serviceAccount.trim(),
      });
      onConnected();
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  if (!answer || step === "account") {
    return (
      <form method="post" noValidate onSubmit={getScript}>
        <Modal.Body>
          {chooser}
          <Field
            name="name"
            error={issues.name}
            label="Name"
            hint="What this Cloud account is called in Cloudgate, such as “Production Google”."
          >
            <Input
              value={name}
              autoComplete="off"
              onChange={(event) => onNameChange(event.target.value)}
            />
          </Field>
          <Field
            name="cloudId"
            error={issues.cloudId}
            label="Project id"
            hint="The project's id, not its name or number. It cannot be changed later."
          >
            <Input
              value={projectId}
              autoComplete="off"
              className="font-mono"
              placeholder="my-project-123"
              onChange={(event) => setProjectId(event.target.value)}
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
            Get the setup script
          </Button>
        </Modal.Footer>
      </form>
    );
  }

  const { template } = answer;
  return (
    <form method="post" noValidate onSubmit={submit}>
      <Modal.Body>
        <p className="rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta text-tx">
          Cloudgate can act as any service account in this project, because each
          Service gets a service account of its own. Use a project of its own,
          with nothing else in it.
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-meta text-tx-2">
          <li>
            Open Cloud Shell in project{" "}
            <span className="font-mono text-tx">{projectId.trim()}</span> and
            run the setup script. It turns on the APIs Cloudgate uses, makes a
            workload identity pool and provider that trust this Cloud account’s
            key, the custom role at version {template.policyVersion}, and a
            deploy service account holding it.
          </li>
          <li>
            Enter the provider and the service account the script prints at its
            end.
          </li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() =>
              downloadGoogleSetup(answer.cloudAccountId, template, "script")
            }
          >
            Download the setup script
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              downloadGoogleSetup(answer.cloudAccountId, template, "jwks")
            }
          >
            Download the JWKS
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              downloadGoogleSetup(answer.cloudAccountId, template, "role")
            }
          >
            Download the role
          </Button>
          <CopyButton value={template.script} label="setup script" />
        </div>
        <div className="flex items-center gap-2 text-meta text-tx-2">
          <span>Key id</span>
          <span className="font-mono text-tx wrap-anywhere">
            {answer.signingKeyId}
          </span>
        </div>
        <Field
          name="workloadIdentityProvider"
          error={issues.workloadIdentityProvider}
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
        <Field
          name="deployServiceAccount"
          label="Deploy service account"
          error={issues.deployServiceAccount}
        >
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
        <Button
          type="button"
          onClick={() => {
            setRefusal(null);
            setIssues({});
            go("account");
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
          {connect.isPending ? "Checking the project…" : "Check and connect"}
        </Button>
      </Modal.Footer>
    </form>
  );
}
