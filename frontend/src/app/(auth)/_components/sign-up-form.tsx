"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { PasswordInput } from "@/components/console/password-input";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Input } from "@/components/ui/input";
import { resolveOrganizationDestination } from "@/lib/auth/active-organization";
import { AuthError, unwrap } from "@/lib/auth/auth-error";
import { organization, signUp } from "@/lib/auth/client";
import {
  CONSOLE_HOME,
  NEXT_PARAM,
  SIGN_IN_PATH,
  confirmedCallbackPath,
  isGetStartedPath,
  safeNextPath,
  withNext,
} from "@/lib/auth/routes";

import { AuthAction } from "./auth-action";
import { AuthFallback } from "./auth-fallback";
import { AuthLink } from "./auth-link";
import { AuthOutcome } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";
import { CheckInbox } from "./check-inbox";
import { InvitationNotOpen, useInvitationPreview } from "./invitation-preview";
import { CAPTCHA_RESPONSE_HEADER, TurnstileWidget } from "./turnstile-widget";
import { emailField, matchingPasswords, newPasswordField } from "./schemas";
import { useSignUpOpen } from "./use-sign-up-open";

/**
 * The header the backend reads the invitation token off, defined in
 * `backend/src/auth/auth.config.ts` as `INVITATION_TOKEN_HEADER`. It is the *only*
 * way to sign up on an instance that already has an owner — `assertSignUpAllowed`
 * refuses everything else — so an invited person's account is created by this form
 * with this header set, and by nothing else.
 */
const INVITATION_TOKEN_HEADER = "x-cloudgate-token";

/** The backend's default too (`DEFAULT_ORGANIZATION_NAME`), so a blank means it. */
const DEFAULT_ORGANIZATION_NAME = "My Organization";

const schema = matchingPasswords(
  z.object({
    firstName: z.string().trim().min(1, "Enter your first name."),
    lastName: z.string().trim().min(1, "Enter your last name."),
    email: emailField,
    password: newPasswordField,
    confirm: z.string().min(1, "Type the password again."),
    // Only the owner's form asks; an invited account joins an
    // Organization that already has a name. Blank keeps the backend's default.
    organizationName: z
      .string()
      .trim()
      .max(255, "An Organization name is at most 255 characters."),
  }),
);

type Values = z.infer<typeof schema>;

/**
 * Four states, and which one you get is decided before anything is rendered.
 *
 * 1. **Held.** `GET /auth/sign-up-open` has not answered yet, so the screen holds
 *    its layout — title included. The heading is what the state *is* here ("Set up
 *    this instance" against "Already set up"), so rendering one and swapping it is
 *    a screen contradicting itself in its own h1.
 * 2. **Closed.** An owner exists and there is no invitation. Nothing to fill in;
 *    the outcome is the whole answer (before the read existed this was
 *    only reachable *after* submitting five fields).
 * 3. **Not open yet.** The Hosted instance before its Instance organization has
 *    been made on the box. Also nothing to fill in.
 * 4. **Open.** The form — the first account on a Self-hosted instance, anyone's
 *    on the Hosted one once it is open, or an invited one, which the token
 *    authorises whatever state the instance is in.
 */
export function SignUpForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get(NEXT_PARAM));
  /** Present when this form was reached from an invitation link. */
  const invitationId = params.get("invitation");
  // Not `signUp` — that name is better-auth's client, imported above. Truthiness
  // rather than `!== null`, matching every other read of `invitationId` here: a
  // bare `?invitation=` carries no token, so it is not an invited sign-up.
  const instance = useSignUpOpen(Boolean(invitationId));
  // An invited sign-up checks its invitation before offering the form:
  // a made-up or closed id is refused here, not after five fields are filled.
  const invite = useInvitationPreview(invitationId || null);
  const invited = invite.preview?.open ? invite.preview : null;
  /**
   * Set only by a refusal at submit time, which is now the narrow race: somebody
   * claimed this instance between the read above and the form being sent.
   */
  const [refused, setRefused] = useState<"closed" | "not-open-yet" | null>(
    null,
  );
  const state = refused ?? instance.state;
  /**
   * The address a Hosted sign-up was made with, once it has been: the
   * screen is then "check your inbox", since the account signs in only once
   * that address is confirmed.
   */
  const [awaitingConfirmation, setAwaitingConfirmation] = useState<
    string | null
  >(null);
  // The Hosted instance's public form, not the first account's.
  const publicSignUp = !invitationId && state === "open";
  /**
   * The Hosted public form's Turnstile check: the widget's token, sent
   * with the sign-up, and a counter bumped to get a fresh one after a refused
   * sign-up, since each token is good once.
   */
  const turnstileSiteKey = publicSignUp ? instance.turnstileSiteKey : undefined;
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      password: "",
      confirm: "",
      organizationName: DEFAULT_ORGANIZATION_NAME,
    },
    onSubmit: async (values) => {
      if (turnstileSiteKey && !turnstileToken) {
        form.setError("root", {
          type: "manual",
          message: "Complete the check above the button, then try again.",
        });
        return;
      }
      const headers = {
        ...(invitationId ? { [INVITATION_TOKEN_HEADER]: invitationId } : {}),
        ...(turnstileSiteKey && turnstileToken
          ? { [CAPTCHA_RESPONSE_HEADER]: turnstileToken }
          : {}),
      };
      try {
        await unwrap(
          signUp.email(
            {
              email: values.email,
              password: values.password,
              // better-auth's `name` is mapped onto the `firstName` column in
              // `auth.config.ts`; `lastName` is an additional field it accepts as
              // input. Two columns, two questions — this product stores them apart.
              name: values.firstName,
              lastName: values.lastName,
              // Not a user field: the backend's `user.create` hook reads it off
              // the body to name the Organization the first account owns
              // (`sign-up-organization-name.ts`).
              ...(invitationId
                ? {}
                : { organizationName: values.organizationName }),
              // Where the confirmation link lands once followed, signed in:
              // `next`, or sign-in without one. Only a Hosted sign-up is
              // sent one; elsewhere it is unused.
              ...(publicSignUp
                ? { callbackURL: confirmedCallbackPath(next) }
                : {}),
            },
            Object.keys(headers).length > 0 ? { headers } : undefined,
          ),
        );
      } catch (error) {
        // The token has been spent either way.
        if (turnstileSiteKey) setTurnstileReset((count) => count + 1);
        // Not an error to correct — a fact about this instance. Once an owner
        // exists, `assertSignUpAllowed` closes sign-up to everyone without an
        // invitation, so there is no version of this form that would succeed and
        // showing it again under a red sentence invites them to keep trying.
        //
        // On the code, not the message: `assertSignUpAllowed` carries
        // one now, so this no longer breaks the moment its English is reworded.
        if (error instanceof AuthError && error.code === "SIGN_UP_CLOSED") {
          setRefused("closed");
          return;
        }
        if (
          error instanceof AuthError &&
          error.code === "SIGN_UP_NOT_OPEN_YET"
        ) {
          setRefused("not-open-yet");
          return;
        }
        throw error;
      }

      // A Hosted sign-up starts no session: the account signs in once its
      // email is confirmed.
      if (publicSignUp) {
        setAwaitingConfirmation(values.email);
        return;
      }

      // `emailAndPassword.autoSignIn` is on, so they are signed in already.
      // An invited account has no membership until the invitation is accepted —
      // `bootstrapDefaultOrganization` only fires for the very first user — so
      // accepting is part of signing up, not a second errand.
      if (invitationId) {
        await unwrap(organization.acceptInvitation({ invitationId }));
      }

      const destination = await resolveOrganizationDestination(next);
      window.location.assign(
        destination.kind === "none" ? CONSOLE_HOME : destination.href,
      );
    },
  });

  // The address it was sent to, filled in once the invitation is read:
  // it is the only one the sign-up will accept. Still editable, and left alone
  // if something has already been typed there.
  const invitedEmail = invited?.email;
  useEffect(() => {
    if (invitedEmail && !form.getValues("email")) {
      form.setValue("email", invitedEmail);
    }
  }, [form, invitedEmail]);

  // Held rather than rendered and then replaced — see the state note above.
  if (!instance.ready || !invite.ready) return <AuthFallback />;

  if (invite.preview && !invite.preview.open) {
    return <InvitationNotOpen code={invite.preview.code} />;
  }

  if (state === "not-open-yet") {
    return (
      <AuthPanel title="Not open yet">
        <AuthOutcome
          tone="info"
          icon="lock"
          title="Sign-up is not open yet"
          action={<AuthAction href={SIGN_IN_PATH}>Go to sign in</AuthAction>}
        >
          This Cloudgate is not taking new accounts yet. Come back once it
          opens.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  if (state === "closed") {
    return (
      <AuthPanel title="Already set up">
        <AuthOutcome
          tone="info"
          icon="lock"
          title="This instance is closed to new sign-ups"
          action={<AuthAction href={SIGN_IN_PATH}>Go to sign in</AuthAction>}
        >
          It already has an owner, so accounts are created by invitation. Ask an
          owner to invite you, then use the link in the invitation.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  if (awaitingConfirmation) {
    return <CheckInbox email={awaitingConfirmation} next={next} />;
  }

  // On the way to the get-started wizard from the templates website: say
  // what the account is for, in the words of someone deploying one app.
  const deploying = publicSignUp && isGetStartedPath(next);

  return (
    <AuthPanel
      title={
        deploying
          ? "Create your free account to deploy your app"
          : invitationId || publicSignUp
            ? "Create your account"
            : "Set up this instance"
      }
      lede={
        deploying
          ? "Then choose a server, and Cloudgate puts your app on it for you."
          : invited
          ? `You have been invited to ${invited.organizationName}. Create an account with ${invited.email} to join it.`
          : invitationId
            ? "You have been invited to an Organization. Create an account to join it."
            : publicSignUp
              ? "Your account comes with an Organization of its own."
              : "The first account owns this instance. Later ones join by invitation."
      }
      footer={
        <span>
          Already have an account?{" "}
          <AuthLink href={withNext(SIGN_IN_PATH, next)}>Sign in</AuthLink>
        </span>
      }
    >
      <FormProvider {...form}>
        {/*
          `method="post"` is **not** decoration, and it is on every form in this
          group for the same reason. A form with no method is a GET, so any submit
          that reaches the browser rather than React serialises every field into
          the query string — and this form's fields are a password and its
          confirmation. Found by driving it: a submit fired before hydration
          finished left the address bar reading
          `/sign-up?…&password=cloudgate-f06&confirm=cloudgate-f06`, which is then
          in history, in the referer of the next request, and in any proxy log on
          the way. There is no `action`, so React still handles every hydrated
          submit; this only changes what the fallback does, from "publish the
          password" to "POST it to a route that ignores it".
        */}
        <form
          method="post"
          onSubmit={form.submit}
          noValidate
          className="grid gap-4"
        >
          <FormError message={form.rootError} />

          {/* Two columns at every width this card has: a first and last name are
              short, and stacking them costs a whole row for nothing. */}
          <div className="grid grid-cols-2 gap-3">
            <Field name="firstName" label="First name">
              <Input autoComplete="given-name" autoFocus />
            </Field>
            <Field name="lastName" label="Last name">
              <Input autoComplete="family-name" />
            </Field>
          </div>

          {invitationId ? null : (
            <Field
              name="organizationName"
              label="Organization name"
              hint="What your team calls itself. You can rename it later in Settings."
            >
              <Input autoComplete="organization" />
            </Field>
          )}

          <Field name="email" label="Email">
            <Input
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
            />
          </Field>

          <Field name="password" label="Password" hint="At least 8 characters.">
            <PasswordInput autoComplete="new-password" />
          </Field>

          <Field name="confirm" label="Confirm password">
            <PasswordInput autoComplete="new-password" />
          </Field>

          {turnstileSiteKey ? (
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              onToken={setTurnstileToken}
              resetKey={turnstileReset}
            />
          ) : null}

          <SubmitButton block pending={form.formState.isSubmitting}>
            {invitationId
              ? "Create account and join"
              : publicSignUp
                ? "Create account"
                : "Create owner account"}
          </SubmitButton>
        </form>
      </FormProvider>
    </AuthPanel>
  );
}
