import { useMutation, useQuery } from "@tanstack/react-query";

import { operatorAbuseApi } from "@/lib/api/endpoints/operator-abuse";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";

/** Every open abuse report; asked only for an Operator. */
export function useOpenAbuseReports(enabled: boolean) {
  return useQuery({
    queryKey: keys.operatorAbuseReports(),
    queryFn: operatorAbuseApi.reports,
    enabled,
    retry: false,
  });
}

/** Forward an abuse report to an Organization's owners and admins. */
export function useForwardAbuseReport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      organizationId,
      report,
    }: {
      organizationId: string;
      report: string;
    }) => operatorAbuseApi.forward(organizationId, report),
    onSettled: () => invalidate.operatorAbuseReports(),
  });
}

/** Close an open abuse report. */
export function useCloseAbuseReport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (reportId: string) => operatorAbuseApi.close(reportId),
    onSettled: () => invalidate.operatorAbuseReports(),
  });
}

/** Power a Bought Server off at once, with the reason its owners see. */
export function usePowerOff() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      boughtServerId,
      reason,
    }: {
      boughtServerId: string;
      reason: string;
    }) => operatorAbuseApi.powerOff(boughtServerId, reason),
    onSettled: () => invalidate.operatorPower(),
  });
}

/** Power a Bought Server back on. */
export function usePowerOn() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (boughtServerId: string) =>
      operatorAbuseApi.powerOn(boughtServerId),
    onSettled: () => invalidate.operatorPower(),
  });
}
