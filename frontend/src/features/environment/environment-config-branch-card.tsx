import { useId } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { Field, FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Input } from "@/components/ui/input";
import type { Environment } from "@/lib/api/endpoints/environments";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { useUpdateEnvironment } from "./use-environments";

const schema = z.object({
  configBranch: z
    .string()
    .trim()
    .refine((value) => !/\s/.test(value), "A branch name has no spaces."),
});
type Values = z.infer<typeof schema>;

/**
 * An Environment's **Config branch** (US49): the branch it reads a
 * repository-kept Project config from, empty for the repository's default
 * branch — so staging can try a change before production does.
 *
 * Saving reads nothing and changes nothing that runs: the next plan of this
 * Environment ("Check for changes") reads the new branch. Off, with the
 * reason, for a role without `environment: ['update']`, as the other cards
 * on this tab are.
 */
export function EnvironmentConfigBranchCard({
  environment,
}: {
  environment: Environment;
}) {
  const update = useUpdateEnvironment(
    environment.environmentId,
    environment.projectId,
  );
  const permission = usePermission({ environment: ["update"] });
  const refusal = roleRefusal("change this Environment's Config branch");
  const refusalId = useId();

  const form = useApiForm<Values>({
    schema,
    defaultValues: { configBranch: environment.configBranch ?? "" },
    onSubmit: async (values) => {
      if (!permission.allowed) {
        form.setError("root", { type: "manual", message: refusal });
        return;
      }
      const configBranch = values.configBranch.trim();
      await update.mutateAsync({ configBranch: configBranch || null });
      toast.done("Config branch saved.", {
        description: configBranch
          ? `The next plan here reads the config from ${configBranch}.`
          : "The next plan here reads the config from the repository's default branch.",
      });
      form.reset({ configBranch });
    },
    onError: (error) => toast.error(error),
  });

  return (
    <Card>
      <Card.Header
        title="Config branch"
        sub="The branch this Environment reads the Project config from, when the config is kept in a repository."
        headingLevel={2}
      />
      <Card.Body>
        <FormProvider {...form}>
          <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
            <Field
              name="configBranch"
              label="Branch"
              optional
              hint="Leave it empty for the repository's default branch. A Service the plan creates from this same repository builds from this branch too."
            >
              <Input autoComplete="off" className="font-mono" />
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
                Save Config branch
              </SubmitButton>
            </div>
          </form>
        </FormProvider>
      </Card.Body>
    </Card>
  );
}
