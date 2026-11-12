"use client";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { EmptyState } from "@/components/console/empty-state";
import { LinkButton } from "@/components/console/link-button";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { DeploymentTable } from "@/components/console/rows/deployment-row";
import { Skeleton } from "@/components/console/skeleton";
import type { EnvironmentDeployment } from "@/lib/api/endpoints/environments";
import { errorMessage } from "@/lib/api/error-message";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { EnvironmentFactsCard } from "../environment-facts-card";
import { serviceHref, serviceTabHref } from "@/components/shell/service-href";
import { useEnvironment, useEnvironmentDeployments } from "../use-environments";

/**
 * Every build and release into this Environment (the reference's
 * `envDeploymentsTab`, e-console.html:4080-4095).
 *
 * **This tab was a stated absence and is now a table**
 * The gap was never a
 * missing list — every Deployment read is keyed by a *service* id — it was that
 * gathering them here meant one request per service on every open, and then a
 * decision about what the screen says when three of eleven of those fail.
 * `GET /environments/:id/deployments` is the answer that was taken: **one
 * request**, over the join the Organization feed already writes, so this screen
 * has no partial state because it makes no set of requests that can half-fail.
 * `DeploymentTable` (F07) was built and waiting for these rows.
 *
 * **The Service column names the service; the sub-line says when the row is not a
 * build.** A `deployment` row belongs to whatever ran it, and three of the five
 * owner kinds are not services: a cron entry, a volume backup and a database
 * backup all write Deployment rows. So the column links to the service — which is
 * what someone scanning this list is looking for — and names the run underneath,
 * because otherwise a Postgres instance appearing here is unexplained.
 *
 * **There is no log well and no log dialog on this tab, deliberately.** A live
 * build's output is tailed over a socket on the Server that is building
 * (`DeploymentLog` takes a `serverId`), and this feed carries the service but not
 * its Server — an Environment has no single one. Rather than pass `null` and
 * quietly tail the wrong host, the row's action goes to the service's own
 * Deployments tab, which knows its Server and already holds the dialog. The list
 * still **polls while anything here is building** so the statuses move
 * (`use-environments.ts`).
 *
 * The reference's Triggers aside is absent for its own reason: "deploy on push"
 * and pull-request previews are per-service settings on an `application` row, not
 * an Environment-level switch, so a switch here would write nothing.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const environment = useEnvironment(id);
  const deployments = useEnvironmentDeployments(id);
  const rows = deployments.data ?? [];

  // `DeploymentTable`'s callbacks are typed against the plain `deployment` row,
  // which is the shape every other caller has. Looking this feed's row back up by
  // id keeps the extra two fields typed instead of casting them in.
  const feedRow = (deploymentId: string) =>
    rows.find((row) => row.deploymentId === deploymentId) ?? null;

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede="Every build and release into this Environment, newest first."
      />

      <Cols
        aside={<EnvironmentFactsCard environmentId={id} />}
        asideLabel="About this Environment"
      >
        <Card>
          <Card.Header
            title="Deployments"
            sub={
              rows.length > 0
                ? `${rows.length} ${rows.length === 1 ? "attempt" : "attempts"} across ${countServices(rows)}.`
                : undefined
            }
            headingLevel={2}
          />
          {/* One sentence (design-system.md rule 8). This gathers what the
              Services here have done; there is no Deploy on an Environment. */}
          <MetaStrip>
            Deployments run <strong>on a Service</strong>, not an Environment:
            open one to build it again or to read its output.
          </MetaStrip>
          {deployments.error ? (
            <Card.Body>
              {/* Nothing is listed until this Environment's Deployments can be
                  read: an empty table would be a claim about what has happened
                  here. */}
              <p className="text-body text-tx-2">
                {errorMessage(deployments.error)}
              </p>
            </Card.Body>
          ) : deployments.isPending ? (
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          ) : (
            // Mounts once, when the skeleton gives way; a refetch keeps it.
            <Card.Body flush className="animate-rise">
              <DeploymentTable
                label={`Deployments in ${environment.data?.name ?? "this Environment"}`}
                deployments={rows}
                owner={(row) => {
                  const found = feedRow(row.deploymentId);
                  if (!found) return null;
                  return {
                    label: found.service.name,
                    href: serviceHref(found.service),
                    path: runLabel(found),
                  };
                }}
                action={(row) => {
                  const found = feedRow(row.deploymentId);
                  if (!found) return null;
                  return (
                    <LinkButton
                      size="xs"
                      href={serviceTabHref(found.service, "deployments")}
                    >
                      Open
                    </LinkButton>
                  );
                }}
                empty={
                  <EmptyState
                    icon="rocket"
                    title="Nothing has been deployed here yet"
                    action={
                      <LinkButton size="sm" href={`/environments/${id}`}>
                        Open the Services tab
                      </LinkButton>
                    }
                  >
                    Deploy a Service from the Services tab, and every attempt
                    shows up here.
                  </EmptyState>
                }
              />
            </Card.Body>
          )}
        </Card>
      </Cols>
    </Page>
  );
}

/**
 * What the row is, when it is not the service's own build — the sub-line under
 * the Service column.
 *
 * `undefined` for a build, because "api / api" would be noise. The three run kinds
 * get the name of the thing that ran, since the service alone does not explain why
 * a managed database has a Deployment at all.
 */
function runLabel(row: EnvironmentDeployment): string | undefined {
  switch (row.owner.type) {
    case "application":
    case "compose":
      return undefined;
    case "schedule":
      return `Scheduled run · ${row.owner.name}`;
    case "volumeBackup":
      return `Volume backup · ${row.owner.name}`;
    case "backup":
      return `Database backup · ${row.owner.name}`;
  }
}

/** How many distinct services these attempts came from, in words. */
function countServices(rows: EnvironmentDeployment[]): string {
  const count = new Set(rows.map((row) => row.service.serviceId)).size;
  return `${count} ${count === 1 ? "service" : "services"}`;
}
