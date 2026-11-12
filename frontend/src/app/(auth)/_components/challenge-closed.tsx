import { signInWithNext } from "@/lib/auth/routes";

import { AuthAction } from "./auth-action";
import { AuthOutcome } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";

/**
 * The 2FA challenge is over, and the only way on is to start again.
 *
 * Three different endings arrive here, and they are not the same fact — one is a
 * timeout, one is a spent budget of attempts, one is a locked account with a
 * duration attached. Collapsing them into "something went wrong" would hide the
 * only part that decides what to do next: whether waiting is required.
 *
 * The way out is a **link to sign in**, not a retry: better-auth has expired the
 * two-factor cookie in all three cases, so there is nothing on the previous screen
 * left to submit to.
 *
 * ## The three sentences below are deliberate duplicates of `AUTH_SENTENCES`
 *
 * H-49 asked whether they should collapse into the map, and the answer is no —
 * written down here so the next reader does not re-file it. All three codes are
 * in `lib/auth/auth-error.ts`, and this component says the same facts in
 * different words:
 *
 * | code | `AUTH_SENTENCES` | here |
 * |---|---|---|
 * | `ACCOUNT_TEMPORARILY_LOCKED` | "Too many wrong codes, so this account is locked for 15 minutes. Wait, then sign in again." | "Too many wrong codes" + "This account is locked for 15 minutes. Wait, then sign in again." |
 * | `TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE` | "Too many wrong codes, so this sign-in attempt is closed. Sign in again to start a new one." | "Too many wrong codes" + "This sign-in attempt is closed. Sign in again to start a new one." |
 * | `INVALID_TWO_FACTOR_COOKIE` | "This sign-in attempt has expired. Sign in again to get a new code prompt." | "This attempt has expired" + "Two-step verification does not stay open for long. Sign in again to get a new code prompt." |
 *
 * **This is not a second vocabulary; it is the same sentence laid out.** An
 * `AuthOutcome` is a heading and a body, and the map's entries are each a cause
 * clause welded to a consequence — so the panel puts the cause in the heading and
 * the consequence in the body, and rendering the map entry underneath would print
 * "Too many wrong codes" twice, once as its own heading and again as the first
 * four words beneath it. The third row is the same decision seen from the other
 * side: the heading already carries the fact, so the body says *why* two-step
 * verification closed rather than repeating that it did.
 *
 * The reason the map's version cannot simply be reshaped to suit is that it has
 * another reader who gets no heading: `errorMessage()` renders it into a toast
 * or a form's root error, one string and nothing else, where a bare "This account
 * is locked for 15 minutes" is missing the cause. Both are right for their own
 * surface, and a sentence is not the same kind of thing as a heading plus a body.
 *
 * **Rejected: `authSentence()` here, with the headings dropped.** That is a
 * `Card`-shaped answer to an `AuthOutcome`-shaped component — §3.10's terminal
 * states are titled, and this one's `tone` and `icon` are chosen from the same
 * fact the title states. Losing the title to remove a duplication would cost the
 * screen more than the duplication costs it.
 */
export function ChallengeClosed({
  code,
  next,
}: {
  code: string;
  next: string;
}) {
  const locked = code === "ACCOUNT_TEMPORARILY_LOCKED";

  return (
    <AuthPanel title={locked ? "Account locked" : "Sign-in attempt closed"}>
      <AuthOutcome
        tone={locked ? "bad" : "warn"}
        icon={locked ? "lock" : "clock"}
        title={
          locked
            ? "Too many wrong codes"
            : code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"
              ? "Too many wrong codes"
              : "This attempt has expired"
        }
        action={
          <AuthAction href={signInWithNext(next)}>Back to sign in</AuthAction>
        }
      >
        {locked
          ? "This account is locked for 15 minutes. Wait, then sign in again."
          : code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"
            ? "This sign-in attempt is closed. Sign in again to start a new one."
            : "Two-step verification does not stay open for long. Sign in again to get a new code prompt."}
      </AuthOutcome>
    </AuthPanel>
  );
}
