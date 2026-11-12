import { SubmitButton } from "@/components/console/submit-button";
import { ApiError } from "@/lib/api/api-error";
import type { InvitationState } from "@/lib/api/endpoints/organizations";
import { errorMessage } from "@/lib/api/error-message";
import { CONSOLE_HOME } from "@/lib/auth/routes";
import type { IconName } from "@/lib/design/icons";

import { AuthAction } from "./auth-action";
import { AuthOutcome, type OutcomeTone } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";

/**
 * The code both better-auth's `getInvitation` and Cloudgate's state route
 * refuse the wrong account with — one spelling, published by both (H-36).
 */
export const NOT_THE_RECIPIENT = "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION";

type Closed = {
  panel: string;
  tone: OutcomeTone;
  icon: IconName;
  title: string;
  body: string;
};

/**
 * One sentence per way an invitation closes, keyed on the code
 * `GET /organizations/invitations/:id/state` answers with.
 *
 * **"Withdrawn" is two codes, and only one of them is ever what the console
 * did.** Revoke and Delete on the Members screen hard-delete the row, so an
 * invitation withdrawn there reads `INVITATION_NOT_FOUND` — indistinguishable
 * from a link that was never an invitation, or one deleted after it was
 * accepted. That sentence says so rather than claiming "withdrawn".
 * `INVITATION_WITHDRAWN` is better-auth's `canceled` status, written only by its
 * own cancel route; it is still an answer the route can give, so it has words.
 */
const CLOSED: Partial<Record<InvitationState["code"], Closed>> = {
  INVITATION_ALREADY_ACCEPTED: {
    panel: "Already accepted",
    tone: "ok",
    icon: "check",
    title: "You already accepted this invitation",
    body: "An invitation is used once, and this account has used this one. The console will let you in — unless you have been removed from the Organization since, in which case ask for a new invitation.",
  },
  INVITATION_EXPIRED: {
    panel: "Invitation expired",
    tone: "bad",
    icon: "clock",
    title: "This invitation has expired",
    body: "It was not accepted in time, so it can no longer be used. Ask whoever invited you to send a new one.",
  },
  INVITATION_REJECTED: {
    panel: "Invitation declined",
    tone: "warn",
    icon: "x",
    title: "You declined this invitation",
    body: "A declined invitation cannot be accepted afterwards. If you have changed your mind, ask whoever invited you to send a new one.",
  },
  INVITATION_WITHDRAWN: {
    panel: "Invitation withdrawn",
    tone: "bad",
    icon: "x",
    title: "This invitation was withdrawn",
    body: "Whoever sent it called it back, so it can no longer be used. Ask them for a new one if you still need access.",
  },
  INVITATION_NOT_FOUND: {
    panel: "Invitation not found",
    tone: "bad",
    icon: "x",
    title: "This invitation no longer exists",
    body: "It was withdrawn, or removed after it was used, or the link is incomplete — Cloudgate keeps nothing of a withdrawn invitation, so it cannot tell which. If you are already a member, the console will let you in; otherwise ask for a new invitation.",
  },
};

/**
 * The invitation cannot be accepted, and why changes what to do — so each reason
 * is its own message.
 *
 * `state` is what the state route answered; `error` is the refusal the page got,
 * from better-auth's read or from the state route itself.
 */
export function InvitationRefused({
  error,
  state,
  email,
  onSignOut,
  signingOut,
}: {
  error: unknown;
  state?: InvitationState["code"];
  email: string;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const wrongAccount =
    error instanceof ApiError && error.code === NOT_THE_RECIPIENT;

  if (wrongAccount) {
    return (
      <AuthPanel title="Wrong account">
        <AuthOutcome
          tone="warn"
          icon="user"
          title="This invitation was sent to someone else"
          action={
            <SubmitButton
              block
              type="button"
              pending={signingOut}
              onClick={onSignOut}
            >
              Sign out
            </SubmitButton>
          }
        >
          You are signed in as {email}. Sign out, then sign in as the person it was
          sent to.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  const closed = state ? CLOSED[state] : undefined;
  const openConsole = (
    <AuthAction href={CONSOLE_HOME} reload>
      Open the console
    </AuthAction>
  );

  if (closed) {
    return (
      <AuthPanel title={closed.panel}>
        <AuthOutcome
          tone={closed.tone}
          icon={closed.icon}
          title={closed.title}
          action={openConsole}
        >
          {closed.body}
        </AuthOutcome>
      </AuthPanel>
    );
  }

  // The state route could not be read, or answered a code with no sentence
  // above (`INVITATION_PENDING` while better-auth refused anyway). Either way
  // nothing says which way it closed, so this names the refusal it has rather
  // than guessing one of the states.
  return (
    <AuthPanel title="Invitation is not open">
      <AuthOutcome
        tone="bad"
        icon="clock"
        title="This invitation cannot be used"
        action={openConsole}
      >
        Cloudgate could not read what became of it. {errorMessage(error)}
      </AuthOutcome>
    </AuthPanel>
  );
}
