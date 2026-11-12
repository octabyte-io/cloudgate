import { useMutation, useQuery } from "@tanstack/react-query";

import type { ServiceType } from "@/lib/api/endpoints/applications";
import { domainsApi } from "@/lib/api/endpoints/domains";
import {
  serviceHealthApi,
  type CreateUptimeCheckInput,
  type PutErrorRateThresholdInput,
  type UpdateUptimeCheckInput,
} from "@/lib/api/endpoints/service-health";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The Health tab's writes and its pickers' reads. The summary read itself,
 * `useServiceHealth`, is `lib/api/use-service-health.ts`: the Overview's fact
 * line and the Environment's Health column read it too.
 */

/** The four writes. Each one drops the whole summary, every page of it. */
export function useUptimeCheckMutations(
  serviceType: ServiceType,
  serviceId: string,
) {
  const invalidate = useInvalidate();
  const done = () => invalidate.serviceHealth(serviceType, serviceId);

  return {
    create: useMutation({
      mutationFn: (input: CreateUptimeCheckInput) =>
        serviceHealthApi.createCheck(input),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (args: { uptimeCheckId: string; input: UpdateUptimeCheckInput }) =>
        serviceHealthApi.updateCheck(args.uptimeCheckId, args.input),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (uptimeCheckId: string) =>
        serviceHealthApi.removeCheck(uptimeCheckId),
      onSuccess: done,
    }),
  };
}

/** The threshold's two writes. Each one drops the whole summary, every page. */
export function useThresholdMutations(
  serviceType: ServiceType,
  serviceId: string,
) {
  const invalidate = useInvalidate();
  const done = () => invalidate.serviceHealth(serviceType, serviceId);

  return {
    put: useMutation({
      mutationFn: (input: PutErrorRateThresholdInput) =>
        serviceHealthApi.putThreshold(serviceType, serviceId, input),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: () => serviceHealthApi.removeThreshold(serviceType, serviceId),
      onSuccess: done,
    }),
  };
}

/**
 * The Domains an HTTP check may target: the Service's own, and nothing else.
 * Under the Domains tab's own key, so opening the modal after that
 * tab costs no request. A database has none — it is reached on a port — so
 * the query does not run for one.
 */
export function useServiceDomains(serviceType: ServiceType, serviceId: string) {
  const { organizationId } = useActiveOrganizationId();
  const parent =
    serviceType === "application" || serviceType === "compose"
      ? serviceType
      : null;
  return useQuery({
    queryKey:
      parent === "compose"
        ? keys.domains.byCompose(organizationId, serviceId)
        : keys.domains.byApplication(organizationId, serviceId),
    queryFn: () =>
      parent === "compose"
        ? domainsApi.byCompose(serviceId)
        : domainsApi.byApplication(serviceId),
    enabled: organizationId !== null && serviceId !== "" && parent !== null,
  });
}

/**
 * The TCP ports a check on this Service may dial, on which address, or why
 * there are none. Under the summary's key prefix, so a check write —
 * which drops the summary — refreshes it too.
 */
export function usePublishedPorts(serviceType: ServiceType, serviceId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.serviceHealth.publishedPorts(organizationId, serviceType, serviceId),
    queryFn: () => serviceHealthApi.publishedPorts(serviceType, serviceId),
    enabled: organizationId !== null && serviceId !== "",
  });
}
