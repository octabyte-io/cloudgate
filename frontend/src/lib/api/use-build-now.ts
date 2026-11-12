import { useMutation } from "@tanstack/react-query";

import { deploymentsApi } from "@/lib/api/endpoints/deployments";
import { useInvalidate } from "@/lib/api/use-invalidate";

/**
 * "Build now with saved settings": releases a build a push held for a
 * plan. A build released meanwhile answers 409, shown as a fact. Read by the
 * Application's Deployments and by the plan view's held builds, which is why
 * it lives here and not in either feature.
 */
export function useBuildNow(applicationId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (deploymentId: string) => deploymentsApi.buildNow(deploymentId),
    onSettled: () => invalidate.heldBuild(applicationId),
  });
}
