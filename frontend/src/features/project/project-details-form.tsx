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
import type { Project } from "@/lib/api/endpoints/projects";
import { usePermission } from "@/lib/auth/use-permission";

import { PROJECT_UPDATE_REFUSAL, useUpdateProject } from "./use-projects";

const schema = z.object({
  name: z.string().trim().min(1, "A Project needs a name."),
  description: z.string(),
});
type Values = z.infer<typeof schema>;

/**
 * A Project's name and description, edited in place.
 *
 * A form on the page rather than the dialog the list uses, because Settings is
 * where someone has come *to* change this — a dialog would be a second click to
 * reach a screen whose whole purpose is already the thing they opened.
 *
 * Mounted only once the row has arrived (the panel does that), so
 * react-hook-form's one read of `defaultValues` is a read of real values.
 *
 * **Save is gated on `project: ['update']`.**
 * The base member no longer holds that statement — `accessedProjects` says
 * which Projects a caller may reach and says nothing about what a write to one
 * reaches, so a member holding one Environment could rewrite the `env` every
 * other Environment under the Project references — changing what every
 * `${{project.KEY}}` already written there resolves to at its next deploy, or
 * failing those deploys outright by removing a key one of them named (ADR-0014;
 * the levels are never merged, so nothing is inherited). Until this gate
 * existed a member filled both fields, pressed Save and met a bare 403.
 *
 * The fields stay live and only the action goes off. Someone whose role changed
 * while this screen was open should still be able to read what is in the form,
 * copy a description out of it, and see the sentence saying why the change
 * cannot be made; `disabled` inputs are for a form that is submitting, not for
 * a form that is not theirs to submit.
 */
export function ProjectDetailsForm({ project }: { project: Project }) {
  const update = useUpdateProject(project.projectId);
  const permission = usePermission({ project: ["update"] });
  const refusalId = useId();

  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      name: project.name,
      description: project.description ?? "",
    },
    onSubmit: async (values) => {
      const body = {
        name: values.name.trim(),
        description: values.description.trim(),
      };
      await update.mutateAsync(body);
      toast.done("Project saved.", { description: `Now called ${body.name}.` });
      form.reset(values);
    },
    // A name already taken is a 409 about the Name field, said under it.
    conflictField: "name",
    onError: (error) => toast.error(error),
  });

  return (
    <Card>
      <Card.Header
        title="Project"
        sub="What this Project is called, and what it is for."
        headingLevel={2}
      />
      <Card.Body>
        <FormProvider {...form}>
          <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
            <Field name="name" label="Name">
              <Input autoComplete="off" />
            </Field>
            <Field
              name="description"
              label="Description"
              optional
              hint="A short note shown under the name in lists."
            >
              <Textarea rows={2} className="max-h-40" />
            </Field>
            <FormError message={form.rootError} />
            {permission.allowed ? null : (
              <p id={refusalId} className="text-meta text-tx-2">
                {PROJECT_UPDATE_REFUSAL}
              </p>
            )}
            <div>
              {/* `disabled` on `Button`, which Base UI turns into
                  `aria-disabled` because `focusableWhenDisabled` is this
                  console's default — so §3.10 is satisfied by the primitive and
                  not by a hand-written attribute: the control keeps its tab
                  position, keeps its focus ring, and can be reached by the
                  keyboard user who most needs to hear why it is off.
                  `aria-describedby` is what they hear, `title` is what a mouse
                  gets, and the paragraph above is what everybody gets without
                  either. */}
              <SubmitButton
                pending={form.formState.isSubmitting}
                disabled={!permission.allowed || !form.formState.isDirty}
                title={permission.allowed ? undefined : PROJECT_UPDATE_REFUSAL}
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
