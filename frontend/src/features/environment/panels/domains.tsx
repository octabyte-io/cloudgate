"use client";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { LinkButton } from "@/components/console/link-button";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { RowLink, RowSub } from "@/components/console/rows/cells";
import { Skeleton } from "@/components/console/skeleton";
import { domainColumns } from "@/features/application/domains/domain-columns";
import type { EnvironmentDomain } from "@/lib/api/endpoints/environments";
import { errorMessage } from "@/lib/api/error-message";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { EnvironmentFactsCard } from "../environment-facts-card";
import { RoutingCard } from "../routing-card";
import { serviceHref, serviceTabHref } from "@/components/shell/service-href";
import { useEnvironment, useEnvironmentDomains } from "../use-environments";

/**
 * Every domain answered by something in this Environment (the reference's
 * `envDomainsTab`, e-console.html:4053-4078).
 *
 * **This tab was a stated absence and is now a table**
 * the sibling of the
 * Deployments tab and for the same reason: domains are listed per owning service,
 * so gathering them here was a fan-out to decide on rather than a route to wait
 * for, and `GET /environments/:id/domains` is the decision — **one request**, over
 * the same join, with no partial state to render because nothing here can
 * half-fail.
 *
 * **A genuinely empty Environment is not a limitation.** An Environment whose
 * services own no host gets an empty state that invites the next step, because
 * that is a true and ordinary answer — and it is the answer for every Environment
 * holding only managed databases, since nothing routes to one from outside. That
 * distinction is most of what this change is about: "no host points here yet" and
 * "Cloudgate cannot gather these" are different sentences and only one of them is
 * still true of anything.
 *
 * **There is still no "Add a domain" button, and that is right regardless of the
 * feed.** `POST /domains` needs an `applicationId` or a `composeId`, so a domain
 * is always added *to a service* — this screen would have nothing to attach one
 * to. Editing is per-service for the same reason, which is where each row's
 * action goes.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const environment = useEnvironment(id);
  const domains = useEnvironmentDomains(id);
  const rows = domains.data ?? [];

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede="Every domain answered by something in this Environment, and which service answers it."
      />

      <Cols
        aside={
          <>
            <EnvironmentFactsCard environmentId={id} />
            <RoutingCard />
          </>
        }
        asideLabel="About this Environment"
      >
        <Card>
          <Card.Header
            title="Domains"
            sub={
              rows.length > 0
                ? `${rows.length} ${rows.length === 1 ? "host" : "hosts"} across ${countServices(rows)}.`
                : undefined
            }
            headingLevel={2}
          />
          <MetaStrip>
            A domain belongs to the <strong>service</strong>{" "}
            {/* `{" "}` because this compiler drops the space between an inline
                element and the text after it — "servicethat answers it" was on
                screen. The same fix the database backups card carries. */}
            that answers it, and when the change takes effect depends on which
            kind. For an Application, Traefik&rsquo;s configuration is rewritten
            as the domain is saved, so the host starts or stops being served
            within a second. For a Compose stack the domain travels as a label
            injected into the file at deploy time, so it waits for that
            stack&rsquo;s next Deployment.
          </MetaStrip>
          {domains.error ? (
            <Card.Body>
              <p className="text-body text-tx-2">
                {errorMessage(domains.error)}{' '}
                Nothing is listed until this
                Environment&rsquo;s domains can be read — an empty table would
                be a claim about what answers here.
              </p>
            </Card.Body>
          ) : domains.isPending ? (
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          ) : (
            <Card.Body flush>
              <DataTable
                label={`Domains in ${environment.data?.name ?? "this Environment"}`}
                columns={ENVIRONMENT_DOMAIN_COLUMNS}
                rows={rows}
                getRowId={(row) => row.domainId}
                rowName={(row) => row.host}
                defaultSort={{ id: "host", dir: "asc" }}
                empty={
                  <EmptyState
                    icon="globe"
                    title="No host points into this Environment yet"
                    action={
                      <LinkButton size="sm" href={`/environments/${id}`}>
                        Open the Services tab
                      </LinkButton>
                    }
                  >
                    A domain is added to the service that answers it. Open an
                    Application or a Compose stack here and add one on its
                    Domains tab — managed databases have none, because nothing
                    routes to one from outside.
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
 * F09's domain columns with the one column an Environment-level list needs and a
 * per-service list cannot have: **which service answers this host**.
 *
 * Built by splicing rather than by re-declaring, the way the Services tab reshapes
 * `serviceColumns()`: the host, path, port, scheme and certificate cells are the
 * same cells the Application's own Domains tab renders, and a second definition of
 * them is how two tables start disagreeing about what a certificate type means.
 *
 * `gate` is deliberately not passed. F18's forward-auth switch refuses a Compose
 * domain outright — a stack's routers travel as deploy-time labels, which carry no
 * middleware — and this is the one domains table that lists both kinds together,
 * so the column would be blank on every stack row. It stays on the Application's
 * own tab, which is the table F18 put it on.
 */
const ENVIRONMENT_DOMAIN_COLUMNS: Column<EnvironmentDomain>[] = (() => {
  // `action` is required by the shared builder and its cell is typed against the
  // bare `domain` row, so the placeholder is dropped and replaced below with one
  // that can see this feed's `service`. Every other cell is taken as it is.
  const cells: Column<EnvironmentDomain>[] = domainColumns({
    action: () => null,
  }).slice(0, -1);

  const service: Column<EnvironmentDomain> = {
    id: "service",
    head: "Service",
    compare: (a, b) => a.service.name.localeCompare(b.service.name),
    cell: (row) => (
      <>
        <RowLink href={serviceHref(row.service)}>{row.service.name}</RowLink>
        <RowSub>{SERVICE_KIND[row.service.serviceType]}</RowSub>
      </>
    ),
  };

  // Editing a domain belongs to the service that owns it: the dialog needs that
  // service's `appName` and Server address to generate a host and to check DNS,
  // neither of which an Environment-level feed carries.
  const open: Column<EnvironmentDomain> = {
    id: "action",
    head: <span className="sr-only">Actions</span>,
    tone: "num",
    cell: (row) => (
      <LinkButton size="xs" href={serviceTabHref(row.service, "domains")}>
        Open
      </LinkButton>
    ),
  };

  // Straight after the host: the host is what someone reads first, and "which
  // service" is the question the next glance asks.
  return [cells[0], service, ...cells.slice(1), open];
})();

/** What to call each kind under the service's name. The two deployable kinds are
 * the only ones that can own a domain, so the other six never render — they are
 * here because a `ServiceType` map that omits them would not type-check, and an
 * exhaustive one cannot go stale. */
const SERVICE_KIND: Record<
  EnvironmentDomain["service"]["serviceType"],
  string
> = {
  application: "Application",
  compose: "Compose stack",
  postgres: "Postgres",
  mysql: "MySQL",
  mariadb: "MariaDB",
  mongo: "MongoDB",
  redis: "Redis",
  libsql: "libSQL",
  bucket: "Bucket",
};

/** How many distinct services answer these hosts, in words. */
function countServices(rows: EnvironmentDomain[]): string {
  const count = new Set(rows.map((row) => row.service.serviceId)).size;
  return `${count} ${count === 1 ? "service" : "services"}`;
}
