// No `"use client"`: a leaf, imported only by the Members and Agents dialogs,
// whose own importers already carry it.

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { MemberEntitlements } from "@/lib/api/endpoints/organizations";
import { errorMessage } from "@/lib/api/error-message";
import { useUpdateMemberEntitlements } from "@/lib/api/use-member-grants";
import {
  entitlementsBody,
  grantsDiffer,
  seedGrants,
  strandedGrants,
} from "@/lib/auth/access-grants";

import { StrandedGrants } from "./access-sections";
import { AccessTree, useAccessTree } from "./access-tree";
import { FormError } from "./field";
import { Modal } from "./modal";
import { toast } from "./toast";

/**
 * Edit what one Member may reach — a person's Manage access and an Agent's.
 *
 * Both were the same dialog with different words: seeded from the member
 * row's three `accessed*` columns, the tree over `useAccessTree`, the stranded
 * ids listed, and the whole filtered set written back through `PATCH
 * /organizations/members/:id/entitlements` on every save
 * (`lib/auth/access-grants.ts` says why it is never a diff). Promoted with the
 * tree rather than left as two copies, because the save is where a
 * drift would cost a grant.
 *
 * What stays the caller's is what differs: the title and description, who the
 * grant is for, and whatever it says above the tree — the admin notice on a
 * person, the log-mask notice on an Agent.
 */
export function AccessModal({
  memberId,
  held,
  name,
  subject,
  title,
  description,
  children,
  open,
  onOpenChange,
}: {
  /** The member row the PATCH is addressed to. */
  memberId: string;
  /** That row's three columns, read once as the dialog's defaults. */
  held: MemberEntitlements;
  /** Who, as the toast names them. */
  name: string;
  /** Who the grant is for, as the empty columns and stranded line say it. */
  subject: "person" | "Agent";
  title: string;
  description: string;
  /** What the caller says above the tree. */
  children?: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateMemberEntitlements();
  const [grants, setGrants] = useState(() => seedGrants(held));
  const [refusal, setRefusal] = useState<string | null>(null);
  const tree = useAccessTree(grants);
  const { inventory } = tree;

  const stranded = strandedGrants(grants, inventory);
  const body = entitlementsBody(grants, inventory);
  const changed = grantsDiffer(body, held);

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (update.isPending || !changed) return;
    setRefusal(null);
    try {
      await update.mutateAsync({ memberId, grants: body });
      toast.done(`Updated what ${name} can reach.`);
      onOpenChange(false);
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} wide>
      <Modal.Header title={title} description={description} />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          {children}

          <AccessTree
            tree={tree}
            grants={grants}
            onChange={setGrants}
            subject={`this ${subject}`}
          />

          <StrandedGrants
            subject={subject}
            ids={[
              ...stranded.projects,
              ...stranded.environments,
              ...stranded.services,
            ]}
          />

          <FormError message={refusal ?? undefined} />
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="submit"
            variant="pri"
            disabled={!changed || update.isPending}
            aria-busy={update.isPending || undefined}
          >
            Save access
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
