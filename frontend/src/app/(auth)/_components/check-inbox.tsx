import { useEffect, useRef, useState } from "react";

import { SubmitButton } from "@/components/console/submit-button";
import { errorMessage } from "@/lib/api/error-message";
import { unwrap } from "@/lib/auth/auth-error";
import { sendVerificationEmail } from "@/lib/auth/client";
import {
  SIGN_IN_PATH,
  confirmedCallbackPath,
  isGetStartedPath,
  withNext,
} from "@/lib/auth/routes";

import { AuthAction } from "./auth-action";
import { AuthOutcome } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";

/**
 * After a Hosted sign-up: the account and its Organization exist, but
 * it cannot sign in until the link in the confirmation email is followed. So
 * this is the whole screen, with one way to get another email. Following the
 * link signs them in and lands on `next` (`confirmedCallbackPath`), which a
 * second email carries too, so a deep link such as the get-started wizard's
 * survives the trip through the inbox.
 *
 * It names the address, unlike `/forgot-password`'s "if there is an account":
 * the person typed it seconds ago, and a typo is the likeliest reason no email
 * arrives. The backend answers a taken address exactly as a new one, so naming
 * it tells them nothing they did not send.
 */
export function CheckInbox({ email, next }: { email: string; next: string }) {
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // The form this replaced had focus; it is gone.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function resend() {
    setSending(true);
    setNote(null);
    try {
      await unwrap(
        sendVerificationEmail({
          email,
          callbackURL: confirmedCallbackPath(next),
        }),
      );
      setNote({ ok: true, text: `A new link is on its way to ${email}.` });
    } catch (error) {
      setNote({ ok: false, text: errorMessage(error) });
    } finally {
      setSending(false);
    }
  }

  return (
    <AuthPanel title="Check your inbox">
      <AuthOutcome
        tone="ok"
        icon="mail"
        title="Confirm your email to finish signing up"
        headingRef={heading}
        action={
          <div className="grid gap-2">
            <SubmitButton
              type="button"
              variant="gh"
              block
              pending={sending}
              onClick={() => void resend()}
            >
              Send the link again
            </SubmitButton>
            <AuthAction href={withNext(SIGN_IN_PATH, next)}>
              Go to sign in
            </AuthAction>
          </div>
        }
      >
        We sent a link to {email}. Open it to confirm the address and you
        will be signed in
        {isGetStartedPath(next) ? ", ready to deploy your app" : ""}. Until
        then the account cannot be used.
      </AuthOutcome>
      {note ? (
        <p
          role="status"
          className={
            note.ok
              ? "mt-3 animate-fade text-center text-body text-tx-2"
              : "mt-3 animate-fade text-center text-body wrap-anywhere text-bad"
          }
        >
          {note.text}
        </p>
      ) : null}
    </AuthPanel>
  );
}
