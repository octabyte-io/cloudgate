import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { APPLICATION_DEPLOY_REFUSAL } from "@/lib/auth/application-refusals";
import { usePermission } from "@/lib/auth/use-permission";

import { ActionIcon } from "../lifecycle/action-icon";

import { useRunCronService } from "./use-run-cron-service";

/** Why Run now is off while no build has succeeded. */
export const WAITING_FOR_FIRST_BUILD =
  "Waiting for first build: a run starts from the image of the last build that succeeded.";

/**
 * **Run now** on a Cron service (ADR-0034): one run, started by hand,
 * as a fresh container from the image of its last successful build. Its Run
 * record joins the Deployments, with its own log; the timetable is not
 * touched.
 *
 * Gated like Deploy, `deployment: ['create']`. Off, and saying why, while the
 * Cron service is waiting for its first build — the backend refuses it then
 * too, and writes nothing.
 */
export function RunNowButton({
  applicationId,
  waitingForFirstBuild,
  onStarted,
}: {
  applicationId: string;
  waitingForFirstBuild: boolean;
  onStarted?: (run: Deployment) => void;
}) {
  const run = useRunCronService(applicationId);
  const canRun = usePermission({ deployment: ["create"] });
  const refusal = !canRun.allowed
    ? APPLICATION_DEPLOY_REFUSAL
    : waitingForFirstBuild
      ? WAITING_FOR_FIRST_BUILD
      : undefined;

  return (
    <Button
      size="xs"
      disabled={refusal !== undefined || run.isPending}
      title={refusal}
      aria-busy={run.isPending || undefined}
      onClick={async () => {
        if (refusal !== undefined) return;
        try {
          const started = await run.mutateAsync();
          toast.done("Run started.", {
            description:
              "Its output and exit code are in its log on the Deployments tab.",
          });
          onStarted?.(started);
        } catch (error) {
          toast.error(error);
        }
      }}
    >
      <ActionIcon name="play" pending={run.isPending} size={13} />
      Run now
    </Button>
  );
}
