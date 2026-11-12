import { useState } from "react";

import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { useDeleteOrganization } from "@/lib/api/use-organizations";
import type { AttachedOrganization } from "@/lib/api/endpoints/billing";
import { errorMessage } from "@/lib/api/error-message";
import { useAttachedOrganizations } from "@/lib/api/use-billing";
import {
  roleRefusal,
  usePermission,
  type Gate,
} from "@/lib/auth/use-permission";
import { fullName } from "@/lib/format/person";
import { counted } from "@/lib/format/plural";

import { StopPayingConfirm } from "./stop-paying-confirm";

/**
 * **"Before <Paying> can move to Starter"** (ADR-0059): what the move to
 * Starter — the scheduled downgrade or the switch during a Free trial — opens
 * instead of its confirm while this Organization pays for others. Starter pays
 * for one Organization, so `POST /billing/downgrade` refuses the move with
 * `ORGANIZATIONS_ATTACHED` until none is attached; this is that refusal shown
 * before anyone clicks, with the way through on each row.
 *
 * Each Attached Organization is listed with its owner and Servers, and
 * **"Stop paying for it"** (the Detach, `StopPayingConfirm`) and, for one the
 * reader owns, **Delete** (`DELETE /organizations/:id` refuses anyone else).
 * The Detach reads `organization: ['update']`: it admits the Paying
 * Organization's owners and admins, who both hold it (`gated-controls.ts`).
 * The move in the footer stays disabled until the list, re-read after each,
 * is empty; then `onCleared` hands over to the move's normal confirm.
 *
 * One dialog is on screen at a time: Detach and Delete each take the
 * checklist's place and give it back when they close.
 *
 * Nothing is sent to the Attached Organizations: the PRD's Notices give
 * "the dialog only" for a refused move.
 */
export function StarterChecklist({
  open,
  onOpenChange,
  move,
  onCleared,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The move's own button, "Move to Starter" or "Switch to Starter". */
  move: string;
  /** The list is empty and the move was pressed: open its confirm. */
  onCleared: () => void;
}) {
  const attached = useAttachedOrganizations();
  const remove = useDeleteOrganization();
  const canDetach = usePermission({ organization: ["update"] });
  const [acting, setActing] = useState<{
    kind: "detach" | "delete";
    organization: AttachedOrganization;
  } | null>(null);

  const name = attached.data?.name ?? "This Organization";
  const organizations = attached.data?.organizations;
  const cleared = organizations !== undefined && organizations.length === 0;
  const back = () => setActing(null);

  return (
    <>
      <Modal open={open && acting === null} onOpenChange={onOpenChange}>
        <Modal.Header
          title={`Before ${name} can move to Starter`}
          description={`Starter pays for one Organization, and ${name}'s plan pays for the ones below too. Stop paying for each, or delete one you own; the move waits until none is left.`}
        />
        <Modal.Body>
          {attached.isPending ? (
            <p className="text-body text-tx-2">
              Reading the Organizations on this plan…
            </p>
          ) : attached.error ? (
            <p role="alert" className="text-body text-tx">
              {errorMessage(attached.error)}
            </p>
          ) : cleared ? (
            <p className="text-body text-tx">
              Nothing else is on this plan now. {name} can move to Starter.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {organizations?.map((organization) => (
                <ChecklistRow
                  key={organization.id}
                  organization={organization}
                  detach={{
                    allowed: canDetach.allowed,
                    refusal: DETACH_REFUSAL,
                  }}
                  onDetach={() => setActing({ kind: "detach", organization })}
                  onDelete={() => setActing({ kind: "delete", organization })}
                />
              ))}
            </ul>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Back</Button>} />
          <Button
            type="button"
            variant="pri"
            disabled={!cleared}
            title={
              cleared
                ? undefined
                : "Stop paying for each Organization, or delete it, first."
            }
            onClick={onCleared}
          >
            {move}
          </Button>
        </Modal.Footer>
      </Modal>

      {acting?.kind === "detach" ? (
        <StopPayingConfirm
          organization={acting.organization}
          open={open}
          onOpenChange={(next) => {
            if (!next) back();
          }}
        />
      ) : null}

      {acting?.kind === "delete" ? (
        <ConfirmDeleteModal
          open={open}
          onOpenChange={(next) => {
            if (!next) back();
          }}
          title={`Delete ${acting.organization.name}`}
          confirmWord={acting.organization.name}
          mismatch="That does not match the Organization's name."
          button="Delete Organization"
          onConfirm={async () => {
            await remove.mutateAsync(acting.organization.id);
            toast.done(`${acting.organization.name} is deleted.`);
            back();
          }}
        >
          <p className="text-body text-tx-2">
            Everything in {acting.organization.name} goes: Projects,
            Environments, services, Servers, members, integrations and settings.
            Its {counted(acting.organization.servers, "Server", "Servers")} and{" "}
            {counted(
              acting.organization.cloudEnvironments,
              "Cloud Environment",
              "Cloud Environments",
            )}{" "}
            leave this plan now.
          </p>
        </ConfirmDeleteModal>
      ) : null}
    </>
  );
}

const DETACH_REFUSAL = roleRefusal("stop paying for an Organization");

function ChecklistRow({
  organization,
  detach,
  onDetach,
  onDelete,
}: {
  organization: AttachedOrganization;
  /** Whether the reader may stop paying for it, and why not. */
  detach: Gate;
  onDetach: () => void;
  onDelete: () => void;
}) {
  const { name, owner } = organization;
  const ownerName = owner ? fullName(owner) : null;
  const labelId = `starter-checklist-${organization.id}`;
  return (
    <li
      aria-labelledby={labelId}
      className="flex flex-wrap items-center justify-between gap-3 py-3"
    >
      <div className="min-w-0">
        <p id={labelId} className="text-ui font-medium text-tx">
          {name}
        </p>
        <p className="text-meta text-tx-2">
          {owner
            ? `Owned by ${ownerName ? `${ownerName} (${owner.email})` : owner.email}`
            : "Its owner is gone"}
          {" · "}
          {counted(organization.servers, "Server", "Servers")}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!detach.allowed}
          title={detach.allowed ? undefined : detach.refusal}
          onClick={onDetach}
        >
          Stop paying for it
        </Button>
        {organization.ownedByYou ? (
          <Button type="button" size="sm" variant="dngr" onClick={onDelete}>
            Delete
          </Button>
        ) : null}
      </div>
    </li>
  );
}
