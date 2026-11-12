import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { ServiceType } from "@/lib/api/endpoints/applications";
import {
  serviceHealthApi,
  type ServiceHealth,
  type ServiceHealthRow,
} from "@/lib/api/endpoints/service-health";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The two health reads more than one feature makes: a Service's
 * summary — the Health tab's one read, which the Overview's fact line shares
 * — and an Environment's batch, the Services table's Health
 * column. Promoted out of `features/service-health/` under §1.4 once
 * the Application, Compose, database and Environment features read them; the
 * Health tab's writes stay in that folder's `use-service-health.ts`.
 */

/** Incident history rows per page. */
export const INCIDENT_PAGE_SIZE = 20;

/**
 * How often the tab asks again. A check probes every 30 s at the fastest, so
 * this is the shortest wait after which the screen can have something new to
 * say — and nothing pushes a Probe or an Incident to the browser.
 */
export const HEALTH_REFETCH_MS = 30_000;

/**
 * A Service's health summary, one page of Incident history at a time.
 *
 * **One read for the whole tab**, and every section is handed it rather than
 * fetching its own: the banner, the checks and the history are three views of
 * one answer, and three requests could disagree about whether an Incident is
 * open. `keepPreviousData` keeps the other sections still while the pager
 * turns. A section that wants one slice of it passes `select`: same key, same
 * request, same cache entry.
 */
export function useServiceHealth<T = ServiceHealth>(
  serviceType: ServiceType,
  serviceId: string,
  page: number,
  select?: (health: ServiceHealth) => T,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery<ServiceHealth, Error, T>({
    select,
    queryKey: keys.serviceHealth.page(organizationId, serviceType, serviceId, page),
    queryFn: () =>
      serviceHealthApi.summary(serviceType, serviceId, {
        page,
        limit: INCIDENT_PAGE_SIZE,
      }),
    enabled: organizationId !== null && serviceId !== "",
    placeholderData: keepPreviousData,
    refetchInterval: HEALTH_REFETCH_MS,
  });
}

/**
 * Every visible Service's health in one Environment, in **one** request — the
 * Services table asks this once, never once per row. Polled on the Health
 * tab's own cadence, since nothing pushes a Probe to the browser.
 */
export function useEnvironmentHealth(environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.serviceHealth.environment(organizationId, environmentId),
    queryFn: () => serviceHealthApi.environment(environmentId),
    enabled: organizationId !== null && environmentId !== "",
    refetchInterval: HEALTH_REFETCH_MS,
    select: (health) =>
      new Map<string, ServiceHealthRow>(
        health.services.map((row) => [
          `${row.serviceType}:${row.serviceId}`,
          row,
        ]),
      ),
  });
}
