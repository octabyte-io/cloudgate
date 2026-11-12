// No `"use client"` — see the note in `application-actions.tsx`. Imported only
// from client entry points.

import { LinkButton } from "@/components/console/link-button";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { environmentPlanHref } from "@/lib/format/plan-href";

/**
 * "Review the open plan →" on a cloud Service's deploy that stopped: a deploy
 * no Apply queued met more than its new image in AWS, ended `error` before any
 * change, and its whole plan became the Environment's open plan. The plan names
 * the Deployment back.
 *
 * Renders only for a Deployment that names a plan, and once the Service's
 * Environment is known.
 */
export function ReviewPlanButton({
  deployment,
  place,
  size = "xs",
}: {
  deployment: Pick<Deployment, "reviewPlanId">;
  place: { projectId: string; environmentId: string } | null;
  size?: "xs" | "sm";
}) {
  if (!deployment.reviewPlanId || !place) return null;
  return (
    <LinkButton
      size={size}
      href={environmentPlanHref(place.projectId, place.environmentId)}
    >
      Review the open plan →
    </LinkButton>
  );
}
