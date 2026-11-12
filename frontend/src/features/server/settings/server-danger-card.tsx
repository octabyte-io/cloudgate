import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { QAList, QARow } from "@/components/console/qa-row";
import { Button } from "@/components/ui/button";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import { SERVER_DELETE_REFUSAL } from "../use-server";
import { DeleteServerModal } from "./delete-server-modal";

/**
 * Removing the Server from Cloudgate — which does **nothing to the machine**.
 *
 * Whatever is running there keeps running, unmanaged and unreachable from here, so
 * the row says that rather than implying a teardown. The dialog itself is
 * `ConfirmDeleteModal`'s since F19: it never cleared the typed name, so reopening
 * after a cancel armed the delete before you had read a word.
 *
 * **Delete is off, with the reason beside it, for a role the route would
 * refuse**: `DELETE /servers/:id` is `@RequirePermission('server',
 * 'delete')`, which the base member does not hold.
 */
export function DangerCard({ server }: { server: Server }) {
  const [deleting, setDeleting] = useState(false);
  const canDelete = usePermission({ server: ["delete"] });
  const refusalId = useId();

  return (
    <>
      <Card>
        <Card.Header title="Remove this Server" headingLevel={2} />
        <Card.Body className="flex flex-col gap-3">
          {canDelete.allowed ? null : (
            <p id={refusalId} className="text-meta text-tx-2">
              {SERVER_DELETE_REFUSAL}
            </p>
          )}
          <QAList>
            <QARow
              title={`Delete ${server.name} from Cloudgate`}
              description="Cloudgate forgets the machine and does nothing to it. Whatever is running there keeps running, unmanaged and unreachable from here — so stop what should be stopped first."
              action={
                <Button
                  size="sm"
                  variant="dngr"
                  disabled={!canDelete.allowed}
                  title={canDelete.allowed ? undefined : SERVER_DELETE_REFUSAL}
                  aria-describedby={canDelete.allowed ? undefined : refusalId}
                  onClick={() => {
                    if (canDelete.allowed) setDeleting(true);
                  }}
                >
                  Delete
                </Button>
              }
            />
          </QAList>
        </Card.Body>
      </Card>

      <DeleteServerModal
        server={server}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </>
  );
}
