"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { PasswordInput } from "@/components/console/password-input";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { AuthError, unwrap } from "@/lib/auth/auth-error";
import { resetPassword } from "@/lib/auth/client";
import { FORGOT_PASSWORD_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";

import { AuthAction } from "./auth-action";
import { AuthLink } from "./auth-link";
import { AuthOutcome } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";
import { matchingPasswords, newPasswordField } from "./schemas";

const schema = matchingPasswords(
  z.object({
    password: newPasswordField,
    confirm: z.string().min(1, "Type the password again."),
  }),
);

type Values = z.infer<typeof schema>;

export function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token");
  /**
   * better-auth's own callback puts this here. It checks the token before
   * forwarding the browser to this screen and, when it fails, sends
   * `?error=INVALID_TOKEN` instead of `?token=` — so a dead link is known before
   * anyone types a password into a form that cannot use it.
   */
  const errorParam = params.get("error");
  const [done, setDone] = useState(false);
  const [spent, setSpent] = useState(false);

  const form = useApiForm<Values>({
    schema,
    defaultValues: { password: "", confirm: "" },
    onSubmit: async (values) => {
      try {
        await unwrap(
          resetPassword({ newPassword: values.password, token: token ?? "" }),
        );
      } catch (error) {
        // The replay case, and the one the phase brief asks for by name. The
        // backend *consumes* the verification row, so submitting the same link
        // twice lands here on the second attempt — as does a link older than an
        // hour. Both are one state because the backend cannot tell them apart and
        // the fix is identical.
        if (error instanceof AuthError && error.code === "INVALID_TOKEN") {
          setSpent(true);
          return;
        }
        throw error;
      }
      setDone(true);
    },
  });

  if (done) {
    return (
      <AuthPanel title="Password changed">
        <AuthOutcome
          tone="ok"
          icon="check"
          title="Your new password is set"
          action={<AuthAction href={SIGN_IN_PATH}>Sign in</AuthAction>}
        >
          Use it the next time you sign in. The link you followed will not work
          again.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  // Three ways to arrive with nothing usable: the callback rejected the token, the
  // link was truncated on its way through an email client, or the token has just
  // been spent on the submit above. One state, one instruction.
  // Three ways to arrive with nothing usable: the callback rejected the token, the
  // token has just been spent on the submit above, or the link was truncated on
  // its way through an email client. The first two are one state — the backend
  // cannot tell them apart. The third is not about time, so it does not wear the
  // expired heading or the clock.
  if (spent || errorParam) {
    return (
      <AuthPanel title="Link is no longer valid">
        <AuthOutcome
          tone="bad"
          icon="clock"
          title="This link has been used or has expired"
          action={
            <AuthAction href={FORGOT_PASSWORD_PATH}>
              Request a new link
            </AuthAction>
          }
        >
          A reset link works once and lasts an hour. Request a new one and use
          the newest email.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  if (!token) {
    return (
      <AuthPanel title="Link is incomplete">
        <AuthOutcome
          tone="bad"
          icon="x"
          title="This link is incomplete"
          action={
            <AuthAction href={FORGOT_PASSWORD_PATH}>
              Request a new link
            </AuthAction>
          }
        >
          It is missing the part that identifies your account. Check you copied
          the whole link, or request a new one.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      title="Choose a new password"
      lede="Then use it the next time you sign in."
      footer={<AuthLink href={SIGN_IN_PATH}>Back to sign in</AuthLink>}
    >
      <FormProvider {...form}>
        <form
          method="post"
          onSubmit={form.submit}
          noValidate
          className="grid gap-4"
        >
          <FormError message={form.rootError} />

          <Field
            name="password"
            label="New password"
            hint="At least 8 characters."
          >
            <PasswordInput autoComplete="new-password" autoFocus />
          </Field>

          <Field name="confirm" label="Confirm new password">
            <PasswordInput autoComplete="new-password" />
          </Field>

          <SubmitButton block pending={form.formState.isSubmitting}>
            Set new password
          </SubmitButton>
        </form>
      </FormProvider>
    </AuthPanel>
  );
}
