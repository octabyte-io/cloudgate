"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Segmented } from "@/components/console/segmented";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Input } from "@/components/ui/input";
import { resolveOrganizationDestination } from "@/lib/auth/active-organization";
import { AuthError, unwrap } from "@/lib/auth/auth-error";
import { twoFactor } from "@/lib/auth/client";
import {
  NEXT_PARAM,
  SELECT_ORGANIZATION_PATH,
  safeNextPath,
  signInWithNext,
  withNext,
} from "@/lib/auth/routes";

import { AuthLink } from "./auth-link";
import { AuthPanel } from "./auth-panel";
import { ChallengeClosed } from "./challenge-closed";

/**
 * The codes that mean *this challenge is over* — not "that was wrong, try again".
 *
 * better-auth expires the two-factor cookie when any of these fire, so the box on
 * screen has nothing left to verify against. Telling someone to check their
 * authenticator app again would be sending them to fetch a code that cannot work.
 */
const CHALLENGE_OVER = new Set([
  "INVALID_TWO_FACTOR_COOKIE",
  "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
  "ACCOUNT_TEMPORARILY_LOCKED",
]);

type Method = "totp" | "backup";

const schema = z.object({
  code: z.string().trim().min(1, "Enter the code."),
});

type Values = z.infer<typeof schema>;

export function TwoFactorForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get(NEXT_PARAM));
  const [method, setMethod] = useState<Method>("totp");
  const [over, setOver] = useState<string | null>(null);

  const form = useApiForm<Values>({
    schema,
    defaultValues: { code: "" },
    onSubmit: async (values) => {
      // Spaces are how authenticator apps *display* a code ("123 456") and how
      // people copy it. Refusing it over the space would be refusing the code they
      // were shown.
      const code = values.code.replace(/\s/g, "");

      try {
        await unwrap(
          method === "totp"
            ? twoFactor.verifyTotp({ code })
            : twoFactor.verifyBackupCode({ code }),
        );
      } catch (error) {
        if (error instanceof AuthError && CHALLENGE_OVER.has(error.code)) {
          setOver(error.code);
          return;
        }
        throw error;
      }

      const destination = await resolveOrganizationDestination(next);
      // Same reasoning as the sign-in form: verifying the second factor is the
      // moment the session actually starts existing, so the document reloads
      // against it rather than pushing a route the client is still stale for.
      window.location.assign(
        destination.kind === "none"
          ? withNext(SELECT_ORGANIZATION_PATH, next)
          : destination.href,
      );
    },
  });

  if (over) return <ChallengeClosed code={over} next={next} />;

  const backup = method === "backup";

  return (
    <AuthPanel
      title="Two-step verification"
      lede={
        backup
          ? "Enter one of the backup codes you saved when you turned this on."
          : "Enter the 6-digit code from your authenticator app."
      }
      footer={
        // Every sibling auth screen ends with a way back; this one ended with the
        // wordmark. `next` rides along, so starting over as the right
        // account still lands where the first attempt was headed.
        //
        // The second line is the lost-factor case, and it names the only path
        // that exists. The console has no screen that turns off another
        // account's two-step verification — no owner or admin can do it for you
        // (a forgotten password is the same trap) — so past the backup-code switch
        // above, it takes somebody with access to the platform host's database
        // (`docs/deploy.md`, "Locked out").
        <>
          <span>
            Not you?{" "}
            <AuthLink href={signInWithNext(next)}>Back to sign in</AuthLink>
          </span>
          <p className="basis-full">
            Lost your authenticator app and your backup codes? Only whoever
            manages the platform host, the machine Cloudgate runs on, can turn
            two-step verification off for your account.
          </p>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          method="post"
          onSubmit={form.submit}
          noValidate
          className="grid gap-4"
        >
          <FormError message={form.rootError} />

          {/*
            A `Segmented`, not a modal. Choosing which factor you have to hand is
            the same decision as typing the code, and both options fit on one row.
            A dialog would put a second form on top of this one for no gain.
          */}
          <Segmented<Method>
            label="Verification method"
            value={method}
            onChange={(value) => {
              setMethod(value);
              // The two codes look nothing alike — six digits against a long
              // alphanumeric string — so carrying one into the other field only
              // guarantees a refusal.
              form.reset({ code: "" });
            }}
            options={[
              { value: "totp", label: "Authenticator app" },
              { value: "backup", label: "Backup code" },
            ]}
            className="w-full *:flex-1 *:justify-center"
          />

          <Field
            // Remounts the input when the method changes, so `autoFocus` fires
            // again and the field's own attributes (length, keyboard) switch with
            // it rather than being patched in place.
            key={method}
            name="code"
            label={backup ? "Backup code" : "Authenticator code"}
            hint={
              backup
                ? "Each backup code works once."
                : "The code changes every 30 seconds."
            }
          >
            <Input
              // `one-time-code` is what makes iOS and Android offer the code from
              // the notification. It is right for the TOTP case only — a backup
              // code is in a password manager, not a text message.
              autoComplete={backup ? "off" : "one-time-code"}
              inputMode={backup ? "text" : "numeric"}
              autoCapitalize="none"
              spellCheck={false}
              // 7 and not 6: an authenticator app *shows* the code as "123 456",
              // which is what gets copied. The space is stripped on submit, so the
              // limit has to leave room for it or a paste arrives truncated to
              // "123 45" and is refused for being the code they were shown.
              maxLength={backup ? 32 : 7}
              autoFocus
              placeholder={backup ? "" : "123456"}
              className={
                backup
                  ? "font-mono"
                  : "text-center font-mono text-lead tracking-code"
              }
            />
          </Field>

          <SubmitButton block pending={form.formState.isSubmitting}>
            Verify
          </SubmitButton>
        </form>
      </FormProvider>
    </AuthPanel>
  );
}
