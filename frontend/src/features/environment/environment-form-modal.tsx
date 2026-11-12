import { useRouter } from "next/navigation";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { LinkButton } from "@/components/console/link-button";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Environment } from "@/lib/api/endpoints/environments";
import { useCloudAccounts } from "@/lib/api/use-cloud-accounts";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { useServers } from "@/lib/api/use-servers";
import { usePermission } from "@/lib/auth/use-permission";

import {
  CLOUDS,
  cloudAccountOf,
  cloudOf,
  deployServers,
  deployTargetOptions,
  fromPickerValue,
  regionOptions,
} from "./deploy-target";
import { useCreateEnvironment, useUpdateEnvironment } from "./use-environments";
import { example } from "@/components/console/form-spec";

const schema = z.object({
  name: z.string().trim().min(1, "An Environment needs a name."),
  description: z.string(),
  deployTarget: z.string(),
  region: z.string(),
});
type Values = z.infer<typeof schema>;

/**
 * Create an Environment, or rename one.
 *
 * The same two fields as the Project dialog beside it, against the same pair of
 * routes — `POST /environments` and `PATCH /environments/:id` take the identical
 * body bar `projectId` (`environments/dto/environment.dto.ts`).
 *
 * The description carries more weight here than one field up: "production" and
 * "staging" explain themselves, and `pr-482`, `blue` and `canary-eu` do not.
 *
 * `projectId` is not a field: an Environment does not move between Projects,
 * and `updateEnvironmentSchema` omits it deliberately.
 *
 * **A new Environment asks for its Deploy target only when there is a choice
 * to make**: with
 * no deploy Server in the organization the field is not shown and the API
 * takes the platform host, and with one the field is required, as
 * `POST /environments` requires it. A rename never shows it; the Settings
 * tab's own card changes it.
 *
 * **On the Hosted instance there is always a choice, and the platform host is not
 * one of them**
 * (ADR-0053): the field is shown on every create, offering the Organization's
 * deploy Servers and Cloud accounts (a Cloud account with its region), and
 * "This Cloudgate host" is left out rather than greyed. With nothing to point
 * at, the form says so and links to "Add a Server" and "Connect a Cloud
 * account" in place of the field, and does not submit.
 *
 * **A create lands on the new Environment; a rename stays where it was**
 * as the
 * Project dialog has: an empty Environment's next step is always to
 * add a service to it, and its first tab is where that is done.
 */
export function EnvironmentFormModal({
  projectId,
  environment,
  open,
  onOpenChange,
}: {
  projectId: string;
  /** The Environment being renamed, or `null` to create a new one. */
  environment: Environment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const create = useCreateEnvironment(projectId);
  const update = useUpdateEnvironment(environment?.environmentId ?? "", projectId);
  const editing = environment !== null;
  const servers = useServers();
  const hosted = useInstanceMode().data === "hosted";
  const canReadClouds = usePermission({ cloudAccount: ["read"] });
  const readsClouds = hosted && canReadClouds.allowed;
  const cloudAccounts = useCloudAccounts({
    enabled: !editing && readsClouds,
  });
  const askTarget =
    !editing && (hosted || deployServers(servers.data).length > 0);
  const options = deployTargetOptions(
    servers.data,
    readsClouds ? cloudAccounts.data : [],
    { platformHost: !hosted },
  );
  const pending =
    servers.isPending || (readsClouds && cloudAccounts.isPending);
  // The Hosted instance with no Server and no Cloud account: an Environment
  // there would have nowhere to point, so the API refuses one.
  const nowhere = askTarget && hosted && !pending && options.length === 0;

  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      name: environment?.name ?? "",
      description: environment?.description ?? "",
      deployTarget: "",
      region: "",
    },
    onSubmit: async (values) => {
      if (nowhere) return;
      const body = {
        name: values.name.trim(),
        description: values.description.trim(),
      };
      const deployTarget = askTarget
        ? fromPickerValue(values.deployTarget, values.region)
        : null;
      if (askTarget && !deployTarget && cloudAccountOf(values.deployTarget)) {
        form.setError("region", { type: "manual", message: "Choose the region" });
        return;
      }
      if (askTarget && !deployTarget) {
        form.setError("deployTarget", {
          type: "manual",
          message: "Choose where this Environment's new Services will run.",
        });
        return;
      }
      if (editing) {
        await update.mutateAsync(body);
        toast.done("Environment saved.", {
          description: `Now called ${body.name}.`,
        });
        onOpenChange(false);
        return;
      }
      const row = await create.mutateAsync(
        deployTarget ? { ...body, deployTarget } : body,
      );
      toast.done(`Environment ${body.name} created.`, {
        description: "Add an Application, a database or a Compose stack to it.",
      });
      onOpenChange(false);
      router.push(`/environments/${row.environmentId}`);
    },
    // A name already taken is a 409 about the Name field, said under it.
    conflictField: "name",
    onError: (error) => toast.error(error),
  });

  const target = form.watch("deployTarget");
  const region = form.watch("region");
  const onCloud = cloudAccountOf(target) !== null;
  const cloud = cloudOf(target, cloudAccounts.data, region);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={editing ? `Rename ${environment.name}` : "New Environment"}
        description={
          editing
            ? "The name is how this Environment is found; nothing deployed in it is renamed."
            : "An Environment is one copy of what this Project deploys, with its own variables."
        }
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <Field
              name="name"
              label="Name"
              hint="What this copy is for — production, staging, a person's name."
            >
              <Input placeholder={example("production")} autoComplete="off" />
            </Field>
            <Field
              name="description"
              label="Description"
              optional
              hint="A short note shown under the name in lists — what pr-482 or blue is for."
            >
              <Textarea rows={2} className="max-h-40" />
            </Field>
            {nowhere ? (
              <div className="grid gap-2">
                <p className="text-meta text-tx-2">
                  An Environment needs a Server or a Cloud account to deploy to,
                  and this Organization has neither yet.
                </p>
                <div className="flex flex-wrap gap-2">
                  <LinkButton size="sm" href="/servers">
                    Add a Server
                  </LinkButton>
                  <LinkButton size="sm" href="/settings/cloud-accounts">
                    Connect a Cloud account
                  </LinkButton>
                </div>
              </div>
            ) : askTarget ? (
              <Field
                name="deployTarget"
                label="Deploy target"
                manual
                hint="Where a Service created in this Environment will run. Each Service keeps its own Server, and this can be changed later."
              >
                <Picker
                  options={options}
                  pending={pending}
                  placeholder={
                    hosted
                      ? "Choose a Server or a Cloud account"
                      : "Choose a Server or this Cloudgate host"
                  }
                  value={target}
                  onValueChange={(value) => {
                    form.setValue("deployTarget", value, { shouldDirty: true });
                    // A region of the other cloud is no choice on this one.
                    const next = cloudOf(value, cloudAccounts.data, "");
                    if (!CLOUDS[next].regions.includes(region)) {
                      form.setValue("region", "", { shouldDirty: true });
                    }
                  }}
                />
              </Field>
            ) : null}
            {askTarget && onCloud ? (
              <Field
                name="region"
                label={CLOUDS[cloud].regionLabel}
                manual
                hint={CLOUDS[cloud].regionHint}
              >
                <Picker
                  options={regionOptions(cloud)}
                  placeholder="Choose a region"
                  value={region}
                  onValueChange={(value) =>
                    form.setValue("region", value, { shouldDirty: true })
                  }
                />
              </Field>
            ) : null}
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton
              pending={form.formState.isSubmitting}
              disabled={nowhere}
            >
              {editing ? "Save changes" : "Create Environment"}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
