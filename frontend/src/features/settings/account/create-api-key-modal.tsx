import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { RevealedKey } from "@/components/console/revealed-key";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CreatedApiKey } from "@/lib/api/endpoints/users";

import { useCreateApiKey } from "./use-account";

/** Seconds, because `createApiKeySchema` takes `expiresIn` and not a date. */
const DAY = 24 * 60 * 60;
const THIRTY_DAYS = String(30 * DAY);
const NINETY_DAYS = String(90 * DAY);
const ONE_YEAR = String(365 * DAY);
/** Not a duration: choosing it omits `expiresIn`. */
const NEVER = "never";
const EXPIRY_OPTIONS = [
  { value: THIRTY_DAYS, label: "In 30 days" },
  { value: NINETY_DAYS, label: "In 90 days" },
  { value: ONE_YEAR, label: "In a year" },
  { value: NEVER, label: "Never" },
];

/**
 * `createApiKeySchema`'s bounds, in the console's words. Submit is always on
 * and an empty name is refused under Name, the one pattern every
 * create dialog uses; it used to sit disabled with nothing saying why.
 */
const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name the key after what will use it.")
    .max(255, "A name is at most 255 characters."),
  prefix: z.string().trim().max(64, "A prefix is at most 64 characters."),
});
type Values = z.infer<typeof schema>;

/**
 * Create a key, and then show it — which is the whole dialog, in that order.
 *
 * The two states are not steps of a form. The first is a request; the second is
 * the only render of a value that will never exist again, so it has its own
 * footer ("Done" rather than "Create") and it takes the dialog over completely.
 * `keepOpen` is on for the same reason it is on for the two-factor enrolment: a
 * click on the backdrop is not a decision, and here it would cost the key.
 *
 * **The expiry is offered in the units the route takes.** `expiresIn` is seconds
 * from now, not a timestamp, so a date picker would be a control that computes a
 * duration and then rounds — and "in 90 days" is what people actually mean.
 * Omitting it entirely is what `Never` sends, because the schema is
 * `.positive().optional()` and there is no sentinel for "no expiry".
 *
 * **It opens on 90 days, and Never says what it costs.** A personal key
 * carries everything its owner can do, so permanence is a choice made on
 * purpose rather than the value nobody changed. Never stays offered — a CI
 * secret someone rotates by hand is a real use — but choosing it puts the
 * consequence under the picker. The default lives here and not in the route:
 * a script that omits `expiresIn` still gets the key it always got, and keys
 * that already exist keep their expiry.
 */
export function CreateApiKeyModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateApiKey();
  const [expiry, setExpiry] = useState(NINETY_DAYS);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const form = useApiForm<Values>({
    schema,
    defaultValues: { name: "", prefix: "" },
    onSubmit: async ({ name, prefix }) => {
      setCreated(
        await create.mutateAsync({
          name,
          prefix: prefix === "" ? undefined : prefix,
          expiresIn: expiry === NEVER ? undefined : Number(expiry),
        }),
      );
    },
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange} keepOpen={created !== null}>
      <Modal.Header
        title={created ? "Your new personal key" : "Create a personal key"}
        description={
          created
            ? "This is the only time it is readable."
            : "Name it after what will use it, so revoking the right one later is obvious."
        }
      />

      {created ? (
        <>
          <Modal.Body>
            <RevealedKey value={created.key} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Button
              type="button"
              variant="pri"
              onClick={() => onOpenChange(false)}
            >
              I have copied it
            </Button>
          </Modal.Footer>
        </>
      ) : (
        <FormProvider {...form}>
          <form method="post" noValidate onSubmit={form.submit}>
            <Modal.Body>
              <Field
                name="name"
                label="Name"
                hint="“Deploy pipeline”, “my laptop”. It is what you will see in the list."
              >
                <Input autoComplete="off" />
              </Field>
              <Field
                name="prefix"
                label="Prefix"
                optional
                hint="Prepended to the key, so it is recognisable in a log or a secrets store."
              >
                <Input
                  autoComplete="off"
                  className="font-mono"
                  placeholder="cg_ci"
                />
              </Field>
              <Field name="expiry" label="Expires" manual>
                <Picker
                  value={expiry}
                  onValueChange={setExpiry}
                  options={EXPIRY_OPTIONS}
                />
              </Field>
              {expiry === NEVER ? (
                <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-meta text-tx">
                  This key never expires. It keeps everything you can do until
                  someone revokes it, including after it leaks.
                </p>
              ) : null}
              <FormError message={form.rootError} />
            </Modal.Body>
            <Modal.Footer>
              <Modal.Gap />
              <Modal.Close render={<Button type="button">Cancel</Button>} />
              <SubmitButton pending={form.formState.isSubmitting}>
                Create key
              </SubmitButton>
            </Modal.Footer>
          </form>
        </FormProvider>
      )}
    </Modal>
  );
}
