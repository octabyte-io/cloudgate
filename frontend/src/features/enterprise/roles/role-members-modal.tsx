import { useState } from "react";

import { Modal } from "@/components/console/modal";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { ChangeRoleModal } from "@/features/members/change-role-modal";
import { errorMessage } from "@/lib/api/error-message";
import type { CustomRole, RoleMember } from "@/lib/api/endpoints/roles";
import { fullName } from "@/lib/format/person";

import { useRoleMembers } from "./use-custom-roles";

/**
 * Who holds a role.
 *
 * The list already carries `memberCount`, so this answers the *next* question —
 * and it is the question that has to be answered before a role can be deleted or
 * a licence released, because both of those leave whoever is on it stranded.
 *
 * Fetched on open rather than per row: `GET /custom-roles/:roleName/members` is
 * one request each, and ten roles on a screen would be ten requests to render a
 * number the listing already knows.
 *
 * `firstName`/`lastName` are the route's own columns and are frequently empty on
 * a real instance — an account created by an invitation has neither — so the
 * address is the identity and the name is the annotation, not the other way
 * round.
 *
 * With `changeRoles` (kept but stopped) each person gets "Change their
 * role", the Members screen's own dialog, because a role that allows nothing
 * leaves them signed in and unable to do anything until they are moved.
 */
export function RoleMembersModal({
  role,
  onClose,
  changeRoles = false,
}: {
  role: CustomRole;
  onClose: () => void;
  changeRoles?: boolean;
}) {
  const members = useRoleMembers(role.role);
  const [changing, setChanging] = useState<RoleMember | null>(null);

  if (changing) {
    return (
      <ChangeRoleModal
        member={{
          id: changing.id,
          role: role.role,
          user: {
            id: changing.userId,
            name: changing.firstName,
            lastName: changing.lastName,
            email: changing.email,
            image: null,
          },
        }}
        open
        onOpenChange={(next) => {
          if (!next) setChanging(null);
        }}
      />
    );
  }

  return (
    <Modal open onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={`Who holds ${role.role}`}
        description={`${role.memberCount} ${role.memberCount === 1 ? "member" : "members"} in this Organization.`}
      />
      <Modal.Body>
        {members.isPending ? (
          <div className="space-y-2.5" aria-busy="true">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : members.error ? (
          <p className="text-body wrap-anywhere text-tx">
            {errorMessage(members.error)}
          </p>
        ) : (
          <ul className="grid gap-2.5">
            {(members.data ?? []).map((member) => {
              const name = fullName(member);
              return (
                <li key={member.id} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-body wrap-anywhere text-tx">
                      {member.email}
                    </p>
                    {name ? (
                      <p className="text-meta text-tx-2">{name}</p>
                    ) : null}
                  </div>
                  {changeRoles ? (
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => setChanging(member)}
                    >
                      Change their role
                      <span className="sr-only">{` — ${member.email}`}</span>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" onClick={onClose}>
          Close
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
