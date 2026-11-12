import Link from "next/link";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import { StatusPill } from "@/components/console/status-pill";
import {
  COMPOSE_TYPE_LABEL,
  runsOnStackVm,
  type ComposeDetail,
} from "@/lib/api/endpoints/compose";
import { timeExact } from "@/lib/format/time";

import { composeSourceSummary } from "./source/compose-source";
import { StackVmRunState } from "./stack-vm-status";

/**
 * What this stack is, in the rail beside whichever tab is open.
 *
 * The same shape and the same order as F09's `ApplicationFactsCard` and F11's
 * `DatabaseFactsCard`, deliberately: these three sit in the same slot of the same
 * shell, and a stack that described itself in a different order would read as a
 * different product.
 *
 * **`appName` is the fact worth showing most**, and for a stack it carries more
 * than it does for anything else: it is the compose *project* name (so every
 * container is `<appName>-<service>-N`) or the Swarm *stack* name (so every service
 * is `<appName>_<service>`), it is the name of the isolated network when isolation
 * is on, and it is the prefix every Traefik router this stack owns is named after.
 * It is also the string every one of the Containers and Logs queries is keyed by.
 */
export function ComposeFactsCard({
  compose,
  health,
}: {
  compose: ComposeDetail;
  /**
   * The Overview's health fact line, under Status. Only the Overview
   * passes it, so the other tabs' rail stays as it was.
   */
  health?: React.ReactNode;
}) {
  const { environment } = compose;
  const source = composeSourceSummary(compose);

  return (
    <Card>
      <Card.Header title="Stack" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow
            label="Status"
            value={
              // Keyed, so a change of status fades the new word in rather
              // than swapping it under the eye — the Application's recipe.
              <StatusPill
                key={compose.composeStatus}
                status={compose.composeStatus}
                className="animate-fade"
              />
            }
          />
          {health}
          <KVRow
            label="Deployed as"
            value={
              <Chip variant="brand">
                {COMPOSE_TYPE_LABEL[compose.composeType]}
              </Chip>
            }
          />
          <KVRow
            label="Stack name"
            value={compose.appName}
            title={compose.appName}
            mono
          />
          <KVRow
            label="Config name"
            value={compose.configName}
            title="Its fixed key in the Project config. Renaming the Service does not change it."
            mono
          />
          <KVRow label="Source" value={source.label} title={source.label} />
          {source.detail ? (
            <KVRow
              label="Repository"
              value={source.detail}
              title={source.detail}
              mono
            />
          ) : null}
          {compose.sourceType === "raw" ? null : (
            <KVRow
              label="File"
              value={compose.composePath}
              title={compose.composePath}
              mono
            />
          )}
          {/**
           * **Which network, and for which services**.
           *
           * This read `Shared cloudgate-network` for every non-isolated stack,
           * whatever its domains — and an operator reading that expects each
           * service in the stack to reach a managed database by name. Only the
           * routed ones do: `addDomainsToComposeSpec` joins a service per
           * *domain*, and `docker inspect` on a two-service stack with one
           * domain put `web` on `cloudgate-network` and the project default and
           * `cache` on the default alone. So the row names both networks, in the
           * words `converted-plan.ts` uses for the same rewrite, and the `title`
           * carries the tense the line cannot: the flag is stored now and
           * applied by the next Deployment.
           */}
          <KVRow
            label="Network"
            title={
              compose.isolatedDeployment
                ? `Its own network, from the next Deployment on. Each service a domain routes into joins ${compose.appName}; the rest reach only each other.`
                : "Each service a domain routes into joins cloudgate-network, from the next Deployment on, and reaches the rest of the platform by name. The rest reach only each other."
            }
            value={
              compose.isolatedDeployment ? (
                <span className="text-tx-2">
                  Its own default; routed services also join {compose.appName}
                </span>
              ) : (
                <span className="text-tx-2">
                  Its own default; routed services also join cloudgate-network
                </span>
              )
            }
          />
          <KVRow
            label="Environment"
            title={environment.name}
            value={
              <Link
                href={`/environments/${environment.environmentId}`}
                className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
              >
                {environment.name}
              </Link>
            }
          />
          <KVRow
            label="Project"
            title={environment.project.name}
            value={
              <Link
                href={`/projects/${environment.project.projectId}`}
                className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
              >
                {environment.project.name}
              </Link>
            }
          />
          {runsOnStackVm(compose) ? (
            // A Stack VM is part of the stack's place, never a Server
            // (ADR-0070): no link to the Servers list, and not this host.
            <KVRow
              label="Runs on"
              value={
                <span className="text-tx-2">
                  {compose.stackVmFacts?.made
                    ? `Its Stack VM, ${compose.stackVmFacts.machineType} in ${compose.stackVmFacts.region}`
                    : `Its Stack VM in ${compose.region}, not made yet`}
                </span>
              }
            />
          ) : (
            <KVRow
              label="Server"
              value={
                compose.server ? (
                  <Link
                    href={`/servers/${compose.server.serverId}`}
                    className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                  >
                    {compose.server.name}
                  </Link>
                ) : (
                  // Not a missing value: `serverId` null is how the platform's own
                  // host is spelled, and it is the common case on a single-node
                  // install. Saying "None" would read as unscheduled.
                  <span className="text-tx-2">This Cloudgate host</span>
                )
              }
            />
          )}
          {runsOnStackVm(compose) ? (
            <KVRow
              label="Stack VM"
              value={<StackVmRunState composeId={compose.composeId} />}
            />
          ) : null}
          <KVRow
            label="Created"
            value={timeExact(compose.createdAt) ?? <Dash word="Unknown" />}
          />
        </KVList>
      </Card.Body>
    </Card>
  );
}
