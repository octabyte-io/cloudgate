import { useId, useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { Field, FormError } from "@/components/console/field";
import { Picker } from "@/components/console/picker";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import type { Environment } from "@/lib/api/endpoints/environments";
import { useServers } from "@/lib/api/use-servers";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { useCloudAccounts } from "@/lib/api/use-cloud-accounts";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import {
  CLOUDS,
  cloudAccountOf,
  cloudOf,
  deployTargetOptions,
  fromPickerValue,
  regionOptions,
  toPickerValue,
} from "./deploy-target";
import { useUpdateEnvironment } from "./use-environments";

const schema = z
  .object({ target: z.string().min(1), region: z.string() })
  .refine(
    (values) => cloudAccountOf(values.target) === null || values.region !== "",
    { path: ["region"], message: "Choose the region" },
  );
type Values = z.infer<typeof schema>;

/**
 * An Environment's Deploy target, shown and changed
 * where a
 * Service a plan creates here will run.
 *
 * **Changing it moves nothing**, and the hint says so where the choice is made:
 * each Service keeps its own run Server, and `PATCH /environments/:id` writes
 * this one column and queues no Deployment. An operator who reads "Deploy
 * target" as "where this Environment runs" would otherwise expect a database to
 * follow the setting across machines.
 *
 * Off, with the reason, for a role without `environment: ['update']` — the
 * statement the same route asks of a rename.
 *
 * **A Cloud account plus a region**
 * is offered to a role that may read Cloud accounts. Saving one runs the
 * region check: a refusal names the region and each denied action beside the
 * form, and a warning (a VPC quota nearly reached) stays under it after the
 * save, since the choice is kept either way. A Google Cloud account offers
 * Google's regions and says what its check asks: whether Cloud
 * Run and Artifact Registry are offered there.
 *
 * **On the Hosted instance "This Cloudgate host" is not offered**
 * and the API
 * refuses it: an Environment saved there before shows no choice until one of
 * the Organization's own is saved.
 */
export function EnvironmentDeployTargetCard({
  environment,
}: {
  environment: Environment;
}) {
  const update = useUpdateEnvironment(
    environment.environmentId,
    environment.projectId,
  );
  const servers = useServers();
  const permission = usePermission({ environment: ["update"] });
  const refusal = roleRefusal("change this Environment's Deploy target");
  const refusalId = useId();
  const canReadClouds = usePermission({ cloudAccount: ["read"] });
  const cloudAccounts = useCloudAccounts({ enabled: canReadClouds.allowed });
  const [warnings, setWarnings] = useState<string[]>([]);
  // The Hosted instance offers no platform host (ADR-0053), and an
  // Environment saved on it from before reads as not chosen yet.
  const hosted = useInstanceMode().data === "hosted";

  const saved =
    hosted && environment.deployTarget.kind === "platform-host"
      ? ""
      : toPickerValue(environment.deployTarget);
  const savedRegion =
    environment.deployTarget.kind === "cloud"
      ? environment.deployTarget.region
      : "";
  const listed = deployTargetOptions(
    servers.data,
    canReadClouds.allowed ? cloudAccounts.data : [],
    { platformHost: !hosted },
  );
  // A role without `server: ['read']` gets no Server list (nor one without
  // `cloudAccount: ['read']` a Cloud account list), and the saved target must
  // still read as what it is rather than fall back to the placeholder, which
  // names the platform host.
  const pending =
    servers.isPending || (canReadClouds.allowed && cloudAccounts.isPending);
  const options =
    pending ||
    saved === "" ||
    listed.some((option) => option.value === saved)
      ? listed
      : [
          ...listed,
          {
            value: saved,
            label:
              cloudAccountOf(saved) === null
                ? "A Server you cannot list"
                : "A Cloud account you cannot list",
          },
        ];

  const form = useApiForm<Values>({
    schema,
    defaultValues: { target: saved, region: savedRegion },
    onSubmit: async (values) => {
      if (!permission.allowed) {
        form.setError("root", { type: "manual", message: refusal });
        return;
      }
      const deployTarget = fromPickerValue(values.target, values.region);
      if (!deployTarget) return;
      const answered = await update.mutateAsync({ deployTarget });
      setWarnings(answered?.warnings ?? []);
      const label =
        options.find((option) => option.value === values.target)?.label ??
        "the chosen Server";
      const place =
        deployTarget.kind === "cloud"
          ? `in ${label}, ${deployTarget.region}`
          : `on ${label}`;
      toast.done("Deploy target saved.", {
        description: `New Services here will be created ${place}. Nothing already running moved.`,
      });
      form.reset(values);
    },
    onError: (error) => toast.error(error),
  });

  const target = form.watch("target");
  const region = form.watch("region");
  const onCloud = cloudAccountOf(target) !== null;
  const cloud = cloudOf(
    target,
    canReadClouds.allowed ? cloudAccounts.data : [],
    region,
  );

  return (
    <Card>
      <Card.Header
        title="Deploy target"
        sub="Where a Service created in this Environment will run."
        headingLevel={2}
      />
      <Card.Body>
        <FormProvider {...form}>
          <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
            <Field
              name="target"
              label="Deploy target"
              manual
              hint="Changing it moves nothing that already runs — each Service keeps its own Server or Cloud account."
            >
              <Picker
                options={options}
                pending={pending}
                placeholder={
                  hosted
                    ? "Choose a Server or a Cloud account"
                    : "This Cloudgate host"
                }
                value={target}
                onValueChange={(value) => {
                  form.setValue("target", value, { shouldDirty: true });
                  // A region of the other cloud is no choice on this one.
                  const next = cloudOf(value, cloudAccounts.data, "");
                  if (!CLOUDS[next].regions.includes(region)) {
                    form.setValue("region", "", { shouldDirty: true });
                  }
                }}
              />
            </Field>
            {onCloud ? (
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
            {warnings.map((warning) => (
              <p key={warning} role="status" className="text-meta text-warn">
                {warning}
              </p>
            ))}
            {permission.allowed ? null : (
              <p id={refusalId} className="text-meta text-tx-2">
                {refusal}
              </p>
            )}
            <div>
              <SubmitButton
                pending={form.formState.isSubmitting}
                disabled={!permission.allowed || !form.formState.isDirty}
                title={permission.allowed ? undefined : refusal}
                aria-describedby={permission.allowed ? undefined : refusalId}
              >
                Save Deploy target
              </SubmitButton>
            </div>
          </form>
        </FormProvider>
      </Card.Body>
    </Card>
  );
}
