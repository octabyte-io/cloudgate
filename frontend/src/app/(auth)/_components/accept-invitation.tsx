"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { KVList, KVRow } from "@/components/console/kv-list";
import { FormError } from "@/components/console/field";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { ApiError } from "@/lib/api/api-error";
import { organizationsApi } from "@/lib/api/endpoints/organizations";
import { keys } from "@/lib/api/keys";
import { errorMessage } from "@/lib/api/error-message";
import { AuthError, unwrap } from "@/lib/auth/auth-error";
import { organization, useSession } from "@/lib/auth/client";
import {
  CONSOLE_HOME,
  acceptInvitationPath,
  signInWithNext,
} from "@/lib/auth/routes";
import { useSignOut } from "@/lib/auth/use-sign-out";

import { AuthAction } from "./auth-action";
import { AuthLink } from "./auth-link";
import { AuthOutcome } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";
import { InvitationDoors } from "./invitation-doors";
import { InvitationRefused, NOT_THE_RECIPIENT } from "./invitation-refused";

/**
 * An invitation link.
 *
 * The one screen outside the console that is correct for a signed-in *and* a
 * signed-out visitor, which is why `src/proxy.ts` excludes it from the gate: bounce
 * a signed-in person to `/sign-in` and they lose the invitation; bounce them to the
 * console and they never see it. The signed-out half is `invitation-doors.tsx` and
 * the two ways it can be refused are `invitation-refused.tsx`.
 */
export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const { data: session, isPending: sessionPending } = useSession();
  // Both Sign outs here exist so someone can sign in as a different person —
  // the recipient — and bare `/sign-in` would drop them at the console home
  // with the invitation lost. Coming back is what "Sign in to accept"
  // already does for a signed-out visitor.
  const back = signInWithNext(acceptInvitationPath(invitationId));
  const { signOutNow, pending: signingOut } = useSignOut({ to: back });
  const [accepted, setAccepted] = useState(false);

  const invitation = useQuery({
    queryKey: keys.myInvitation(invitationId),
    queryFn: () =>
      unwrap(organization.getInvitation({ query: { id: invitationId } })),
    enabled: Boolean(session),
    // A pending invitation is not going to change while someone reads it, and a
    // retry here would repeat a refusal — 'not the recipient' answers the same way
    // every time.
    retry: false,
    staleTime: 60_000,
  });

  // better-auth reads pending invitations only, so every closed one is the same
  // 400 to it. Cloudgate's own state route says which way it closed, and
  // is asked only then: an open invitation needs nothing more, and a
  // wrong-account refusal is already the whole answer.
  const closed =
    invitation.isSuccess
      ? invitation.data === null
      : invitation.isError &&
        !(
          invitation.error instanceof ApiError &&
          invitation.error.code === NOT_THE_RECIPIENT
        );
  const state = useQuery({
    queryKey: keys.myInvitationState(invitationId),
    queryFn: () => organizationsApi.invitationState(invitationId),
    enabled: closed,
    retry: false,
    staleTime: 60_000,
  });

  const accept = useMutation({
    mutationFn: () => unwrap(organization.acceptInvitation({ invitationId })),
    onSuccess: () => setAccepted(true),
  });

  if (accepted) {
    return (
      <AuthPanel title="You are in">
        <AuthOutcome
          tone="ok"
          icon="check"
          title={`Welcome to ${invitation.data?.organizationName ?? "the Organization"}`}
          action={
            // `reload` is the point: accepting set the session's active
            // Organization on the backend, and the console has to be rendered
            // against that — not against the session this tab loaded with.
            <AuthAction href={CONSOLE_HOME} reload>
              Open the console
            </AuthAction>
          }
        >
          Your account has been added to it.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  if (
    sessionPending ||
    (session && invitation.isPending) ||
    (closed && state.isPending)
  ) {
    return (
      <AuthPanel title="Invitation">
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-16" />
          <Skeleton className="h-ctl" />
        </div>
      </AuthPanel>
    );
  }

  if (!session) return <InvitationDoors invitationId={invitationId} />;

  if (invitation.error) {
    return (
      <InvitationRefused
        error={state.error ?? invitation.error}
        state={state.data?.code}
        email={session.user.email}
        onSignOut={() => void signOutNow()}
        signingOut={signingOut}
      />
    );
  }

  const invite = invitation.data;
  // Neither pending nor errored, so there is a row — but the endpoint's own type
  // admits null, and inventing an empty card is worse than saying it is not open.
  if (!invite) {
    return (
      <InvitationRefused
        error={
          state.error ??
          new AuthError({ status: 400, code: "INVITATION_NOT_FOUND" })
        }
        state={state.data?.code}
        email={session.user.email}
        onSignOut={() => void signOutNow()}
        signingOut={signingOut}
      />
    );
  }

  return (
    <AuthPanel
      title="Join this Organization"
      lede={`${invite.inviterEmail} invited you to ${invite.organizationName}.`}
      footer={
        <span>
          Not {session.user.email}?{" "}
          <AuthLink
            href={back}
            onClick={(event) => {
              event.preventDefault();
              void signOutNow();
            }}
          >
            Sign out
          </AuthLink>
        </span>
      }
    >
      <div className="grid gap-4">
        <FormError
          message={accept.error ? errorMessage(accept.error) : undefined}
        />

        <KVList>
          <KVRow label="Organization" value={invite.organizationName} />
          <KVRow label="Your role" value={invite.role} />
          <KVRow
            label="Invited address"
            value={invite.email}
            title={invite.email}
          />
        </KVList>

        <SubmitButton
          block
          type="button"
          pending={accept.isPending}
          onClick={() => accept.mutate()}
        >
          Accept invitation
        </SubmitButton>
      </div>
    </AuthPanel>
  );
}
