// No `"use client"` — see the note in `application-actions.tsx`. Imported only
// from `panels/overview.tsx`, which is already the client entry point.

import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { usePermission } from "@/lib/auth/use-permission";

import {
  APPLICATION_DEPLOY_REFUSAL,
  useApplicationLifecycle,
} from "../use-application";
import { ActionIcon } from "./action-icon";

/**
 * Build the same source again.
 *
 * **Where it belongs is beside a failure, not beside Deploy.** The reference put
 * a Redeploy in exactly one place — the "last deployment failed" affordance
 * (`e-console.html:4148`) — and that is the whole of its case: after a build
 * fails, "Deploy" invites you to wonder what you are supposed to have changed,
 * and "Redeploy" says try that again. Putting it next to Deploy in the header as
 * well would be two buttons whose difference nobody could state.
 *
 * The difference it does make is in the history: the attempt is recorded as
 * *Rebuild deployment* rather than *Manual deployment*, so a run of retries is
 * legible as retries. `deployments.service.ts` also enqueues it as
 * `type: 'redeploy'`, which is the queue's own word for it.
 */
export function RedeployButton({
  applicationId,
  environmentId,
  onDeployed,
  size = "sm",
}: {
  applicationId: string;
  environmentId?: string;
  onDeployed?: (deployment: Deployment) => void;
  size?: "default" | "sm";
}) {
  const lifecycle = useApplicationLifecycle(applicationId, environmentId);
  const redeploy = lifecycle.redeploy;
  // `POST /applications/:id/redeploy` is `deployment: ['create']`.
  const canDeploy = usePermission({ deployment: ["create"] });

  return (
    <Button
      size={size}
      disabled={!canDeploy.allowed || redeploy.isPending}
      title={canDeploy.allowed ? undefined : APPLICATION_DEPLOY_REFUSAL}
      aria-busy={redeploy.isPending || undefined}
      onClick={async () => {
        if (!canDeploy.allowed) return;
        try {
          const deployment = await redeploy.mutateAsync();
          toast.done("Rebuild queued.", {
            description:
              "It builds the source this Application already has — no new commit needed. The output streams below.",
          });
          onDeployed?.(deployment);
        } catch (error) {
          toast.error(error);
        }
      }}
    >
      <ActionIcon
        name="refresh"
        pending={redeploy.isPending}
        size={size === "sm" ? 14 : 15}
      />
      Redeploy
    </Button>
  );
}
