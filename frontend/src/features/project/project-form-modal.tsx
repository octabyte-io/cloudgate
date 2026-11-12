import { useRouter } from "next/navigation";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Project } from "@/lib/api/endpoints/projects";

import { useCreateProject, useUpdateProject } from "./use-projects";
import { example } from "@/components/console/form-spec";

const schema = z.object({
  name: z.string().trim().min(1, "A Project needs a name."),
  description: z.string(),
});
type Values = z.infer<typeof schema>;

/**
 * Create a Project, or rename one.
 *
 * One dialog for both, because they are the same two fields against the same
 * two routes — `POST /projects` and `PATCH /projects/:id` take the identical
 * body (`projects/dto/project.dto.ts`). Splitting them would mean two copies of
 * the same zod schema drifting apart over the description's optionality.
 *
 * The verb changes and nothing else does: the title, the button and the toast
 * all read from `project`, so the word someone pressed is the word they are told
 * about afterwards.
 *
 * **A create lands on the new Project; a rename stays where it was**
 * A new Project
 * has no Environment, and nothing in it can deploy until it has one — which is
 * what the description above the fields and the toast both say comes next. The
 * Project's first tab is where an Environment is made, so the create follows
 * through on its own words the way Add an Application and Add a Server do,
 * rather than leaving the operator to find the row it just added. A toast action
 * was the other way to get there and is not it: the toast is gone in seconds,
 * and the next step is the same for every new Project. A rename is made from
 * the list or from the Project's own settings, and either is already where the
 * operator wants to be.
 */
export function ProjectFormModal({
  project,
  open,
  onOpenChange,
}: {
  /** The Project being renamed, or `null` to create a new one. */
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const create = useCreateProject();
  const update = useUpdateProject(project?.projectId ?? "");
  const editing = project !== null;

  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      name: project?.name ?? "",
      description: project?.description ?? "",
    },
    onSubmit: async (values) => {
      const body = {
        name: values.name.trim(),
        description: values.description.trim(),
      };
      if (editing) {
        await update.mutateAsync(body);
        toast.done(`Project saved.`, {
          description: `Now called ${body.name}.`,
        });
        onOpenChange(false);
        return;
      }
      const row = await create.mutateAsync(body);
      toast.done(`Project ${body.name} created.`, {
        description: "Add an Environment to it to start deploying.",
      });
      onOpenChange(false);
      router.push(`/projects/${row.projectId}`);
    },
    // A name already taken is a 409 about the Name field, said under it.
    conflictField: "name",
    onError: (error) => toast.error(error),
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={editing ? `Rename ${project.name}` : "New Project"}
        description={
          editing
            ? "The name is how this Project is found; nothing deployed under it is renamed."
            : "A Project groups the things that ship together. Its Environments and services come next."
        }
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <Field name="name" label="Name">
              <Input placeholder={example("Storefront")} autoComplete="off" />
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
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              {editing ? "Save changes" : "Create Project"}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
