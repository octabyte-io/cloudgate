import { useMutation } from "@tanstack/react-query";

import { deploymentsApi } from "@/lib/api/endpoints/deployments";
import { useInvalidate } from "@/lib/api/use-invalidate";

/**
 * **Run now** on a Cron service: its Run record joins the
 * Application's Deployments, which are refreshed — on settle, not only on
 * success, since a run may have been recorded when the answer is lost
 * (§3.5).
 */
export function useRunCronService(applicationId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => deploymentsApi.runCronService(applicationId),
    onSettled: async () => {
      await invalidate.deployments(applicationId);
    },
  });
}
