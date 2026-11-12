import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Team } from "@/lib/api/endpoints/organizations";

import { useCreateTeam, useRenameTeam } from "./use-members";

/**
 * Submit is always on and an empty name is refused under Name, the
 * one pattern every create dialog in the console uses.
 */
const schema = z.object({
  name: z.string().trim().min(1, "Name the team."),
});
type Values = z.infer<typeof schema>;

/**
 * Create a team, or rename one.
 *
 * One dialog for both, on F08's precedent: `POST /organizations/teams` and
 * `PATCH /organizations/teams/:id` take the identical body — a name and nothing
 * else — so two files would be the same file with two verbs in it.
 */
export function TeamFormModal({
  team,
  open,
  onOpenChange,
}: {
  team?: Team;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateTeam();
  const rename = useRenameTeam();
  const form = useApiForm<Values>({
    schema,
    defaultValues: { name: team?.name ?? "" },
    onSubmit: async ({ name }) => {
      if (team) {
        await rename.mutateAsync({ teamId: team.id, name });
        toast.done(`The team is now called ${name}.`);
      } else {
        await create.mutateAsync(name);
        toast.done(`${name} created.`);
      }
      onOpenChange(false);
    },
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={team ? `Rename ${team.name}` : "Create a team"}
        description={
          team
            ? "Everyone in it stays in it."
            : "A name is the whole of it — you add people afterwards."
        }
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <Field name="name" label="Name">
              <Input autoComplete="off" />
            </Field>
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              {team ? "Rename team" : "Create team"}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
