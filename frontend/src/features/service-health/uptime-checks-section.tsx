import { ResourceList } from "@/components/console/resource-list";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { ServiceType } from "@/lib/api/endpoints/applications";
import type {
  ServiceHealth,
  UptimeCheckHealth,
} from "@/lib/api/endpoints/service-health";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { useServiceHealth } from "@/lib/api/use-service-health";

import { uptimeCheckSpec } from "./uptime-check-spec";
import {
  usePublishedPorts,
  useServiceDomains,
  useUptimeCheckMutations,
} from "./use-service-health";

/**
 * **The Health tab's Uptime checks** — the second section, under the
 * open-Incident banner.
 *
 * A `ResourceList`, so Add, Edit and Remove sit where they sit on every other
 * list, open the same modal and are off with the reason for a role without
 * `service: ['update']`. What this file adds is **Turn off / Turn
 * on** as a row control: silencing a check is the everyday action and it
 * should not take opening the modal to find the switch. It is the same `PATCH`
 * with `{ enabled }` and the same statement.
 *
 * The rows are the summary's `uptimeChecks`, not a second list request: the
 * banner and the history are read from the same answer, and two reads could
 * disagree about whether a check has an open Incident.
 *
 * Every Service kind gets the same list: a database's checks are TCP
 * checks on its external port, which the modal asks for without asking the
 * kind, and an Application's or a Compose's may be either.
 */
export function UptimeChecksSection({
  serviceType,
  serviceId,
  page,
}: {
  serviceType: ServiceType;
  serviceId: string;
  /** The history's page, so this reads the same cache entry as the panel. */
  page: number;
}) {
  return <Checks serviceType={serviceType} serviceId={serviceId} page={page} />;
}

/** The summary's checks, as the list `ResourceList` takes. Stable, so `select` memoises. */
const checksOf = (health: ServiceHealth): UptimeCheckHealth[] => health.uptimeChecks;

function Checks({
  serviceType,
  serviceId,
  page,
}: {
  serviceType: ServiceType;
  serviceId: string;
  page: number;
}) {
  // The summary's error and pending state are this list's, so a refused read
  // is a refusal here too, never an empty list.
  const checks = useServiceHealth(serviceType, serviceId, page, checksOf);
  const domains = useServiceDomains(serviceType, serviceId);
  const publishedPorts = usePublishedPorts(serviceType, serviceId);
  const mutations = useUptimeCheckMutations(serviceType, serviceId);
  const canUpdate = usePermission({ service: ["update"] });

  async function setEnabled(row: UptimeCheckHealth, enabled: boolean) {
    try {
      await mutations.update.mutateAsync({
        uptimeCheckId: row.uptimeCheckId,
        input: { enabled },
      });
      toast.done(enabled ? "Uptime check turned on." : "Uptime check turned off.");
    } catch (error) {
      toast.error(error);
    }
  }

  const spec = uptimeCheckSpec({
    serviceType,
    serviceId,
    domains: domains.data ?? [],
    // A database's query never runs, so `isPending` would read loading forever.
    domainsPending: domains.isPending && domains.fetchStatus !== "idle",
    publishedPorts: publishedPorts.data,
    publishedPortsPending: publishedPorts.isPending,
    create: (input) => mutations.create.mutateAsync(input),
    update: (uptimeCheckId, input) =>
      mutations.update.mutateAsync({ uptimeCheckId, input }),
    remove: (uptimeCheckId) => mutations.remove.mutateAsync(uptimeCheckId),
    rowExtras: (row) => {
      const refusal = roleRefusal(
        row.enabled ? "turn this Uptime check off" : "turn this Uptime check on",
      );
      return (
        <Button
          size="xs"
          disabled={!canUpdate.allowed || mutations.update.isPending}
          title={canUpdate.allowed ? undefined : refusal}
          onClick={() => canUpdate.allowed && setEnabled(row, !row.enabled)}
        >
          {row.enabled ? "Turn off" : "Turn on"}
        </Button>
      );
    },
  });

  return <ResourceList spec={spec} query={checks} />;
}
