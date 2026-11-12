import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { FormError } from "@/components/console/field";
import type { FieldSpec } from "@/components/console/form-spec";
import { Modal } from "@/components/console/modal";
import { ResourceField } from "@/components/console/resource-field";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { readMinutes } from "@/lib/format/minutes";

/** The window a request that names none gets (`REQUESTED_PREVIEW_DEFAULT_TTL_MINUTES`). */
const DEFAULT_MINUTES = 60;

type Values = { ttlMinutes: number };

/** "This instance's maximum is 1440 minutes (24 hours)." */
export const maximumSentence = (maxMinutes: number) =>
  `This instance's maximum is ${maxMinutes} minutes (${readMinutes(maxMinutes)}).`;

/**
 * Extending a Requested preview is **choosing a new window**, not adding time
 * `POST /preview-deployments/:id/extend` sets the expiry to now
 * plus the minutes asked for, whatever was left of the old one. So the field
 * is "minutes from now", it starts at the default a request gets, and there is
 * no "+1 h" — a button that adds would promise the one thing the route does
 * not do.
 *
 * The instance maximum is said up front and held here too, so an over-long
 * window is refused under the field rather than by a round trip. It is only
 * the console's copy: while the settings read is unanswered the form sends
 * whatever it is given and the backend's refusal, which names the same
 * maximum, is what the caller reads.
 *
 * `noValidate`, because the browser's own range bubble would say a different
 * sentence from the one below the field.
 */
export function ExtendPreviewModal({
  branch,
  maxMinutes,
  extend,
  open,
  onOpenChange,
}: {
  branch: string;
  /** `requestedPreviewMaxTtlMinutes`, once the settings read has answered. */
  maxMinutes: number | undefined;
  extend: (ttlMinutes: number) => Promise<unknown>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const minutes = z.coerce
    .number()
    .int("Whole minutes only.")
    .min(1, "At least one minute.");
  const schema = z.object({
    ttlMinutes:
      maxMinutes === undefined
        ? minutes
        : minutes.max(maxMinutes, maximumSentence(maxMinutes)),
  });

  const form = useApiForm<Values>({
    schema,
    defaultValues: { ttlMinutes: DEFAULT_MINUTES },
    onSubmit: async (values) => {
      await extend(values.ttlMinutes);
      onOpenChange(false);
    },
  });

  const field: FieldSpec<Values> = {
    kind: "number",
    name: "ttlMinutes",
    label: "Minutes from now",
    min: 1,
    max: maxMinutes,
    hint:
      maxMinutes === undefined
        ? "The preview expires this many minutes from now."
        : `The preview expires this many minutes from now. ${maximumSentence(maxMinutes)}`,
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Extend the preview of ${branch}`}
        description="Choose a new window, starting now. It replaces what was left of the old one rather than adding to it."
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <ResourceField spec={field} values={form.watch()} />
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              Set the new expiry
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
