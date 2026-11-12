"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { NewOrganizationReason } from "@/components/console/new-organization-reason";
import { OrganizationFormModal } from "@/components/console/organization-form-modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { useInvalidate } from "@/lib/api/use-invalidate";
import {
  newOrganizationGate,
  useOrganizationCreation,
  useOrganizations,
  useSetDefaultOrganization,
} from "@/lib/api/use-organizations";
import type { OrganizationMembership } from "@/lib/api/endpoints/organizations";
import { unwrap } from "@/lib/auth/auth-error";
import { organization, useActiveOrganizationId } from "@/lib/auth/client";
import { Icon } from "@/lib/design/icons";
import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../section-states";
import { organizationColumns } from "./organization-columns";
import { OrganizationDangerZone } from "./organization-danger-zone";
import {
  OverOrganizationLimitNotice,
  OwnedOrganizationsLine,
} from "./new-organization";

/**
 * The Organizations this person belongs to, and the one they are in.
 *
 * **Delete is offered for the active Organization only, and that is a design
 * decision rather than a limitation of the route.** `DELETE /organizations/:id`
 * takes any id you own. But the phase brief asks that dialog to *name what will
 * be destroyed*, and the only way to name it is to read the Projects and Servers
 * — both of which are scoped to the session's active Organization on the server
 * side. Deleting a different one would mean a dialog that says "everything in
 * Second Organization" without being able to say what that is, which is exactly
 * the confident-sounding emptiness F07's `CountTile` defect was about. So the
 * row for another Organization offers **Switch to it** instead, and the delete
 * appears once you are looking at the thing — in `organization-danger-zone.tsx`.
 */
export function OrganizationsSection() {
  const organizations = useOrganizations();
  const creation = useOrganizationCreation();
  const newOrganization = newOrganizationGate(creation);
  const { organizationId } = useActiveOrganizationId();
  const setDefault = useSetDefaultOrganization();
  const invalidate = useInvalidate();

  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<OrganizationMembership | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const arrival = useArrival(organizations.isPending);
  if (organizations.isPending) {
    return <SectionPending title="Organizations" rows={3} />;
  }
  if (organizations.error) {
    return (
      <SectionFailed title="Organizations" error={organizations.error}>
        This list is your own memberships, so a failure here means the session
        itself is not answering.
      </SectionFailed>
    );
  }

  const rows = organizations.data ?? [];
  const active = rows.find((row) => row.id === organizationId) ?? null;
  const canDeleteActive =
    active !== null &&
    (active.ownerId === active.member.userId || active.member.role === "owner");

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      <Card>
        <Card.Header
          title="Organizations"
          sub="Each one is separate: its own Projects, Servers, members and settings."
          headingLevel={2}
          actions={
            <Button
              size="sm"
              variant="pri"
              disabled={!newOrganization.allowed}
              onClick={() => setCreating(true)}
            >
              <Icon name="plus" size={14} />
              New organization
            </Button>
          }
        />
        <NewOrganizationReason
          creation={creation.data}
          className="border-b border-line px-4 py-2 text-meta text-tx-3"
        />
        <OwnedOrganizationsLine creation={creation.data} />
        <OverOrganizationLimitNotice creation={creation.data} />
        <Card.Body flush>
          {rows.length === 0 ? (
            // Not an empty table: a header row over nothing reads as a
            // list that failed to load. Someone removed from every Organization
            // while signed in is the reader, and the shell's gate normally
            // stands in front of this screen for them — this is the frame for
            // the moment before it does, and for anyone the gate lets through.
            //
            // No action of its own: New organization is already in the
            // card's header, one line above, and two of it is one too many.
            <EmptyState icon="layers" title="You are not in any Organization">
              Everything in Cloudgate belongs to one. Create one to work in, or
              open the link in an invitation to join one.
            </EmptyState>
          ) : (
            <DataTable<OrganizationMembership>
              label="Organizations you belong to"
              rows={rows}
              getRowId={(row) => row.id}
              columns={organizationColumns({
                organizationId,
                busyId,
                onSwitch: switchTo,
                onMakeDefault: makeDefault,
                onRename: setRenaming,
              })}
            />
          )}
        </Card.Body>
        <Card.Footer>
          The default is where you land when you sign in; without one, signing
          in asks which to work in. Switching here moves the whole console, the
          same way the switcher in the masthead does.
        </Card.Footer>
      </Card>

      {active && canDeleteActive ? (
        <OrganizationDangerZone active={active} rows={rows} />
      ) : null}

      {creating ? (
        <OrganizationFormModal key="create" open onOpenChange={setCreating} />
      ) : null}
      {renaming ? (
        <OrganizationFormModal
          key={renaming.id}
          organization={renaming}
          open
          onOpenChange={(next: boolean) => {
            if (!next) setRenaming(null);
          }}
        />
      ) : null}
    </div>
  );

  async function switchTo(id: string) {
    setBusyId(id);
    try {
      await unwrap(organization.setActive({ organizationId: id }));
      await invalidate.organizationChanged();
      toast.done("You are now in that Organization.");
    } catch (error) {
      toast.error(error);
    } finally {
      setBusyId(null);
    }
  }

  async function makeDefault(row: OrganizationMembership) {
    setBusyId(row.id);
    try {
      await setDefault.mutateAsync(row.id);
      toast.done(`You will land in ${row.name} when you next sign in.`);
    } catch (error) {
      toast.error(error);
    } finally {
      setBusyId(null);
    }
  }
}
