// No `"use client"` — see the note in `application-actions.tsx`. Imported only
// from the two Application panels, which are already client entry points.

import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { useApplicationLifecycle, wasRefused } from "../use-application";
import { ActionIcon } from "./action-icon";

/**
 * Stop a build: take a queued one back out of the queue
 * or kill a
 * running one.
 *
 * **It renders for a `pending` or `running` Deployment**, the two states in
 * which there is still a build to stop. A `pending` row is a job the queue is
 * holding, and removing it is the whole operation. A `running` row is a shell
 * pipeline the backend started and holds a handle to — a child process on the
 * platform host, an SSH session on a Server — so
 * `POST /deployments/:id/cancel` kills everything it started, leaves the row
 * `cancelled`, and frees the Server for the next queued build.
 *
 * The one refusal left is a build past its shell steps: once the image is
 * built the engine releases it as a Swarm service and waits for it to
 * converge, which a kill cannot stop part-way, so the backend answers **409**
 * and says so. That — and a build that finished between reading the row and
 * pressing the button — is why the 409 is handled rather than assumed away:
 * the backend's sentence is the right thing to show.
 */
export function CancelBuildButton({
  deployment,
  applicationId,
  size = "xs",
}: {
  deployment: Deployment;
  applicationId: string;
  size?: "xs" | "sm";
}) {
  const lifecycle = useApplicationLifecycle(applicationId);
  const cancel = lifecycle.cancel;
  // `POST /deployments/:id/cancel` asks `deployment: cancel`, a build's and
  // a Cron run's alike.
  const canCancel = usePermission({ deployment: ["cancel"] });

  // A `held` build waits on a plan and has no job yet; cancelling it
  // settles the record, as a queued build's does.
  if (
    deployment.status !== "pending" &&
    deployment.status !== "running" &&
    deployment.status !== "held"
  ) {
    return null;
  }
  const running = deployment.status === "running";
  // A Cron service's run: cancelling it stops its job, and its
  // timetable keeps going.
  const cronRun = Boolean(deployment.cronRun);

  return (
    <Button
      size={size}
      variant="dngr"
      disabled={!canCancel.allowed || cancel.isPending}
      title={canCancel.allowed ? undefined : roleRefusal("cancel a Deployment")}
      aria-busy={cancel.isPending || undefined}
      onClick={async () => {
        try {
          await cancel.mutateAsync(deployment.deploymentId);
          toast.done(
            cronRun
              ? "The run was cancelled. Its timetable keeps going."
              : running
                ? "The build was stopped."
                : "The build was cancelled before it started.",
          );
        } catch (error) {
          if (wasRefused(error)) {
            // Includes the 409 — a build that reached its release, or finished,
            // while this was on screen.
            // `warn` rather than `error`: the backend's own sentence is a fact
            // about the build, not something the operator got wrong.
            toast.warn(errorMessage(error));
            return;
          }
          toast.error(error);
        }
      }}
    >
      <ActionIcon pending={cancel.isPending} size={size === "xs" ? 13 : 14} />
      Cancel
    </Button>
  );
}
