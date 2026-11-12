import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OrganizationMembership } from "@/lib/api/endpoints/organizations";
import {
  useCreateOrganization,
  useUpdateOrganization,
} from "@/lib/api/use-organizations";

/** The DTO's bounds (`createOrganizationSchema`), in the console's words. */
const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name the Organization.")
    .max(255, "A name is at most 255 characters."),
});
type Values = z.infer<typeof schema>;

/**
 * Create an Organization, or rename one.
 *
 * Here rather than in `features/settings/organization/` because the masthead
 * switcher opens it too, and §1.4's promotion rule moves anything a second
 * importer reaches for.
 *
 * One dialog on F08's precedent — `POST /organizations` and
 * `PATCH /organizations/:id` take the same body — and one field, because that is
 * the whole editable row: `logo` is in both DTOs and there is nowhere to upload
 * an image to, which is the same absence the profile card's avatar has and the
 * same answer (do not offer a control with nowhere to put the file).
 *
 * **Creating one needs owner or admin in the Organization you are already in.**
 * `organizationsService.create` checks `user.role`, so a member gets a 403 with
 * "Only the organization owner can create an organization" — which lands in the
 * form's root error and stays in the dialog, F03's routing doing its job.
 *
 * **Submit is always on, and an empty name is refused inline**, the
 * console's one pattern for a create dialog. It used to sit disabled until
 * something was typed, which said nothing about why.
 */

export function OrganizationFormModal({
  organization,
  open,
  onOpenChange,
}: {
  organization?: OrganizationMembership;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateOrganization();
  const update = useUpdateOrganization();

  const form = useApiForm<Values>({
    schema,
    defaultValues: { name: organization?.name ?? "" },
    onSubmit: async ({ name }) => {
      if (organization) {
        await update.mutateAsync({ organizationId: organization.id, name });
        toast.done(`It is now called ${name}.`);
      } else {
        await create.mutateAsync({ name });
        toast.done(`${name} created.`);
      }
      onOpenChange(false);
    },
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={
          organization
            ? `Rename ${organization.name}`
            : "Create an Organization"
        }
        description={
          organization
            ? "Only the name changes. Nothing inside it moves."
            : "You will be its owner. It starts empty and you stay where you are."
        }
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <Field
              name="name"
              label="Name"
              hint="What it is called everywhere in the console."
            >
              <Input autoComplete="off" />
            </Field>
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              {organization ? "Rename Organization" : "Create Organization"}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
