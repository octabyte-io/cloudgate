import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { TagRow } from "./tag-row";
import { useCreateTag, useTags } from "./use-tags";
import { example } from "@/components/console/form-spec";

const schema = z.object({
  name: z.string().trim().min(1, "A tag needs a name."),
});
type Values = z.infer<typeof schema>;

/**
 * The Organization's Tags, managed in one place.
 *
 * It is a dialog on the Projects screen rather than a page of its own because a
 * Tag has exactly one use — labelling a Project — and the route tree has no
 * `/tags` (`nav.ts`, which F07 owns). Managing them where they are used also
 * means the filter above the list and the vocabulary behind it are one click
 * apart, instead of a screen apart.
 *
 * Creating and renaming both go through the same 409 the backend raises on
 * `unique_org_tag_name` — a rename too, and the name is
 * unique regardless of case. A create's lands on the **field**: "A tag with
 * this name already exists" is about the name someone just typed, not about the
 * request. A rename's is `TagRow`'s toast, beside the row being renamed.
 */
export function ManageTagsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tags = useTags();
  const create = useCreateTag();
  // `POST /tags` is `tag: ['create']`, which the base member does not hold
  // the field stays, so the list can still be read, and Add says why.
  const canCreate = usePermission({ tag: ["create"] });

  const form = useApiForm<Values>({
    schema,
    defaultValues: { name: "" },
    onSubmit: async (values) => {
      // Enter in the field submits the form whatever the button says, so the
      // refusal is said beside the field rather than sent to the backend.
      if (!canCreate.allowed) {
        form.setError("name", { type: "manual", message: TAG_CREATE_REFUSAL });
        return;
      }
      await create.mutateAsync({ name: values.name.trim() });
      toast.done(`Tag ${values.name.trim()} created.`);
      form.reset({ name: "" });
      // Back to the field, not left on the button. Found by driving it: tags
      // are added in a run of two or three, and typing the second one straight
      // after pressing Add went into the button and vanished.
      form.setFocus("name");
    },
    onError: (error) => {
      // A duplicate name is a 409, which has no field issues attached — but it
      // is unambiguously about this input, so it is put back on it rather than
      // left in a root error the eye has already scrolled past.
      form.setError("name", { type: "server", message: errorMessage(error) });
    },
  });

  const rows = tags.data ?? [];

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="Manage tags"
        description="Label the Projects that belong together, then filter the list by them."
      />
      <Modal.Body>
        <FormProvider {...form}>
          <form
            method="post"
            noValidate
            onSubmit={form.submit}
            className="flex flex-wrap items-end gap-2"
          >
            <Field
              name="name"
              label="New tag"
              className="min-w-0 flex-[1_1_220px]"
            >
              <Input placeholder={example("billing")} autoComplete="off" />
            </Field>
            <SubmitButton
              pending={form.formState.isSubmitting}
              className="mb-0.5"
              disabled={!canCreate.allowed}
              title={canCreate.allowed ? undefined : TAG_CREATE_REFUSAL}
            >
              Add tag
            </SubmitButton>
          </form>
        </FormProvider>

        {tags.error ? (
          <FormError message={errorMessage(tags.error)} />
        ) : tags.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-ctl" />
            <Skeleton className="h-ctl" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-body text-tx-2">
            Add your first tag above. It appears here and in the Tags filter.
          </p>
        ) : (
          <ul className="flex flex-col rounded-lg border border-line">
            {rows.map((tag) => (
              <TagRow key={tag.tagId} tag={tag} />
            ))}
          </ul>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button variant="pri">Done</Button>} />
      </Modal.Footer>
    </Modal>
  );
}

const TAG_CREATE_REFUSAL = roleRefusal("add a tag");
