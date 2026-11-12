import { useRouter } from "next/navigation";
import { FormProvider } from "react-hook-form";

import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import { useSshKeys } from "@/lib/api/use-ssh-keys";
import { usePermission } from "@/lib/auth/use-permission";

import { AddServerFields } from "../server/fleet/add-server-fields";
import {
  addServerSchema,
  type AddServerValues,
} from "../server/fleet/add-server-values";
import { SshKeyChoice } from "../server/fleet/ssh-key-choice";
import { useCreateServer } from "../server/use-server";
import { useCreateSshKey } from "../ssh-keys/use-ssh-keys";
import { wizardHref } from "./wizard-state";

/**
 * The own server's address and key: Add a Server's own fields and rules
 * (`features/server/fleet/`), on the page rather than in a dialog.
 *
 * **The key is the step a newcomer gets stuck on**, so it is made for them:
 * with no key in the Organization, one press makes one, and either way the
 * chosen key's public line is shown with the one command that puts it on
 * the server. Saving records the Server and touches nothing on the machine;
 * the next step connects to it.
 */
export function OwnServerForm({ template }: { template: TemplateSummary }) {
  const router = useRouter();
  const create = useCreateServer();
  const sshKeys = useSshKeys();
  const makeKey = useCreateSshKey();
  const canAdd = usePermission({ server: ["create"] });
  const canMakeKey = usePermission({ sshKeys: ["create"] });

  const form = useApiForm<AddServerValues>({
    schema: addServerSchema,
    defaultValues: {
      name: `${template.name} server`,
      description: "",
      ipAddress: "",
      port: 22,
      username: "root",
      sshKeyId: "",
    },
    onSubmit: async (values) => {
      const row = await create.mutateAsync({
        name: values.name,
        description: values.description || undefined,
        ipAddress: values.ipAddress,
        port: values.port,
        username: values.username,
        sshKeyId: values.sshKeyId,
        serverType: "deploy",
      });
      router.replace(
        wizardHref({
          templateId: template.id,
          path: "own",
          serverId: row.serverId,
        }),
      );
    },
  });

  const keys = sshKeys.data ?? [];
  const noKeys = !sshKeys.isPending && !sshKeys.error && keys.length === 0;
  const chosen = keys.find((key) => key.sshKeyId === form.watch("sshKeyId"));

  return (
    <Card className="animate-fade">
      <Card.Header
        title="Your server"
        sub="Where it is, and how Cloudgate signs in to it."
        headingLevel={2}
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Card.Body className="grid gap-4">
            <AddServerFields />

            {noKeys ? (
              <div className="grid justify-items-start gap-2 rounded-lg border border-info-line bg-info-tint p-3">
                <p className="text-body text-tx">
                  Cloudgate signs in to your server with a key. Make one here,
                  then add it to your server.
                </p>
                <SubmitButton
                  type="button"
                  variant="gh"
                  size="sm"
                  pending={makeKey.isPending}
                  disabled={!canMakeKey.allowed}
                  onClick={() =>
                    makeKey.mutate(
                      { name: `${template.name} server key`, type: "ed25519" },
                      {
                        onSuccess: (key) =>
                          form.setValue("sshKeyId", key.sshKeyId, {
                            shouldValidate: true,
                          }),
                      },
                    )
                  }
                >
                  Make a key
                </SubmitButton>
                {makeKey.error ? (
                  <p role="alert" className="text-meta text-bad">
                    {errorMessage(makeKey.error)}
                  </p>
                ) : null}
              </div>
            ) : (
              <SshKeyChoice sshKeys={sshKeys} onManageKeys={() => undefined} />
            )}

            {chosen ? (
              <KeyLine
                publicKey={chosen.publicKey}
                user={form.watch("username") || "root"}
              />
            ) : null}

            <FormError message={form.rootError} />
          </Card.Body>
          <Card.Footer>
            <SubmitButton
              pending={form.formState.isSubmitting}
              disabled={!chosen || !canAdd.allowed}
            >
              Save and continue
            </SubmitButton>
          </Card.Footer>
        </form>
      </FormProvider>
    </Card>
  );
}

/**
 * The one line that lets Cloudgate in: run on the server, it appends the
 * key's public half to the signing-in user's `authorized_keys`. The user is
 * named, not pointed at: on the connect step there is no form above it.
 */
export function KeyLine({
  publicKey,
  user,
}: {
  publicKey: string;
  user: string;
}) {
  const command = `mkdir -p ~/.ssh && echo "${publicKey.trim()}" >> ~/.ssh/authorized_keys`;
  return (
    <div className="grid gap-1.5">
      <p className="text-body text-tx">
        Run this once on your server, signed in as{" "}
        <span className="font-mono">{user}</span>:
      </p>
      <div className="flex items-start gap-2 rounded-md border border-line bg-panel-2 p-2.5">
        <code className="min-w-0 flex-1 font-mono text-meta wrap-anywhere text-tx">
          {command}
        </code>
        <CopyButton value={command} label="command" />
      </div>
    </div>
  );
}
