import { useQuery } from "@tanstack/react-query";

import {
  invitationPreview,
  type InvitationPreview,
} from "@/lib/api/endpoints/auth";
import { keys } from "@/lib/api/keys";
import { SIGN_IN_PATH } from "@/lib/auth/routes";

import { AuthAction } from "./auth-action";
import { AuthOutcome } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";

/**
 * **An invitation link is checked when its page loads**.
 *
 * Signed out, `/accept-invitation/<id>` said "You have been invited" for any id,
 * and "Create an account" led to a full sign-up form that only refused the id
 * after it was submitted. This asks `GET /auth/invitations/:id` first, so the
 * landing page and the form both know whether there is anything to accept — and,
 * when there is, which Organization it is and which address it was sent to.
 *
 * `undefined` while the read is in flight and when it failed: a failed read is
 * not a verdict on the invitation, so the screens fall back to what they said
 * before (the doors, the plain form) and the sign-up's own check still applies.
 */
export function useInvitationPreview(
  invitationId: string | null,
): { ready: boolean; preview: InvitationPreview | undefined } {
  const query = useQuery({
    queryKey: keys.invitationPreview(invitationId ?? ""),
    queryFn: ({ signal }) => invitationPreview(invitationId ?? "", signal),
    enabled: Boolean(invitationId),
    // Retrying a "not open" answer would only repeat it.
    retry: false,
    staleTime: 60_000,
  });
  if (!invitationId) return { ready: true, preview: undefined };
  return { ready: !query.isPending, preview: query.data };
}

/** The whole page for an invitation link that cannot be used. */
export function InvitationNotOpen({
  code,
}: {
  code: "INVITATION_EXPIRED" | "INVITATION_NOT_OPEN";
}) {
  const expired = code === "INVITATION_EXPIRED";
  return (
    <AuthPanel title={expired ? "Invitation expired" : "Invitation not valid"}>
      <AuthOutcome
        tone="bad"
        icon={expired ? "clock" : "x"}
        title={
          expired
            ? "This invitation has expired"
            : "This invitation link is not valid"
        }
        action={<AuthAction href={SIGN_IN_PATH}>Go to sign in</AuthAction>}
      >
        {expired
          ? "It was not accepted in time, so it can no longer be used. Ask whoever invited you to send a new one."
          : "It has already been used, was withdrawn, or the link is incomplete. If you already have an account, sign in; otherwise ask whoever invited you for a new invitation."}
      </AuthOutcome>
    </AuthPanel>
  );
}
