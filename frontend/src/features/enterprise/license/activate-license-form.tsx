import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import type { ApiForm } from "@/components/console/use-api-form";
import { Input } from "@/components/ui/input";

export const licenseKeySchema = z.object({
  licenseKey: z.string().trim().min(1, "Paste the license key you were sent."),
});

export type LicenseKeyValues = z.infer<typeof licenseKeySchema>;

/**
 * Paste a key and activate it.
 *
 * **Activation talks to a third party, and its refusals are the useful part.**
 * `POST /license/activate` calls `licenses-api.cloudgate.dev` and turns whatever
 * comes back into a **400 carrying a message**. There are three of those, because
 * the next move differs for each: the licence server's own words for a refused key
 * (check the key), a sentence naming the HTTP status when the licence server
 * answered something that is not a decision about the key (retry, or contact
 * support), and `LICENSE_SERVER_UNREACHABLE`'s when the host could not be reached
 * (check the network). All three land on the field through `useApiForm`, which is
 * right: in every case the thing to do next is about this form.
 *
 * **The client still does not tell them apart, and now it does not have to**
 * The original form
 * of this note said the backend could not distinguish them either — which was true,
 * and was the defect: a **404** from the activation path, the answer a *correct*
 * key got on the build that filed the ticket, arrived as `Failed to activate license
 * key` and read as a refusal. `LicenseApiClient` names the class now. Guessing at it
 * here from the wording remains the wrong answer, for the reason it always was: a
 * confident label that is wrong the first time the licence server changes a message.
 *
 * The hint carries the other precondition: activation is refused while the
 * enterprise opt-in above is off, so the form says so rather than letting somebody
 * paste a key into something that will refuse it.
 */
export function ActivateForm({
  form,
  optedIn,
  replacing = false,
}: {
  form: ApiForm<LicenseKeyValues>;
  optedIn: boolean;
  /** A key is already stored, so this one replaces it. */
  replacing?: boolean;
}) {
  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit} className="grid gap-3">
        <Field
          name="licenseKey"
          label={replacing ? "Replace it with another key" : "License key"}
          hint={
            optedIn
              ? "Cloudgate checks it with the license server before storing it."
              : "Turn on enterprise features above first — activation is refused while that switch is off."
          }
        >
          <Input
            placeholder="CG-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <FormError message={form.rootError} />
        <div>
          <SubmitButton pending={form.formState.isSubmitting}>
            {replacing ? "Activate this key instead" : "Activate"}
          </SubmitButton>
        </div>
      </form>
    </FormProvider>
  );
}

/**
 * Enough of the key to recognise it by, and no more.
 *
 * The last four characters are what tells two keys apart on a support call. A
 * key short enough that four characters would be most of it is hidden entirely
 * rather than half-shown.
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${"•".repeat(key.length - 4)}${key.slice(-4)}`;
}
