"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { device } from "@/lib/auth/client";

import { AuthOutcome } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";

type Step = "enter" | "confirm" | "approved" | "denied";

const UNKNOWN_CODE =
  "That code is not one this Instance knows, or it has expired. Run cloudgate login again for a new one.";

const enterSchema = z.object({ code: z.string() });
const decideSchema = z.object({ decision: z.enum(["approve", "deny"]) });

/** `wdjb mjht` and `WDJB-MJHT` are the code `WDJBMJHT`, as the terminal printed it. */
function cleaned(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * The console's half of `cloudgate login`: the terminal printed a code
 * and this address, and the person — signed in, since the proxy gates this
 * screen like any other — checks the code and approves or denies it. Approving
 * gives that terminal a Personal key, in their name, that ends in 90 days.
 *
 * Two steps on purpose. Looking the code up is what binds it to this person
 * (the plugin's `GET /device`), and the second step shows it back before
 * anything is granted, so a code pasted from someone else's message is read
 * before it is approved. `?user_code=` fills the box, and nothing happens
 * until they press Continue.
 *
 * Both steps are `useApiForm` forms (§3.6): the code, and the decision, which
 * Approve submits and Deny submits with `deny` set. A refusal is one sentence,
 * whatever the plugin said — an unknown, expired and spent code are all fixed
 * the same way, by running the command again — and lands on the code step's
 * root error.
 */
export function DeviceApproval() {
  const params = useSearchParams();
  const [step, setStep] = useState<Step>("enter");
  const [userCode, setUserCode] = useState("");

  const enter = useApiForm<z.infer<typeof enterSchema>>({
    schema: enterSchema,
    defaultValues: { code: params.get("user_code") ?? "" },
    onSubmit: async ({ code }) => {
      const asked = cleaned(code);
      const { error } = await device.lookUp(asked);
      if (error) {
        enter.setError("root", { type: "manual", message: UNKNOWN_CODE });
        return;
      }
      setUserCode(asked);
      setStep("confirm");
    },
  });

  const decide = useApiForm<z.infer<typeof decideSchema>>({
    schema: decideSchema,
    defaultValues: { decision: "approve" },
    onSubmit: async ({ decision }) => {
      const call = decision === "approve" ? device.approve : device.deny;
      const { error } = await call(userCode);
      if (error) {
        enter.setError("root", { type: "manual", message: UNKNOWN_CODE });
        setStep("enter");
        return;
      }
      setStep(decision === "approve" ? "approved" : "denied");
    },
  });
  const deciding = decide.formState.isSubmitting;

  if (step === "approved") {
    return (
      <AuthPanel title="Log in the Cloudgate CLI">
        <AuthOutcome tone="ok" icon="term" title="Your terminal is logged in">
          Go back to it: the command carries on by itself. Its key is in your
          Personal keys, and ends in 90 days.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  if (step === "denied") {
    return (
      <AuthPanel title="Log in the Cloudgate CLI">
        <AuthOutcome tone="info" icon="x" title="Login denied">
          The terminal that asked gets no key. You can close this page.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  if (step === "confirm") {
    return (
      <AuthPanel
        title="Log in the Cloudgate CLI"
        lede="Approve only if this is the code your own terminal is showing."
      >
        <FormProvider {...decide}>
          <form
            method="post"
            noValidate
            className="grid gap-4"
            onSubmit={decide.submit}
          >
            <FormError message={decide.rootError} />
            <p className="text-center font-mono text-sect tracking-code wrap-anywhere text-tx">
              {`${userCode.slice(0, 4)}-${userCode.slice(4)}`}
            </p>
            <p className="text-body text-tx-2">
              Approving gives that terminal a Personal key in your name, ending
              in 90 days.
            </p>
            <SubmitButton
              block
              pending={deciding}
              onClick={() => decide.setValue("decision", "approve")}
            >
              Approve
            </SubmitButton>
            <Button
              type="button"
              className="w-full"
              // `aria-disabled`, not `disabled` (§3.10): an action keeps its
              // place in the tab order while it is off, so the click is
              // refused here instead.
              aria-disabled={deciding || undefined}
              onClick={() => {
                if (deciding) return;
                decide.setValue("decision", "deny");
                void decide.submit();
              }}
            >
              Deny
            </Button>
          </form>
        </FormProvider>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      title="Log in the Cloudgate CLI"
      lede="Enter the code your terminal is showing."
    >
      <FormProvider {...enter}>
        <form
          method="post"
          noValidate
          className="grid gap-4"
          onSubmit={enter.submit}
        >
          <FormError message={enter.rootError} />
          <Field name="code" label="Code">
            {/* Set like the two-step code: a code is counted, not read, and
                the terminal shows it in capitals. */}
            <Input
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
              className="text-center font-mono text-lead tracking-code"
            />
          </Field>
          <SubmitButton block pending={enter.formState.isSubmitting}>
            Continue
          </SubmitButton>
        </form>
      </FormProvider>
    </AuthPanel>
  );
}
