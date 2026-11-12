"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Input } from "@/components/ui/input";
import { passwordResetOpen } from "@/lib/api/endpoints/auth";
import { keys } from "@/lib/api/keys";
import { AuthError, unwrap } from "@/lib/auth/auth-error";
import { requestPasswordReset } from "@/lib/auth/client";
import { RESET_PASSWORD_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";

import { AuthAction } from "./auth-action";
import { AuthFallback } from "./auth-fallback";
import { AuthLink } from "./auth-link";
import { AuthOutcome } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";
import { emailField } from "./schemas";

const schema = z.object({ email: emailField });

type Values = z.infer<typeof schema>;

/** What the screen is showing. Two of the three are terminal. */
type State = "form" | "sent" | "disabled";

export function ForgotPasswordForm() {
  const [state, setState] = useState<State>("form");
  /**
   * Whether reset can send anything here, asked before the form is offered.
   * It used to be learned only from the refusal at submit — after the
   * page had promised "We will email you a link". A failed read is not an
   * answer, so the form is offered and the submit's own refusal still applies.
   */
  const resetOpen = useQuery({
    queryKey: keys.passwordResetOpen(),
    queryFn: ({ signal }) => passwordResetOpen(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  /**
   * After a submit the form is replaced by its outcome, and the button that had
   * focus goes with it — which left focus on `<body>`. The outcome's
   * heading takes it instead, so a screen reader hears what happened.
   */
  const outcomeHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state !== "form") outcomeHeading.current?.focus();
  }, [state]);

  const form = useApiForm<Values>({
    schema,
    defaultValues: { email: "" },
    onSubmit: async (values) => {
      try {
        await unwrap(
          requestPasswordReset({
            email: values.email,
            // Where the link in the email lands. better-auth builds
            // `<baseURL>/reset-password/<token>?callbackURL=…`, checks the token,
            // then forwards to this path with `?token=` attached — which is
            // exactly what the next screen reads.
            redirectTo: `${window.location.origin}${RESET_PASSWORD_PATH}`,
          }),
        );
      } catch (error) {
        // With no MAIL_PROVIDER the backend hands better-auth no sender
        // (`auth.module.ts`), so `sendResetPassword` is unset and this endpoint
        // refuses every request. That is a fact about the instance, not
        // something the person can fix by retrying, so the form goes away.
        if (
          error instanceof AuthError &&
          error.code === "RESET_PASSWORD_DISABLED"
        ) {
          setState("disabled");
          return;
        }
        throw error;
      }
      setState("sent");
    },
  });

  if (state === "sent") {
    return (
      <AuthPanel
        title="Check your email"
        footer={
          <AuthLink href={SIGN_IN_PATH}>Back to sign in</AuthLink>
        }
      >
        <AuthOutcome
          tone="ok"
          icon="mail"
          title="The link is on its way"
          headingRef={outcomeHeading}
        >
          {/*
            Deliberately does not say whether that address has an account. The
            endpoint answers identically either way — on purpose, and it even burns
            the same time doing it — so naming the address here would hand back the
            answer the backend just refused to give.
          */}
          If there is an account for that address, it now has a link for setting a
          new password. The link is good for one hour and works once.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  if (resetOpen.isPending) return <AuthFallback />;

  if (state === "disabled" || resetOpen.data?.open === false) {
    return (
      <AuthPanel title="Reset is not set up">
        <AuthOutcome
          tone="warn"
          icon="mail"
          title="This instance cannot send email yet"
          headingRef={outcomeHeading}
          action={
            <AuthAction href={SIGN_IN_PATH}>Back to sign in</AuthAction>
          }
        >
          {/*
            Names the one path that exists. It used to say "Ask an owner
            to set a new password for you directly", and no console screen does
            that: nobody holds better-auth's admin roles, and on a fresh install
            the person locked out is the only owner. What turns reset on is a
            mail sender, and only somebody with the platform host can set one —
            `docs/deploy.md`, "Locked out", has the keys and the restart.
          */}
          Password reset needs an email sender, and this backend has none
          configured. Ask whoever manages the platform host, the machine
          Cloudgate runs on, to configure an email sender in
          /etc/default/cloudgate-backend and restart the backend (docs/deploy.md,
          “Locked out”). Then request the link again.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      title="Reset your password"
      lede="We will email you a link for setting a new one."
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

          <Field name="email" label="Email">
            <Input
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              autoFocus
            />
          </Field>

          <SubmitButton block pending={form.formState.isSubmitting}>
            Email me a link
          </SubmitButton>
        </form>
      </FormProvider>
    </AuthPanel>
  );
}
