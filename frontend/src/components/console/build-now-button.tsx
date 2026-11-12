// No `"use client"` — see the note in `application-actions.tsx`. Imported only
// from client entry points.

import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { wasRefused } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { useBuildNow } from "@/lib/api/use-build-now";
import { APPLICATION_DEPLOY_REFUSAL } from "@/lib/auth/application-refusals";
import { usePermission } from "@/lib/auth/use-permission";

/**
 * "Build now with saved settings" on a held build (US52): a push that
 * changed both an Application's code and its own config entry holds its
 * build until the plan is applied or dismissed, and this releases it at
 * once, with the settings saved now, so one plan nobody has reviewed does not
 * block an urgent fix. The plan stays open.
 *
 * Renders only for a `held` Deployment. A build the plan released meanwhile
 * answers 409, and the backend's sentence is shown.
 */
export function BuildNowButton({
  deployment,
  applicationId,
  onReleased,
  size = "xs",
}: {
  deployment: Pick<Deployment, "deploymentId" | "status">;
  applicationId: string;
  onReleased?: () => void;
  size?: "xs" | "sm";
}) {
  const buildNow = useBuildNow(applicationId);
  const canDeploy = usePermission({ deployment: ["create"] });

  if (deployment.status !== "held") return null;

  return (
    <Button
      size={size}
      disabled={!canDeploy.allowed || buildNow.isPending}
      aria-busy={buildNow.isPending || undefined}
      title={canDeploy.allowed ? undefined : APPLICATION_DEPLOY_REFUSAL}
      onClick={async () => {
        if (!canDeploy.allowed) return;
        try {
          await buildNow.mutateAsync(deployment.deploymentId);
          toast.done("The build is queued with the saved settings.");
          onReleased?.();
        } catch (error) {
          if (wasRefused(error)) {
            toast.warn(errorMessage(error));
            return;
          }
          toast.error(error);
        }
      }}
    >
      Build now with saved settings
    </Button>
  );
}
