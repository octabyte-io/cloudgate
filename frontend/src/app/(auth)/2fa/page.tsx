import type { Metadata } from "next";
import { Suspense } from "react";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { hasTwoFactorChallenge } from "@/lib/auth/two-factor-cookie";

import { AuthAction } from "../_components/auth-action";
import { AuthFallback } from "../_components/auth-fallback";
import { AuthOutcome } from "../_components/auth-outcome";
import { AuthPanel } from "../_components/auth-panel";
import { TwoFactorForm } from "../_components/two-factor-form";

export const metadata: Metadata = { title: "Two-step verification" };

/**
 * The second half of a sign-in.
 *
 * A server component, unusually for this group, because it asks a question only
 * the server can: **is there a challenge in progress?** The `two_factor` cookie is
 * `httpOnly`, so checking it here is what lets someone who opened `/2fa` out of
 * curiosity — or came back to it hours later — read a sentence instead of a code
 * box that is certain to be refused.
 *
 * The form still handles the same ending itself: the cookie can expire between this
 * render and the submit, and only the submit finds that out.
 */
export default async function TwoFactorPage() {
  if (!(await hasTwoFactorChallenge())) {
    return (
      <AuthPanel title="Nothing to verify">
        <AuthOutcome
          tone="info"
          icon="key"
          title="No sign-in is waiting on a code"
          action={<AuthAction href={SIGN_IN_PATH}>Go to sign in</AuthAction>}
        >
          This screen is the second step of signing in. Start with your email and
          password, and it will ask for a code if the account needs one.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  return (
    <Suspense fallback={<AuthFallback />}>
      <TwoFactorForm />
    </Suspense>
  );
}
