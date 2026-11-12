import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormProvider } from "react-hook-form";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { ResourceField } from "@/components/console/resource-field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import type { DeployTarget } from "@/lib/api/endpoints/environments";
import { useServers } from "@/lib/api/use-servers";
import {
  CLOUD_TARGET_HINT,
  useCreateServerPicker,
} from "@/lib/forms/create-server-picker";

import {
  BLANK_APPLICATION,
  createApplicationSchema,
  toCreateApplicationInput,
  type CreateApplicationValues,
} from "./create-application-values";
import { useCreateApplication } from "./use-create-application";
import { example } from "@/components/console/form-spec";

/**
 * Add an Application to an Environment.
 *
 * **The fourth button in a header that had three, and the missing one was the
 * kind the screen names first.** F08 shipped the Environment's Services tab with
 * no create action at all; F11 and F12 added databases and Compose stacks on the
 * argument that `POST /:kind` and `POST /compose` answer with the new row, so
 * creating something ends on its own screen rather than on a list; F15 added the
 * AI draft on the same argument. F09 shipped the Application screens and said in
 * its own panel comment that Applications were still missing a create flow. The
 * consequence was that the one kind the empty state names first was the one kind
 * the buttons above could not make, and an operator's only way past it was
 * `POST /applications` by hand.
 *
 * `POST /applications` answers with the row, so this ends where its siblings do:
 * on the new Application's own Overview, with F07's rail recording it in Recents
 * on the way.
 *
 * **Three fields, and the interesting decision is what is not here.**
 * `createApplicationSchema` takes `name`, `appName`, `description`,
 * `environmentId` and `serverId` and nothing else — every other column on the
 * row is configured through `PATCH`. Two of those five are deliberately not
 * asked:
 *
 * - **`appName`**, because the backend generates one and it is immutable: it
 *   names the container, its volumes and its Traefik router. A field whose bad
 *   answer cannot be taken back does not belong in the dialog that creates the
 *   thing, and the Name hint says a generated one exists.
 * - **the source.** `sourceType` defaults to `github`, and F12's Compose modal
 *   does ask about that default — but a stack's whole subject is where its file
 *   comes from, and it has two answers. An Application's source is seven-way,
 *   five of the seven have their own form behind them, and `source-card.tsx`
 *   already is that flow, reachable the moment this lands on the Overview. So
 *   this stays a single call with no follow-up `PATCH`, the way the database
 *   modal is, and the toast names the source as the next step.
 *
 * **The Server picker opens on the Environment's Deploy target**
 * It opened on
 * this Cloudgate host whatever the target said, so an operator who had set the
 * Environment to a Server got Applications on the platform host unless they
 * noticed the picker. A Cloud account target opens on nothing chosen: only a
 * plan creates in a Cloud account (ADR-0035), so a console create runs on a
 * Server or this Cloudgate host, and the creator picks which
 * On the
 * Hosted instance this Cloudgate host is not offered at all
 * so a
 * platform-host or Cloud account target opens on nothing chosen.
 */
export function CreateApplicationModal({
  environmentId,
  environmentName,
  deployTarget,
  open,
  onOpenChange,
}: {
  environmentId: string;
  environmentName: string;
  deployTarget: DeployTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} wide>
      <Modal.Header
        title="Add an Application"
        description={`One service built from your own code and deployed into ${environmentName}.`}
      />
      {/* The form lives in the child so that it is mounted with the dialog and
          torn down with it: `useApiForm` reads `defaultValues` once, so a form
          held in this component would reopen holding whatever was typed into
          the attempt before — the same reason the database flow keys its
          details step per engine. */}
      <Details
        environmentId={environmentId}
        deployTarget={deployTarget}
        onDone={() => onOpenChange(false)}
      />
    </Modal>
  );
}

function Details({
  environmentId,
  deployTarget,
  onDone,
}: {
  environmentId: string;
  deployTarget: DeployTarget;
  onDone: () => void;
}) {
  const router = useRouter();
  const create = useCreateApplication(environmentId);
  const servers = useServers();
  const picker = useCreateServerPicker(deployTarget);
  const [serverId, setServerId] = useState(
    deployTarget.kind === "server" ? deployTarget.serverId : "",
  );

  const form = useApiForm<CreateApplicationValues>({
    schema: createApplicationSchema,
    defaultValues: BLANK_APPLICATION,
    onSubmit: async (values) => {
      const row = await create.mutateAsync(
        toCreateApplicationInput(
          values,
          environmentId,
          picker.serverIdOf(serverId),
        ),
      );

      toast.done(`${values.name.trim()} created.`, {
        description:
          "It is not deployed yet — set where its code comes from, then deploy.",
      });
      onDone();
      router.push(`/applications/${row.applicationId}`);
    },
    onError: (error) => toast.error(error),
  });

  const values = form.watch();

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit}>
        <Modal.Body>
          <ResourceField
            spec={{
              kind: "text",
              name: "name",
              label: "Name",
              placeholder: example("Storefront web"),
              hint: "What this Application is called in Cloudgate. Its Swarm service gets its own generated name, which cannot be changed.",
            }}
            values={values}
          />

          <ResourceField
            spec={{
              kind: "text",
              name: "description",
              label: "Description",
              optional: true,
              placeholder: example("The customer-facing storefront"),
              hint: "What this Application runs, for whoever finds it next.",
            }}
            values={values}
          />

          <Field
            name="serverId"
            label="Server"
            manual
            optional={picker.optional}
            hint={serverHint(deployTarget, picker.platformHost)}
          >
            <Picker
              options={picker.options(servers.data)}
              pending={servers.isPending}
              placeholder={picker.placeholder}
              value={serverId}
              onValueChange={setServerId}
            />
          </Field>

          <FormError message={form.rootError} />
        </Modal.Body>

        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <SubmitButton pending={form.formState.isSubmitting}>
            Create Application
          </SubmitButton>
        </Modal.Footer>
      </form>
    </FormProvider>
  );
}

/** What the Server picker's hint says, by where the Environment deploys. */
function serverHint(target: DeployTarget, platformHost: boolean): string {
  // On the Hosted instance the host is no choice (ADR-0053).
  if (!platformHost && target.kind !== "server") {
    return "Which of your Servers it runs on.";
  }
  switch (target.kind) {
    case "server":
      return "Which Server it runs on. It starts on this Environment's Deploy target.";
    case "cloud":
      return `Which Server it runs on. ${CLOUD_TARGET_HINT}`;
    default:
      return "Which Server it runs on. It starts on this Environment's Deploy target, this Cloudgate host.";
  }
}
