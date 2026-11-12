// No `"use client"`, for the reason `change-role-modal.tsx` sets out at length:
// the directive marks an entry point a Server Component imports, and
// this dialog's only importer is `members-card.tsx`, which is already one.
// Keeping it here would make `onOpenChange` a serializability error (71007) for
// a callback that never crosses the network.

import { AccessModal } from "@/components/console/access-modal";
import type { MemberWithUser } from "@/lib/api/endpoints/organizations";
import { personName } from "@/lib/format/person";

/**
 * What this person may reach — the three `accessed*` columns, edited in the
 * console.
 *
 * `PATCH /organizations/members/:id/entitlements` landed and nothing
 * called it, so until now an owner could only grant a Member a Service by
 * issuing the PATCH by hand — which left the hole still open from the
 * product's side. This is the caller.
 *
 * **Three columns rather than one**, because `checkProjectAccess`,
 * `checkEnvironmentAccess` and `checkServiceAccess` are three independent
 * row-level checks: a Service grant on its own leaves the Member unable to
 * navigate to the thing they were granted. The cascade in
 * `lib/auth/access-grants.ts` is what makes that structural instead of
 * advisory — ticking travels up, unticking travels down, and the dialog cannot
 * express the broken state at all.
 *
 * **The whole set goes back on every save, never a diff** — the route replaces
 * per column, so an omitted id is a revoked id. See `access-grants.ts` for that
 * and for the second half of it: `assertGrantsResolve` refuses the *entire*
 * write on one id that no longer resolves, and a `member` row keeps ids for
 * deleted rows, so the set is whole and filtered rather than whole.
 *
 * The tree and its reads are `components/console/access-tree.tsx`, shared with
 * the Agents section's create dialog and rows, and the dialog itself —
 * seed, stranded ids, save — is `components/console/access-modal.tsx`, shared
 * with the Agent's Manage access. This file is the Member half: the
 * person's name and wording, and the admin notice.
 *
 * ## Why the fan-out is bounded by the grant
 *
 * There is no flat "every Service in this Organization" route — `GET
 * /environments/:id` is the only roster in the API, and `listByProject`
 * deliberately carries no services. So Environments are read for the
 * **ticked** Projects and Services for the **ticked** Environments. Reading the
 * whole Organization would cost 40 + N requests to open a dialog about three
 * ticks, and the unticked scopes hold nothing that can be granted anyway.
 *
 * ## Which rows do not get this dialog
 *
 * `members-card.tsx` does not offer it on the owner row or your own row, both of
 * which already replace their buttons with a sentence. Neither is a judgement
 * call: owner and admin skip the row-level check entirely
 * (`checkServiceAccess:151`), and only an owner or admin can reach this route,
 * so the caller's own grants are never consulted. An **admin** row does get it,
 * with the notice below, because an admin can be moved to member later and the
 * grants are real data in the meantime.
 */
export function ManageAccessModal({
  member,
  open,
  onOpenChange,
}: {
  member: MemberWithUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const name = personName(member.user);

  return (
    <AccessModal
      memberId={member.id}
      held={member}
      name={name}
      subject="person"
      title={`Manage ${name}'s access`}
      description="Which Projects, Environments and Services this person may reach. Their role decides what they can do; this decides what they can see at all."
      open={open}
      onOpenChange={onOpenChange}
    >
      {member.role === "admin" ? (
        <div className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-3 text-body text-tx">
          <p className="font-medium">This person is an admin.</p>
          <p className="mt-1">
            None of these grants is checked while they hold that role. They
            apply if they are moved to member or to a custom role.
          </p>
        </div>
      ) : null}

      <p className="text-body text-tx-2">
        A Member reaches a Service through its Project and its Environment, so
        granting one grants the two above it.
      </p>
    </AccessModal>
  );
}
