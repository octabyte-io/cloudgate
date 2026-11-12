import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { Field, FormError } from "@/components/console/field";
import { PasswordInput } from "@/components/console/password-input";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Switch } from "@/components/ui/switch";
import { unwrap } from "@/lib/auth/auth-error";
import { changePassword } from "@/lib/auth/client";
import {
  currentPasswordField,
  matchingPasswords,
  newPasswordField,
} from "@/lib/forms/credentials";

const schema = matchingPasswords(
  z.object({
    current: currentPasswordField,
    password: newPasswordField,
    confirm: z.string(),
  }),
);

type Values = z.infer<typeof schema>;

const EMPTY: Values = { current: "", password: "", confirm: "" };

/**
 * Change your password.
 *
 * **The one thing on this screen that does not go through
 * `users.controller.ts`.** That controller has no password route; better-auth's
 * `/api/auth/change-password` is not on `auth.config.ts`'s `disabledPaths`, and
 * F02's proxy keeps it on this origin — so the auth client is not a shortcut
 * here, it is the only door. `unwrap()` turns better-auth's `{data, error}` back
 * into a throw so `useApiForm` routes the refusal the way it routes every other
 * one, and F06's auth-code map already has the right sentence for a wrong
 * current password — a **401**, which F02 would otherwise read as "your session
 * has ended", which is advice to sign in again in the middle of being signed in.
 *
 * **The other-sessions switch defaults on**, and that is the deliberate choice
 * rather than the safe-looking one: the reason people change a password is that
 * they think somebody else has it, and leaving every other session alive is
 * exactly what a person doing that does not want. It stays a switch because the
 * other reason — a routine rotation from a laptop, with a phone signed in — is
 * real too, and silently signing that phone out would be surprising.
 *
 * It is **not** part of `Values`: it is an instruction about what to do with the
 * change rather than a value being validated, and putting it in the schema would
 * give `useApiForm` a field path to route a 400's issues onto that no input owns.
 */
export function PasswordCard() {
  const [revokeOthers, setRevokeOthers] = useState(true);

  const form = useApiForm<Values>({
    schema,
    defaultValues: EMPTY,
    onSubmit: async (values) => {
      await unwrap(
        changePassword({
          currentPassword: values.current,
          newPassword: values.password,
          revokeOtherSessions: revokeOthers,
        }),
      );
      toast.done(
        revokeOthers
          ? "Your password is changed, and every other session is signed out."
          : "Your password is changed.",
      );
      form.reset(EMPTY);
    },
    onError: (error) => toast.error(error),
  });

  return (
    <Card>
      <Card.Header
        title="Password"
        sub="Changing it needs the current one."
        headingLevel={2}
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Card.Body className="grid gap-3.5">
            <Field name="current" label="Current password">
              <PasswordInput autoComplete="current-password" />
            </Field>
            <Field
              name="password"
              label="New password"
              hint="At least 8 characters."
            >
              <PasswordInput autoComplete="new-password" />
            </Field>
            <Field name="confirm" label="New password again">
              <PasswordInput autoComplete="new-password" />
            </Field>

            <div className="flex items-start gap-3 rounded-lg bg-panel-2 px-3.5 py-3">
              <Switch
                id="revoke-others"
                checked={revokeOthers}
                onCheckedChange={setRevokeOthers}
                className="mt-0.5"
              />
              <label
                htmlFor="revoke-others"
                className="min-w-0 text-body text-tx"
              >
                Sign out every other session
                <span className="mt-0.5 block text-meta text-tx-2">
                  Everywhere else this account is signed in stops working. This
                  one keeps going.
                </span>
              </label>
            </div>

            <FormError message={form.rootError} />
            <div className="pt-0.5">
              <SubmitButton pending={form.formState.isSubmitting}>
                Change password
              </SubmitButton>
            </div>
          </Card.Body>
        </form>
      </FormProvider>
    </Card>
  );
}
