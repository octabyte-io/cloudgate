import { useId, useState } from "react";
import { useRouter } from "next/navigation";

import { Card } from "@/components/console/card";
import { Button } from "@/components/ui/button";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import {
  APPLICATION_DELETE_REFUSAL,
  useDeleteApplication,
} from "../use-application";
import { DeleteApplicationModal } from "./delete-application-modal";
import {
  ConfigLockNote,
  lockRefusal,
  useConfigLock,
} from "@/components/console/config-lock";

/** Why Delete is off while a cloud Delete runs or is incomplete. */
const CLOUD_DELETE_UNDER_WAY =
  "Its Delete has already started. While it runs there is nothing to press; if it is incomplete, Retry or Forget it on the Overview.";

/**
 * The Application's way out — the last card on its Advanced tab, where
 * the Compose stack and the database keep theirs.
 *
 * **Gated on `service: ['delete']`**, the statement `DELETE /applications/:id`
 * requires. The button stays in place and goes off with the reason beside it,
 * in `ProjectDetailsForm`'s shape: `Button`'s `disabled` is `aria-disabled`
 * here, so it keeps its focus and the reason is what a keyboard user hears.
 * `usePermission` fails open, so a role read still in flight leaves it live and
 * the backend's refusal lands in the dialog.
 */
export function DeleteApplicationCard({
  application,
}: {
  application: ApplicationDetail;
}) {
  const router = useRouter();
  const permission = usePermission({ service: ["delete"] });
  // A Service a repository-kept config describes is deleted by removing it
  // from the file.
  const lock = useConfigLock(
    application.environmentId,
    "application",
    application.applicationId,
  );
  const remove = useDeleteApplication(
    application.applicationId,
    application.environmentId,
  );
  const [deleting, setDeleting] = useState(false);
  const refusalId = useId();

  return (
    <>
      <Card className="border-bad-line">
        <Card.Header
          title="Delete this Application"
          sub={
            application.cloudPlace
              ? "Everything Cloudgate made for it in its Cloud account, then this row."
              : "Its Swarm service, its directory on the Server and this row."
          }
          headingLevel={2}
        />
        <Card.Body className="flex flex-col gap-3">
          {application.cloudPlace ? (
            <p className="max-w-lede text-body text-tx-2">
              A Cloud run destroys it in AWS and checks that nothing is left;
              anything that is keeps this Service as Delete incomplete.
            </p>
          ) : (
            <p className="max-w-lede text-body text-tx-2">
              Everything recorded against it goes with the row, and the dialog
              lists what that is. Docker volumes its mounts name stay on the
              Server unless you ask for them to go too.
            </p>
          )}
          {application.cloudDelete ? (
            <p className="text-meta text-tx-2">{CLOUD_DELETE_UNDER_WAY}</p>
          ) : null}
          {permission.allowed ? null : (
            <p id={refusalId} className="text-meta text-tx-2">
              {APPLICATION_DELETE_REFUSAL}
            </p>
          )}
          {permission.allowed && lock ? (
            <ConfigLockNote lock={lock} what="This Application is" />
          ) : null}
          <div>
            <Button
              variant="dngr"
              disabled={
                !permission.allowed ||
                lock !== null ||
                Boolean(application.cloudDelete)
              }
              title={
                !permission.allowed
                  ? APPLICATION_DELETE_REFUSAL
                  : lock
                    ? lockRefusal(lock)
                    : application.cloudDelete
                      ? CLOUD_DELETE_UNDER_WAY
                      : undefined
              }
              aria-describedby={permission.allowed ? undefined : refusalId}
              onClick={() => setDeleting(true)}
            >
              <Icon name="trash" size={15} />
              Delete {application.name}
            </Button>
          </div>
        </Card.Body>
      </Card>

      <DeleteApplicationModal
        application={application}
        open={deleting}
        onOpenChange={setDeleting}
        remove={(deleteVolumes, force) =>
          remove.mutateAsync({ deleteVolumes, force })
        }
        // Back to the Environment it was in — its Services tab is the scope's
        // first, so the id alone is the address.
        onDeleted={() =>
          router.push(`/environments/${application.environmentId}`)
        }
      />
    </>
  );
}
