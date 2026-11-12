"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { toast } from "@/components/console/toast";
import { LinkButton } from "@/components/console/link-button";
import { Button } from "@/components/ui/button";
import { StrandedMembersBanner } from "@/features/members/stranded-banner";
import type { CustomRole } from "@/lib/api/endpoints/roles";
import { useRoleVocabulary } from "@/lib/api/use-role-vocabulary";
import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../../settings/section-states";
import {
  DowngradeWaitingStrip,
  KeptStoppedStrip,
  useKeptStopped,
} from "../business-plan";
import { LicenseLocked } from "../license-gate";
import { useLicenseStatus } from "../use-license";
import { RoleBuilderModal } from "./role-builder-modal";
import { DeleteRoleModal } from "./delete-role-modal";
import { RoleMembersModal } from "./role-members-modal";
import { roleColumns } from "./role-columns";
import { useCustomRoles, useDeleteCustomRole } from "./use-custom-roles";

/**
 * The roles this Organization has defined, and the builder behind them.
 *
 * **The list is rendered whether or not there is a licence, and that is the
 * whole design of this screen.** `GET /custom-roles` is on the plain
 * authenticated path; only the three writes run `ensureEnterprise`. So an
 * unlicensed Organization can see its roles — and *has to be able to*:
 * `PermissionService.resolveRole` cannot resolve a non-static role without a
 * valid licence, so a member holding one is denied **everything**, including the
 * actions their role grants — not narrowed, refused.
 *
 * `updateMemberRole` refuses the *assignment* without a licence now, so nobody
 * new can be put in that position. It does not empty it: a licence lapses on its
 * own, and nothing deletes the `organization_role` rows or moves anyone off
 * them. So the banner below is not decoration; it names how many people are in
 * that position.
 *
 * It is no longer the only thing that says so
 * the same banner
 * is on the Members screen, and the backend warns once per lapse naming the
 * people. Which is why the sentence itself moved into `StrandedMembersBanner` —
 * one condition should not be described in two voices.
 *
 * Hiding this list behind `LicenseGate` would have hidden exactly that. The
 * gate's *sentence* is still used, through `LicenseLocked`, so there is one
 * wording and not two.
 *
 * ## Never set up, or kept but stopped
 *
 * Unlicensed with no roles defined, there is nothing to show but the lock
 * ("Custom roles come with the Business plan" on the Hosted instance). With
 * roles kept, the strip says they allow nothing right now, which takes the
 * place of the stranded-members banner on this screen; each role says so,
 * the people on one get "Change their role", Create and Edit are off with
 * why, and Delete stays on. While a downgrade waits, on Business,
 * `DowngradeWaitingStrip` says from when they allow nothing.
 */
export function RolesSection() {
  const vocabulary = useRoleVocabulary();
  const roles = useCustomRoles();
  const status = useLicenseStatus();
  const remove = useDeleteCustomRole();
  const kept = useKeptStopped("customRoles");

  const [building, setBuilding] = useState<{ role?: CustomRole } | null>(null);
  const [deleting, setDeleting] = useState<CustomRole | null>(null);
  const [roster, setRoster] = useState<CustomRole | null>(null);

  const arrival = useArrival(vocabulary.isPending || roles.isPending);
  if (vocabulary.isPending || roles.isPending) {
    return <SectionPending title="Custom roles" rows={4} />;
  }

  if (vocabulary.error || !vocabulary.data) {
    return (
      <SectionFailed title="Custom roles" error={vocabulary.error}>
        The permission vocabulary comes from the backend, so there is nothing to
        build a role out of until that read works.
      </SectionFailed>
    );
  }

  if (roles.error) {
    return (
      <SectionFailed title="Custom roles" error={roles.error}>
        Listing roles is open to every member of an Organization, so a refusal
        here is not about a license.
      </SectionFailed>
    );
  }

  const rows = roles.data ?? [];
  const licensed = status.data?.licensed === true;
  const stopped = kept !== null;
  const stranded = rows.reduce((sum, role) => sum + role.memberCount, 0);

  if (stopped && rows.length === 0) {
    return (
      <Card>
        <Card.Header title="Custom roles" headingLevel={2} />
        <Card.Body>
          <LicenseLocked feature="customRoles">
            {CUSTOM_ROLES_ARE}
          </LicenseLocked>
        </Card.Body>
      </Card>
    );
  }

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      {stopped ? (
        <KeptStoppedStrip
          feature="customRoles"
          what="Custom roles allow nothing right now."
        />
      ) : (
        <>
          <DowngradeWaitingStrip stops="Custom roles stop allowing anything" />
          <StrandedMembersBanner
            action={
              <LinkButton size="sm" href="/settings/members">
                Go to Members
              </LinkButton>
            }
          />
        </>
      )}

      <Card>
        <Card.Header
          title="Custom roles"
          sub="Roles this Organization defined, on top of owner, admin and member."
          headingLevel={2}
          actions={
            licensed ? (
              <Button
                type="button"
                size="sm"
                variant="pri"
                aria-disabled={rows.length >= 10 ? true : undefined}
                onClick={() => rows.length < 10 && setBuilding({})}
              >
                Create a role
              </Button>
            ) : stopped ? (
              <Button
                type="button"
                size="sm"
                variant="pri"
                disabled
                title={kept?.reason}
              >
                Create a role
              </Button>
            ) : null
          }
        />

        <Card.Body flush>
          <DataTable<CustomRole>
            label="Custom roles in this Organization"
            rows={rows}
            getRowId={(row) => row.role}
            empty={
              <EmptyState icon="sliders" title="No custom roles yet">
                Create a role for access the three built-in roles do not give — read-only
                for an auditor, say, or deploy rights without delete.
              </EmptyState>
            }
            columns={roleColumns({
              licensed,
              stopped: kept,
              onEdit: (role) => setBuilding({ role }),
              onDelete: setDeleting,
              onShowMembers: setRoster,
            })}
          />
        </Card.Body>

        {stopped && stranded > 0 ? (
          <Card.Footer>
            {stranded === 1
              ? "This person can sign in but can't do anything until you give them a built-in role."
              : `These ${stranded} people can sign in but can't do anything until you give them a built-in role.`}
          </Card.Footer>
        ) : null}

        {licensed ? (
          <Card.Footer>
            {rows.length >= 10
              ? "Ten roles is the limit for an Organization, so creating another one is off until you delete one."
              : `${10 - rows.length} more can be created — an Organization may define ten. A role cannot be deleted while anyone holds it.`}
          </Card.Footer>
        ) : null}
      </Card>

      {licensed || stopped ? null : (
        <Card>
          <Card.Header title="Creating and editing roles" headingLevel={2} />
          <Card.Body>
            <LicenseLocked feature="customRoles">
              {CUSTOM_ROLES_ARE}
            </LicenseLocked>
          </Card.Body>
        </Card>
      )}

      {building ? (
        <RoleBuilderModal
          key={building.role?.role ?? "new"}
          vocabulary={vocabulary.data}
          role={building.role}
          onClose={() => setBuilding(null)}
        />
      ) : null}

      {roster ? (
        <RoleMembersModal
          role={roster}
          changeRoles={stopped}
          onClose={() => setRoster(null)}
        />
      ) : null}

      {deleting ? (
        <DeleteRoleModal
          role={deleting}
          pending={remove.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.role);
            toast.done(`${deleting.role} deleted.`);
            setDeleting(null);
          }}
        />
      ) : null}
    </div>
  );
}

const CUSTOM_ROLES_ARE = (
  <>
    A custom role is one you define yourself, with grants drawn from the same
    permission table the backend&rsquo;s guards check — so you can give somebody
    exactly the actions they need and nothing else.
  </>
);
