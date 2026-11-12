import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { CopyButton } from "@/components/console/copy-button";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { RowTime } from "@/components/console/rows/cells";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import type { Invitation } from "@/lib/api/endpoints/organizations";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { invitationLink } from "./invite-member-modal";
import { RevokeInvitationModal } from "./revoke-invitation-modal";
import { useInvitations } from "./use-members";

/**
 * Invitations that have been created, and what has become of them.
 *
 * **"Resend" is not here, and there is nothing to replace it with.** The phase
 * brief asks for resend and revoke; resend would mean re-sending an email, and
 * this instance sends none
 * (`auth.config.ts` registers the organization plugin with no
 * `sendInvitationEmail`). There is also no route that re-issues or extends an
 * invitation: `POST /organizations/invitations` creates a new row and nothing
 * touches an existing one's `expiresAt`. So the control that *does* the job is
 * **Copy link**, on every pending row — which is the same thing resend would
 * have achieved, done by the only mechanism that exists.
 *
 * **Revoke and Delete both ask first**
 * Neither closes
 * the invitation: `OrganizationsService.removeInvitation` deletes the row, so a
 * link already passed on stops working and nothing reissues it. That is
 * `RevokeInvitationModal`, which is also where the difference between revoking a
 * live invitation and clearing a spent one is written down.
 *
 * The status comes from the row and is rendered as a `mark` rather than a
 * `status`: `pending` / `accepted` / `rejected` / `canceled` is better-auth's
 * vocabulary, not `deployment.status`, and borrowing our enum's pills would put
 * a build's words on an invitation. An **expired** row is derived here, because
 * the column never says so — better-auth leaves `status: "pending"` and lets
 * `expiresAt` pass, and a stale
 * pending invitation is what happens when nobody looks at the date.
 */
export function InvitationsCard() {
  const invitations = useInvitations();
  // `removeInvitation` admits owner and admin only, and both hold
  // `invitation: ['cancel']` — the statement a Revoke and a Delete are.
  const canCancel = usePermission({ invitation: ["cancel"] });
  /** The row a confirmation is open for — see `RevokeInvitationModal`. */
  const [confirming, setConfirming] = useState<Invitation | null>(null);

  const arrival = useArrival(invitations.isPending);
  if (invitations.isPending) {
    return <SectionPending title="Invitations" rows={2} />;
  }
  if (invitations.error) {
    return (
      <SectionFailed title="Invitations" error={invitations.error}>
        This list is scoped to the Organization the session is pointed at.
      </SectionFailed>
    );
  }

  const rows = invitations.data ?? [];

  return (
    <Card className={arrival}>
      <Card.Header
        title="Invitations"
        sub="Everyone who has been asked and has not joined yet."
        headingLevel={2}
      />
      <Card.Body flush>
        <DataTable<Invitation>
          label="Invitations to this Organization"
          rows={rows}
          getRowId={(row) => row.id}
          empty={
            <EmptyState icon="mail" title="No invitations yet">
              Invite someone from Members, and the invitation appears here with a
              link to pass on.
            </EmptyState>
          }
          columns={[
            {
              id: "email",
              head: "Email",
              tone: "key",
              cell: (row) => row.email,
              compare: (a, b) => a.email.localeCompare(b.email),
            },
            {
              id: "role",
              head: "Role",
              cell: (row) => <Chip>{row.role ?? "member"}</Chip>,
            },
            {
              id: "status",
              head: "State",
              cell: (row) => {
                const state = invitationState(row);
                return <StatusPill mark={INVITATION_MARKS[state]} />;
              },
            },
            {
              id: "expires",
              head: "Expires",
              cell: (row) => <RowTime iso={row.expiresAt} />,
              compare: (a, b) => a.expiresAt.localeCompare(b.expiresAt),
            },
            {
              id: "actions",
              head: <span className="sr-only">Actions</span>,
              className: "w-40 text-right",
              cell: (row) => {
                const state = invitationState(row);
                if (state !== "pending") {
                  return (
                    <Button
                      type="button"
                      size="xs"
                      variant="dngr"
                      disabled={!canCancel.allowed}
                      title={canCancel.allowed ? undefined : CANCEL_REFUSAL}
                      onClick={() => canCancel.allowed && setConfirming(row)}
                    >
                      Delete
                    </Button>
                  );
                }
                return (
                  <span className="flex items-center justify-end gap-1.5">
                    <CopyButton
                      value={invitationLink(row.id)}
                      label={`invitation link for ${row.email}`}
                      size="icon-xs"
                    />
                    <Button
                      type="button"
                      size="xs"
                      variant="dngr"
                      disabled={!canCancel.allowed}
                      title={canCancel.allowed ? undefined : CANCEL_REFUSAL}
                      onClick={() => canCancel.allowed && setConfirming(row)}
                    >
                      Revoke
                    </Button>
                  </span>
                );
              },
            },
          ]}
        />
      </Card.Body>
      <Card.Footer>
        This instance sends no email. Copy a pending invitation&rsquo;s link and
        pass it on yourself.
      </Card.Footer>

      {confirming ? (
        <RevokeInvitationModal
          key={confirming.id}
          invitation={confirming}
          live={invitationState(confirming) === "pending"}
          open
          onOpenChange={(next: boolean) => {
            if (!next) setConfirming(null);
          }}
        />
      ) : null}
    </Card>
  );
}

const CANCEL_REFUSAL = roleRefusal("withdraw or delete an invitation");

type InvitationState = "pending" | "expired" | "accepted" | "closed";

/**
 * An invitation's real state, which is its `status` **and** its date.
 *
 * `accept-invitation` refuses an expired row with the same
 * `INVITATION_NOT_FOUND` it uses for one that was never there, so the date
 * is the only thing that distinguishes "they still can" from "they can no
 * longer" — and a list showing a fortnight-old row as pending is the list
 * somebody chases a colleague from.
 */
function invitationState(row: Invitation): InvitationState {
  if (row.status === "accepted") return "accepted";
  if (row.status !== "pending") return "closed";
  return Date.parse(row.expiresAt) < Date.now() ? "expired" : "pending";
}

const INVITATION_MARKS = {
  pending: { glyph: "○", tone: "warn", label: "waiting" },
  expired: { glyph: "⊘", tone: "mute", label: "expired" },
  accepted: { glyph: "●", tone: "ok", label: "accepted" },
  closed: { glyph: "⊘", tone: "mute", label: "closed" },
} as const;
