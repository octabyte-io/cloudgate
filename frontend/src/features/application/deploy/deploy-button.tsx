import { useId } from "react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/console/toast";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { hasSource } from "@/lib/format/source";
import { usePermission } from "@/lib/auth/use-permission";

import { ActionIcon } from "../lifecycle/action-icon";
import {
  APPLICATION_DEPLOY_REFUSAL,
  useDeployApplication,
} from "../use-application";

/**
 * Deploy — build the source and release the result.
 *
 * `POST /applications/:id/deployments` writes a `pending` row with its log file
 * and enqueues the build, so what comes back is something to start streaming
 * immediately. `onDeployed` is handed that row, which is how the Deployments tab
 * opens the new build's log without waiting for the list to refetch.
 *
 * **It used to be the only lifecycle action an Application had**, and this
 * comment used to say so. Restart, Stop, Start, Redeploy and Cancel arrived
 * later; `lifecycle/` holds
 * them, and `ApplicationActions` is the row this button now sits in. Deploy is
 * still the one that is *primary*: it is the only one of them that changes what
 * is running from what is in the repository.
 */
/**
 * Why Deploy cannot work for this row yet, or `null`.
 *
 * With no source chosen the backend refuses the Deployment with a 409 —
 * `missingSource`'s "no source is chosen" — and the button used to be live
 * and answer with that toast. `hasSource` is the same rule, so a button that
 * is off and a deploy that is refused agree. A row still loading is not
 * refused for: `undefined` is "not known yet", never "no source".
 */
export function deployUnavailable(
  application: Parameters<typeof hasSource>[0] | undefined,
): string | null {
  if (!application || hasSource(application)) return null;
  return "No source is chosen yet. Choose one under Source on the Overview tab, then deploy.";
}

export function DeployButton({
  applicationId,
  environmentId,
  onDeployed,
  size = "default",
  variant = "pri",
  block,
  unavailable,
}: {
  applicationId: string;
  environmentId?: string;
  onDeployed?: (deployment: Deployment) => void;
  size?: "default" | "sm" | "xs";
  variant?: "pri" | "gh";
  /** Full width, for the actions card in the rail. */
  block?: boolean;
  /**
   * Why it cannot run now — {@link deployUnavailable}. Renders it off with the
   * reason beside it, `DangerZone`'s `unavailable` pattern.
   */
  unavailable?: string | null;
}) {
  const reasonId = useId();
  const deploy = useDeployApplication(applicationId, environmentId);
  // `deployment: ['create']`, the one statement Deploy needs — and
  // the one a role made "to deploy but not to change" is given, so this stays
  // live for it while Change source goes off.
  const canDeploy = usePermission({ deployment: ["create"] });

  // The role's refusal first: it is the one a source would not cure.
  const off = canDeploy.allowed ? (unavailable ?? null) : null;

  const button = (
    <Button
      size={size}
      variant={variant}
      className={block ? "w-full" : undefined}
      disabled={!canDeploy.allowed || deploy.isPending || off !== null}
      title={canDeploy.allowed ? (off ?? undefined) : APPLICATION_DEPLOY_REFUSAL}
      aria-describedby={off ? reasonId : undefined}
      aria-busy={deploy.isPending || undefined}
      onClick={async () => {
        if (!canDeploy.allowed || off) return;
        try {
          const deployment = await deploy.mutateAsync(undefined);
          toast.done("Deployment queued.", {
            description:
              "The build starts as soon as a worker picks it up; its output streams below.",
          });
          onDeployed?.(deployment);
        } catch (error) {
          toast.error(error);
        }
      }}
    >
      <ActionIcon
        name="play"
        pending={deploy.isPending}
        size={size === "xs" ? 13 : 15}
      />
      Deploy
    </Button>
  );
  if (!off) return button;
  return (
    <>
      {button}
      <span id={reasonId} className="text-meta text-tx-3">
        {off}
      </span>
    </>
  );
}
