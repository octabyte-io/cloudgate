import { Chip } from "@/components/console/chip";
import { CopyButton } from "@/components/console/copy-button";
import type { Column } from "@/components/console/data-table";
import { RowSub } from "@/components/console/rows/cells";
import { Button } from "@/components/ui/button";
import type { OrganizationMembership } from "@/lib/api/endpoints/organizations";

/**
 * One row per membership, and three actions that depend on where you already are.
 *
 * **Delete is deliberately not one of them** — it belongs to the active
 * Organization only, for the reason `organizations-section.tsx` gives, so another
 * Organization's row offers **Switch to it** and the destructive control appears
 * once you are looking at the thing.
 *
 * The owner rule is the backend's and is not re-derived: `assertOwner` passes if
 * you are `organization.ownerId` **or** hold the `owner` member role, and both are
 * on the row `GET /organizations` returns.
 */
export function organizationColumns({
  organizationId,
  busyId,
  onSwitch,
  onMakeDefault,
  onRename,
}: {
  organizationId: string | null;
  /** The row with a write in flight, so its two buttons say so. */
  busyId: string | null;
  onSwitch: (id: string) => void;
  onMakeDefault: (row: OrganizationMembership) => void;
  onRename: (row: OrganizationMembership) => void;
}): Column<OrganizationMembership>[] {
  return [
    {
      id: "name",
      head: "Organization",
      tone: "key",
      cell: (row) => (
        <span className="block min-w-0">
          <span className="flex flex-wrap items-center gap-1.75">
            {row.name}
            {row.id === organizationId ? (
              <Chip variant="brand">You are here</Chip>
            ) : null}
            {row.member.isDefault ? <Chip>Default</Chip> : null}
          </span>
          <RowSub mono>{row.id}</RowSub>
        </span>
      ),
      compare: (a, b) => a.name.localeCompare(b.name),
    },
    {
      id: "role",
      head: "Your role",
      cell: (row) => <Chip>{row.member.role}</Chip>,
    },
    {
      id: "id",
      head: <span className="sr-only">Copy id</span>,
      className: "w-10",
      cell: (row) => (
        <CopyButton
          value={row.id}
          label={`id of ${row.name}`}
          size="icon-xs"
        />
      ),
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      className: "w-56 text-right",
      cell: (row) => (
        <span className="flex flex-wrap justify-end gap-1.5">
          {row.id === organizationId ? null : (
            <Button
              type="button"
              size="xs"
              disabled={busyId === row.id}
              aria-busy={busyId === row.id || undefined}
              onClick={() => onSwitch(row.id)}
            >
              Switch to it
            </Button>
          )}
          {row.member.isDefault ? null : (
            <Button
              type="button"
              size="xs"
              disabled={busyId === row.id}
              aria-busy={busyId === row.id || undefined}
              onClick={() => onMakeDefault(row)}
            >
              Make default
            </Button>
          )}
          {row.ownerId === row.member.userId || row.member.role === "owner" ? (
            <Button type="button" size="xs" onClick={() => onRename(row)}>
              Rename
            </Button>
          ) : null}
        </span>
      ),
    },
  ];
}
