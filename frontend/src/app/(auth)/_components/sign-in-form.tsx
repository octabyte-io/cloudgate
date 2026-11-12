"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { PasswordInput } from "@/components/console/password-input";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Input } from "@/components/ui/input";
import { resolveOrganizationDestination } from "@/lib/auth/active-organization";
import { isApiError } from "@/lib/api/api-error";
import { useBrandingOrDefault } from "@/lib/api/use-branding";
import { unwrap } from "@/lib/auth/auth-error";
import { signIn } from "@/lib/auth/client";
import {
  FORGOT_PASSWORD_PATH,
  NEXT_PARAM,
  SELECT_ORGANIZATION_PATH,
  SIGN_UP_PATH,
  TWO_FACTOR_PATH,
  isGetStartedPath,
  safeNextPath,
  withNext,
} from "@/lib/auth/routes";

import { AuthLink } from "./auth-link";
import { AuthPanel } from "./auth-panel";
import { currentPasswordField, emailField } from "./schemas";
import { SsoButton } from "./sso-button";
import { useSignUpOpen } from "./use-sign-up-open";
import { useSsoConfig } from "./use-sso-config";

const schema = z.object({
  email: emailField,
  password: currentPasswordField,
});

type Values = z.infer<typeof schema>;

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get(NEXT_PARAM));
  const sso = useSsoConfig();
  // A white-labelled instance names itself in the heading. Unbranded,
  // the mark above already says Cloudgate, so the heading stays two words.
  const { appName } = useBrandingOrDefault();
  // Only to decide whether the footer offers to set this instance up.
  const instance = useSignUpOpen(false);
  // Throttled: better-auth said how long to wait, and the button stays off
  // until then. A press inside the window is refused anyway, and on the
  // run that found this one person sent eleven of them in six seconds.
  const [throttled, setThrottled] = useState(false);
  const throttleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(throttleTimer.current), []);

  const form = useApiForm<Values>({
    schema,
    defaultValues: { email: "", password: "" },
    onSubmit: async (values) => {
      let result;
      try {
        result = await unwrap(
          signIn.email({ email: values.email, password: values.password }),
        );
      } catch (error) {
        if (
          isApiError(error) &&
          error.status === 429 &&
          error.retryAfter !== undefined
        ) {
          setThrottled(true);
          clearTimeout(throttleTimer.current);
          throttleTimer.current = setTimeout(() => {
            setThrottled(false);
            // "Try again in 9 seconds" stops being true the moment the button
            // comes back, so the sentence goes with the wait.
            form.clearErrors("root");
          }, error.retryAfter * 1000);
        }
        // The sentence is `errorMessage()`'s, which names the same wait.
        throw error;
      }

      // A 2FA challenge is not a failure, so it does not arrive as one:
      // better-auth answers the sign-in with `twoFactorRedirect` and sets a
      // short-lived two-factor cookie *instead of* a session. The challenge screen
      // is the rest of this sign-in, which is why `next` is carried into it.
      if ((result as { twoFactorRedirect?: boolean }).twoFactorRedirect) {
        router.push(withNext(TWO_FACTOR_PATH, next));
        return;
      }

      const destination = await resolveOrganizationDestination(next);

      // Signed in, and a member of nothing — someone who signed up against an
      // invitation and has not accepted it. Every console screen would answer 403
      // 'No active organization', so this says so once instead of letting them
      // find out one screen at a time.
      if (destination.kind === "none") {
        router.push(withNext(SELECT_ORGANIZATION_PATH, next));
        return;
      }

      // A full navigation, not `router.push`. This is the moment the app's identity
      // changes: `useSession` reads a module-level store, the query cache may still
      // hold rows fetched as whoever was here before, and the console is about to
      // be server-rendered against a cookie that did not exist when this page
      // loaded. Reloading the document is the one step that leaves none of that to
      // chance, and paying for it once per sign-in is not a cost worth optimising.
      window.location.assign(destination.href);
    },
  });

  return (
    <AuthPanel
      title={
        // On the way to the get-started wizard from the templates website.
        isGetStartedPath(next)
          ? "Sign in to deploy your app"
          : appName
            ? `Sign in to ${appName}`
            : "Sign in"
      }
      lede={
        isGetStartedPath(next)
          ? "Then choose a server, and Cloudgate puts your app on it for you."
          : "Deploy and operate your applications, databases and servers."
      }
      footer={
        // Offered only while there is something to set up. On an
        // instance that already has an owner, `/sign-up` can only tell them it is
        // closed — so the link was an invitation to a dead end, and this is the
        // screen most people arrive at first.
        //
        // Rendered on the answer rather than held for it: this is a secondary line
        // below the card, and nothing above it moves when it appears. The common
        // case is a claimed instance, where it never appears at all.
        !instance.ready ? null : instance.state === "unclaimed" ? (
          <span>
            New instance? <AuthLink href={SIGN_UP_PATH}>Set it up</AuthLink>
          </span>
        ) : instance.state === "open" ? (
          // The Hosted instance, once its Instance organization exists.
          <span>
            No account yet?{" "}
            {/* `next` goes along, so signing up lands where signing in would. */}
            <AuthLink href={withNext(SIGN_UP_PATH, next)}>Create one</AuthLink>
          </span>
        ) : null
      }
    >
      {!sso.ready ? (
        // Held, rather than rendered and then removed — `useSsoConfig` says why.
        <div className="grid gap-4" aria-busy="true">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-ctl" />
        </div>
      ) : sso.enforced ? (
        // SSO is mandatory here, so there is no password form at all — not a
        // disabled one. This organization has decided passwords are not a way in,
        // and a form that is present but always refused makes someone doubt their
        // own password rather than read the sentence above it.
        <div className="grid animate-fade gap-3">
          <p className="text-body text-tx-2">
            This instance signs in through your Organization&rsquo;s identity
            provider.
          </p>
          <SsoButton next={next} />
        </div>
      ) : (
        <FormProvider {...form}>
          <form
            method="post"
            onSubmit={form.submit}
            noValidate
            // Fades in where the skeleton stood, without moving: the skeleton
            // holds the same three rows.
            className="grid animate-fade gap-4"
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

            <div className="grid gap-1.5">
              <Field name="password" label="Password">
                <PasswordInput autoComplete="current-password" />
              </Field>
              {/*
                Outside the `Field` on purpose. As its `hint` it would be wired into
                `aria-describedby`, so a screen reader would introduce the password
                box as "Forgot your password?" — describing the field as the thing
                you use when you have forgotten it.
              */}
              <p className="text-meta">
                <AuthLink href={FORGOT_PASSWORD_PATH}>
                  Forgot your password?
                </AuthLink>
              </p>
            </div>

            <SubmitButton
              block
              pending={form.formState.isSubmitting}
              disabled={throttled}
            >
              Sign in
            </SubmitButton>

            {sso.enabled ? (
              <>
                <div className="flex items-center gap-3 text-meta text-tx-3">
                  <span className="h-px flex-1 bg-line" />
                  or
                  <span className="h-px flex-1 bg-line" />
                </div>
                <SsoButton next={next} />
              </>
            ) : null}
          </form>
        </FormProvider>
      )}
    </AuthPanel>
  );
}
