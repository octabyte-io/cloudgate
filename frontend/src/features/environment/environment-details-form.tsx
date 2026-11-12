import { useId } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { Field, FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Environment } from "@/lib/api/endpoints/environments";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { useUpdateEnvironment } from "./use-environments";

const schema = z.object({
  name: z.string().trim().min(1, "An Environment needs a name."),
  description: z.string(),
});
type Values = z.infer<typeof schema>;

/**
 * An Environment's name and description, edited in place.
 *
 * Two fields, because that is the whole editable row bar the variables, which
 * have their own tab: `updateEnvironmentSchema` is `{ name?, description?, env? }`
 * `projectId` is
 * omitted from the DTO deliberately — an Environment does not move Projects.
 *
 * Mounted only once the row has arrived, so react-hook-form's single read of
 * `defaultValues` is a read of real values.
 *
 * **Off, with the reason, for a role the save would be refused**.
 * `PATCH /environments/:id` runs `findOwnedForUpdate`, which asks for
 * `environment: ['update']` — the statement the Variables tab's card beside it
 * already reads. The fields stay live and only the action goes off, as on
 * `ProjectDetailsForm`.
 */
export function EnvironmentDetailsForm({
  environment,
}: {
  environment: Environment;
}) {
  const update = useUpdateEnvironment(
    environment.environmentId,
    environment.projectId,
  );

  const permission = usePermission({ environment: ["update"] });
  const refusal = roleRefusal("rename or describe this Environment");
  const refusalId = useId();

  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      name: environment.name,
      description: environment.description ?? "",
    },
    onSubmit: async (values) => {
      // Enter in a field submits whatever the button says.
      if (!permission.allowed) {
        form.setError("root", { type: "manual", message: refusal });
        return;
      }
      const body = {
        name: values.name.trim(),
        description: values.description.trim(),
      };
      await update.mutateAsync(body);
      toast.done("Environment saved.", {
        description: `Now called ${body.name}.`,
      });
      form.reset(values);
    },
    // A name already taken is a 409 about the Name field, said under it.
    conflictField: "name",
    onError: (error) => toast.error(error),
  });

  return (
    <Card>
      <Card.Header
        title="Environment"
        sub="What this copy of the Project is called, and what it is for."
        headingLevel={2}
      />
      <Card.Body>
        <FormProvider {...form}>
          <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
            <Field
              name="name"
              label="Name"
              hint="Renaming does not rename anything deployed in it."
            >
              <Input autoComplete="off" />
            </Field>
            <Field
              name="description"
              label="Description"
              optional
              hint="A short note shown under the name in lists — what pr-482 or blue is for."
            >
              <Textarea rows={2} className="max-h-40" />
            </Field>
            <FormError message={form.rootError} />
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
                Save changes
              </SubmitButton>
            </div>
          </form>
        </FormProvider>
      </Card.Body>
    </Card>
  );
}
