import Link from "next/link";
import { useState } from "react";

import { Avatar } from "@/components/console/avatar";
import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { RowSub, RowTime } from "@/components/console/rows/cells";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import type {
  MemberDeactivation,
  MemberWithUser,
} from "@/lib/api/endpoints/organizations";
import { useSession } from "@/lib/auth/client";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import type { Mark } from "@/lib/design/status";
import { personName } from "@/lib/format/person";
import { counted } from "@/lib/format/plural";
import { settingsHref } from "@/lib/settings/sections";
import { timeExact } from "@/lib/format/time";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/design/icons";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { ChangeRoleModal } from "./change-role-modal";
import { InviteMemberModal } from "./invite-member-modal";
import { ManageAccessModal } from "./manage-access-modal";
import { splitMembers } from "./member-kinds";
import { RemoveMemberModal } from "./remove-member-modal";
import { useMembers } from "./use-members";

/**
 * Who is in this Organization, and the three things you can do about it.
 *
 * **The third is new**:
 * a role says what somebody may *do*, and the `accessed*` columns beside it say
 * what they may reach at all. `PATCH /organizations/members/:id/entitlements`
 * shipped with no caller, so until now those columns could only be
 * written by hand. `ManageAccessModal` is that caller, and it is offered on the
 * same rows as "Change role" for the same reason the other two are withheld:
 * owner and admin bypass the row-level check entirely, and the caller's own
 * grants are never consulted by a route only an owner or admin can reach — so
 * on those two rows it would be a guaranteed no-op rather than a refusal.
 *
 * **The rules about who may change what are the backend's, and this table does
 * not reimplement them** — it only stops offering a control that is *certainly*
 * refused, which is a different and much smaller claim.
 * `organizationsService.updateMemberRole` refuses four cases: changing your own
 * role, touching the owner, promoting anyone *to* owner, and an admin changing
 * another admin. Only the first two are knowable from this table's own data
 * (`member.role` and the session's user id), so those two rows lose their
 * buttons with the reason in place. The other two are left to the API, because
 * deciding them here would need the caller's own role — which is on a row this
 * screen may not be able to see — and a screen that guesses wrong hides a
 * control that would have worked.
 *
 * The date is the **membership's** `createdAt`, not the account's: "in this
 * Organization since" is the question a member list answers, and the two differ
 * by however long somebody was in another one first.
 *
 * **A deactivated member is marked, not hidden**
 * An identity
 * provider's `active: false` bans the account and keeps the membership, so the
 * row stays — and it used to read exactly like an active one, which made this
 * table wrong about who can get in. The row keeps its buttons: Remove is the
 * cleanup a leaver's row is waiting for, and a role or grant change on a banned
 * account is harmless and takes effect if they come back.
 *
 * **Agents are not listed**.
 * An Agent is a member row, so the roster carries it — with a synthetic
 * address that must never render — but Change role, Manage access and Remove
 * are person actions here (Remove would leave an Agent's user and keys behind),
 * and an Agent's live in the Agents section. One footer line counts them and
 * links there, so someone who looks for an Agent here still finds it.
 *
 * **Every one of those controls is off for a role that cannot use it**
 * by
 * `usePermission`'s rule: Invite reads `invitation: ['create']` (better-auth's
 * own check on `POST /organizations/invitations`), Remove `member: ['delete']`
 * (better-auth's `removeMember`), Manage access the `member: ['update']` its
 * route's `@RequirePermission` names, and Change role the same statement —
 * `updateMemberRole` admits owner and admin only, and both hold it. That is a
 * different claim from the one the paragraph above declines to make: it does
 * not decide the backend's four cases, only that a caller without the
 * statement is refused by every one of them.
 */
export function MembersCard() {
  const members = useMembers();
  const { data: session } = useSession();
  const [inviting, setInviting] = useState(false);
  const [changing, setChanging] = useState<MemberWithUser | null>(null);
  const [removing, setRemoving] = useState<MemberWithUser | null>(null);
  const [granting, setGranting] = useState<MemberWithUser | null>(null);

  const myUserId = session?.user?.id;
  const canInvite = usePermission({ invitation: ["create"] });
  const canChange = usePermission({ member: ["update"] });
  const canRemove = usePermission({ member: ["delete"] });

  const arrival = useArrival(members.isPending);
  if (members.isPending) return <SectionPending title="Members" rows={3} />;
  if (members.error) {
    return (
      <SectionFailed title="Members" error={members.error}>
        Only members of this Organization can read its roster, so this can also
        mean the session is pointed somewhere you are not a member of.
      </SectionFailed>
    );
  }

  // Agents are members too, and are managed in their own section:
  // leaving them out here is what keeps every action below off an Agent.
  const { people: rows, agentCount } = splitMembers(
    members.data?.members ?? [],
  );

  return (
    <Card className={arrival}>
      <Card.Header
        title="Members"
        sub={`${rows.length} ${rows.length === 1 ? "person" : "people"} in this Organization.`}
        headingLevel={2}
        actions={
          <Button
            size="sm"
            variant="pri"
            disabled={!canInvite.allowed}
            title={canInvite.allowed ? undefined : INVITE_REFUSAL}
            onClick={() => canInvite.allowed && setInviting(true)}
          >
            <Icon name="plus" size={14} />
            Invite someone
          </Button>
        }
      />
      <Card.Body flush>
        <DataTable<MemberWithUser>
          label="Members of this Organization"
          rows={rows}
          getRowId={(row) => row.id}
          empty={
            <EmptyState
              icon="users"
              title="No members"
              action={
                <Button
                  size="sm"
                  variant="pri"
                  disabled={!canInvite.allowed}
                  title={canInvite.allowed ? undefined : INVITE_REFUSAL}
                  onClick={() => canInvite.allowed && setInviting(true)}
                >
                  <Icon name="plus" size={14} />
                  Invite someone
                </Button>
              }
            >
              Invite someone to give them access to this Organization.
            </EmptyState>
          }
          columns={[
            {
              id: "person",
              head: "Person",
              tone: "key",
              cell: (row) => (
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar
                    person={row.user}
                    className={cn("size-7", row.deactivation && "grayscale")}
                  />
                  <span className="block min-w-0">
                    <span
                      className={cn(
                        "flex flex-wrap items-center gap-1.75",
                        row.deactivation && "text-tx-3",
                      )}
                    >
                      {personName(row.user)}
                      {row.userId === myUserId ? (
                        <Chip variant="brand">You</Chip>
                      ) : null}
                      {row.deactivation ? (
                        <StatusPill mark={DEACTIVATED} />
                      ) : null}
                    </span>
                    <RowSub>{row.user.email}</RowSub>
                    {row.deactivation ? (
                      <RowSub>{deactivationLine(row.deactivation)}</RowSub>
                    ) : null}
                  </span>
                </span>
              ),
              compare: (a, b) => a.user.email.localeCompare(b.user.email),
            },
            {
              id: "role",
              head: "Role",
              cell: (row) => <Chip>{row.role}</Chip>,
              compare: (a, b) => a.role.localeCompare(b.role),
            },
            {
              id: "since",
              head: "Member since",
              cell: (row) => <RowTime iso={row.createdAt} />,
              compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
            },
            {
              id: "actions",
              head: <span className="sr-only">Actions</span>,
              className: "w-72 text-right",
              cell: (row) => {
                const isSelf = row.userId === myUserId;
                const isOwner = row.role === "owner";
                if (isOwner) {
                  return (
                    <span className="text-meta text-tx-3">
                      The owner cannot be changed
                    </span>
                  );
                }
                if (isSelf) {
                  return (
                    <span className="text-meta text-tx-3">
                      You cannot change your own role
                    </span>
                  );
                }
                return (
                  <span className="flex flex-wrap justify-end gap-1.5">
                    <Button
                      type="button"
                      size="xs"
                      disabled={!canChange.allowed}
                      title={canChange.allowed ? undefined : CHANGE_REFUSAL}
                      onClick={() => canChange.allowed && setChanging(row)}
                    >
                      Change role
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      disabled={!canChange.allowed}
                      title={canChange.allowed ? undefined : ACCESS_REFUSAL}
                      onClick={() => canChange.allowed && setGranting(row)}
                    >
                      Manage access
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="dngr"
                      disabled={!canRemove.allowed}
                      title={canRemove.allowed ? undefined : REMOVE_REFUSAL}
                      onClick={() => canRemove.allowed && setRemoving(row)}
                    >
                      Remove
                    </Button>
                  </span>
                );
              },
            },
          ]}
        />
      </Card.Body>
      {agentCount > 0 ? (
        <Card.Footer>
          {counted(agentCount, "Agent is", "Agents are")} managed in{" "}
          <Link
            href={settingsHref("agents")}
            className="text-brand-tx underline-offset-2 hover:underline"
          >
            Agents
          </Link>
          .
        </Card.Footer>
      ) : null}

      {/* Held at card level rather than inside a row: a dialog mounted in a cell
          unmounts the moment the table re-sorts under it (F08's rule). */}
      {inviting ? (
        <InviteMemberModal key="invite" open onOpenChange={setInviting} />
      ) : null}
      {changing ? (
        <ChangeRoleModal
          key={changing.id}
          member={changing}
          open
          onOpenChange={(next: boolean) => {
            if (!next) setChanging(null);
          }}
        />
      ) : null}
      {granting ? (
        <ManageAccessModal
          key={granting.id}
          member={granting}
          open
          onOpenChange={(next: boolean) => {
            if (!next) setGranting(null);
          }}
        />
      ) : null}
      {removing ? (
        <RemoveMemberModal
          key={removing.id}
          member={removing}
          open
          onOpenChange={(next: boolean) => {
            if (!next) setRemoving(null);
          }}
        />
      ) : null}
    </Card>
  );
}

const INVITE_REFUSAL = roleRefusal("invite someone");
const CHANGE_REFUSAL = roleRefusal("change someone's role");
const ACCESS_REFUSAL = roleRefusal("change what someone can reach");
const REMOVE_REFUSAL = roleRefusal("remove someone from this Organization");

const DEACTIVATED: Mark = { glyph: "⊘", tone: "bad", label: "deactivated" };

/**
 * The sentence under a deactivated member's address: who did it, and so where
 * it is undone.
 *
 * The directory's ban gets its own wording rather than its stored reason
 * (`"Deactivated via SCIM"`, which is the same fact in the plugin's words)
 * because the part an owner needs is that nothing on this screen reverses it —
 * the identity provider does, by sending `active: true`. Any other ban is not
 * one the console can lift either, so its reason and end are said as stored.
 */
function deactivationLine(deactivation: MemberDeactivation): string {
  if (deactivation.byDirectory) {
    return "Deactivated by your identity provider over SCIM, so they cannot sign in. Only the directory can reactivate them.";
  }
  const until = deactivation.expiresAt
    ? ` until ${timeExact(deactivation.expiresAt)}`
    : "";
  const reason = deactivation.reason ? `: ${deactivation.reason}` : "";
  return `Cannot sign in${until}${reason}`;
}
