// No `"use client"` — see the note in `application-actions.tsx`. Imported only
// from the two Application panels, which are already client entry points.

import { useState } from "react";

import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { useApplicationLifecycle, wasRefused } from "../use-application";
import { ActionIcon } from "./action-icon";

/** The confirmation the spec words (US69). */
export const STOP_RUN_CONSEQUENCE =
  "Changes made so far stay in your AWS account; the next deploy picks up from them";

/**
 * **Stop the run**: ends a running Cloud run, its apply included, after a
 * confirmation.
 *
 * **It is not Cancel, and sits beside it rather than replacing it.** Cancel
 * works while a Cloud run waits or plans and leaves the row `cancelled`,
 * which means nothing was changed in AWS. Once the apply has begun the
 * backend refuses Cancel with a sentence, because by then something may have
 * been made; this is what ends the run from there — one interrupt, a kill 5
 * minutes later — and the row ends `error`, naming who stopped it. So it
 * renders for a `running` Cloud run only: a waiting one is Cancel's, and a
 * build is not a Cloud run.
 *
 * The same statement as Cancel (`deployment: cancel`, Agents included), so
 * whoever may cancel a deploy may end one that hangs.
 */
export function StopRunButton({
  deployment,
  applicationId,
  size = "xs",
}: {
  deployment: Deployment;
  applicationId: string;
  size?: "xs" | "sm";
}) {
  const lifecycle = useApplicationLifecycle(applicationId);
  const stop = lifecycle.stopRun;
  const canStop = usePermission({ deployment: ["cancel"] });
  const [open, setOpen] = useState(false);

  if (deployment.status !== "running" || !deployment.cloudRun) return null;

  return (
    <>
      <Button
        size={size}
        variant="dngr"
        disabled={!canStop.allowed}
        title={canStop.allowed ? undefined : roleRefusal("stop a Cloud run")}
        onClick={() => setOpen(true)}
      >
        Stop the run
      </Button>
      <Modal open={open} onOpenChange={setOpen}>
        <Modal.Header
          title="Stop this Cloud run?"
          description={`${STOP_RUN_CONSEQUENCE}.`}
        />
        <Modal.Body>
          <p className="text-body text-tx-2">
            OpenTofu is interrupted now and killed if it has not stopped within
            5 minutes. The deployment ends as an error that says you stopped it,
            and it is not run again by itself.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Keep running</Button>} />
          <Button
            type="button"
            variant="dngr"
            disabled={!canStop.allowed || stop.isPending}
            aria-busy={stop.isPending || undefined}
            onClick={async () => {
              try {
                await stop.mutateAsync(deployment.deploymentId);
                setOpen(false);
                toast.done("The Cloud run is stopping.");
              } catch (error) {
                setOpen(false);
                if (wasRefused(error)) {
                  // A run that ended, or never started, while this was open.
                  toast.warn(errorMessage(error));
                  return;
                }
                toast.error(error);
              }
            }}
          >
            <ActionIcon pending={stop.isPending} size={15} />
            Stop the run
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
