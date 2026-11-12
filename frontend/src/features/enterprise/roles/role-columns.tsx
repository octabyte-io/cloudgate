import { Chip } from "@/components/console/chip";
import type { Column } from "@/components/console/data-table";
import { RowSub, RowTime } from "@/components/console/rows/cells";
import { Button } from "@/components/ui/button";
import type { CustomRole } from "@/lib/api/endpoints/roles";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import type { Stopped } from "../business-plan";
import { countGrants } from "./use-custom-roles";

/**
 * One row per role, and **the actions are absent without a licence** rather than
 * disabled.
 *
 * The list itself still renders — that is the whole design of this screen, since a
 * member holding a custom role is denied everything without a licence and the
 * banner above has to be able to count them. But Edit and Delete both call routes
 * that run `ensureEnterprise`, so offering them would be offering a refusal.
 *
 * The member count is a control only when it is not zero: `0` is a fact, not
 * somewhere to go.
 *
 * **Kept but stopped** is the other unlicensed state: the roles were
 * defined while the paid features were on, and now allow nothing. Each says
 * so ("Allows nothing on Starter"), the people on one get "Change their role"
 * beside the count, since moving them is the one job an owner has here, Edit
 * is off with why, and Delete stays on (removing is always allowed).
 */
export function roleColumns({
  licensed,
  stopped,
  onEdit,
  onDelete,
  onShowMembers,
}: {
  licensed: boolean;
  /** Kept but stopped: where ("on Starter") and why Edit is off. */
  stopped?: Stopped | null;
  onEdit: (role: CustomRole) => void;
  onDelete: (role: CustomRole) => void;
  onShowMembers: (role: CustomRole) => void;
}): Column<CustomRole>[] {
  return [
    {
      id: "role",
      head: "Role",
      tone: "key",
      cell: (row) => (
        <span className="block min-w-0">
          {row.role}
          {stopped ? (
            <Chip variant="warn" className="ml-1.75">
              Allows nothing {stopped.where}
            </Chip>
          ) : null}
          <RowSub>
            {countGrants(row.permissions)} grants across{" "}
            {Object.keys(row.permissions).length} subjects
          </RowSub>
        </span>
      ),
      compare: (a, b) => a.role.localeCompare(b.role),
    },
    {
      id: "members",
      head: "Members",
      tone: "num",
      cell: (row) =>
        row.memberCount === 0 ? (
          <span className="text-tx-3">0</span>
        ) : stopped ? (
          <span className="flex items-center justify-end gap-2">
            <span>{row.memberCount}</span>
            <ChangeTheirRole
              role={row.role}
              onClick={() => onShowMembers(row)}
            />
          </span>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="qt"
            onClick={() => onShowMembers(row)}
          >
            {row.memberCount}
            <span className="sr-only">{` — see who holds ${row.role}`}</span>
          </Button>
        ),
      compare: (a, b) => a.memberCount - b.memberCount,
    },
    {
      id: "created",
      head: "Created",
      className: "w-36",
      cell: (row) => <RowTime iso={row.createdAt} />,
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      className: "w-40",
      cell: (row) =>
        licensed || stopped ? (
          <span className="flex justify-end gap-1.5">
            <Button
              type="button"
              size="xs"
              disabled={Boolean(stopped)}
              title={stopped?.reason}
              onClick={() => onEdit(row)}
            >
              Edit
            </Button>
            <Button
              type="button"
              size="xs"
              variant="dngr"
              aria-disabled={row.memberCount > 0 ? true : undefined}
              onClick={() => row.memberCount === 0 && onDelete(row)}
            >
              Delete
            </Button>
          </span>
        ) : null,
    },
  ];
}

const CHANGE_REFUSAL = roleRefusal("change someone's role");

/**
 * "Change their role" on a kept-but-stopped role leads to the people holding
 * it, to move them: `PATCH /organizations/members/:id`, so it reads
 * `member: ['update']` as the Members page's Change role does.
 */
function ChangeTheirRole({
  role,
  onClick,
}: {
  role: string;
  onClick: () => void;
}) {
  const canChange = usePermission({ member: ["update"] });
  return (
    <Button
      type="button"
      size="xs"
      disabled={!canChange.allowed}
      title={canChange.allowed ? undefined : CHANGE_REFUSAL}
      onClick={() => canChange.allowed && onClick()}
    >
      Change their role
      <span className="sr-only">{` — the people holding ${role}`}</span>
    </Button>
  );
}
