import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Domain } from "@/lib/api/endpoints/domains";

import { DomainGateSwitch } from "@/features/enterprise/forward-auth/domain-gate-switch";

import { TraefikConfigStatusNotice } from "../traefik-status/config-status-notice";
import { rejectedDomainIds } from "../traefik-status/rejections";
import type { useTraefikConfigStatus } from "../traefik-status/use-config-status";
import { domainColumns } from "./domain-columns";
import type { useApplicationDomains } from "./use-domains";

/**
 * The hosts this Application answers on.
 *
 * The strip above the table is the one thing a reader has to know before they trust
 * the list, and it once
 * said the opposite of what happens: **the route is live before the dialog closes.**
 * `DomainsService.create` awaits `regenerateTraefikConfig` inside the request, which
 * rewrites `dynamic/<appName>.yml`, and Traefik's file provider watches that
 * directory and reloads in under a second. Delete is the same.
 *
 * Saying it waited for a Deployment was wrong in the expensive direction: it told an
 * operator to redeploy a working Application to activate a route that was already
 * serving. **A Compose stack is the case that genuinely does wait** — its routers
 * travel as labels injected at deploy time and `regenerateTraefikConfig` returns
 * early for one — but this card is the Application's; the Compose screen has a strip
 * of its own that already says so.
 *
 * **What Traefik made of it goes above the table** (H-38/H-62). The strip below
 * says the route goes live within a second, and until this landed there was
 * nothing on any screen for the case where it does not: Traefik refuses a
 * router it cannot build, drops it, and writes one line to its own log. That
 * report belongs here because the Domain is the row that stops being served —
 * and `TraefikConfigStatusNotice` is careful that the two quiet answers
 * ("nothing was logged", "Traefik could not be asked") never read as a tick.
 */
export function DomainsCard({
  domains,
  status,
  canAdd,
  onAdd,
  onEdit,
  onRemove,
}: {
  domains: ReturnType<typeof useApplicationDomains>;
  /**
   * Traefik's verdict on the configuration these rows generated.
   *
   * A prop rather than a hook call inside the card, for the reason the two
   * mutations above it are props: F12's Compose stacks render this same card
   * with their own parent, and a stack has no per-Application Traefik status to
   * read — `regenerateTraefikConfig` returns early for one, since a stack's
   * routers travel as deploy-time labels. Passing it keeps that caller able to
   * omit it rather than having to suppress a request it must not make.
   */
  status?: ReturnType<typeof useTraefikConfigStatus>;
  /** The Application row has arrived, so the dialog has a parent to write to. */
  canAdd: boolean;
  onAdd: () => void;
  onEdit: (domain: Domain) => void;
  onRemove: (domain: Domain) => void;
}) {
  const rows = domains.data ?? [];
  const darkened = rejectedDomainIds(status?.data);

  return (
    <Card>
      <Card.Header
        title="Domains"
        sub={
          rows.length > 0
            ? `${rows.length} ${rows.length === 1 ? "host" : "hosts"} configured.`
            : undefined
        }
        headingLevel={2}
      />

      {domains.error ? (
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(domains.error)}</p>
        </Card.Body>
      ) : domains.isPending ? (
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : (
        <>
          {status && rows.length > 0 ? (
            <TraefikConfigStatusNotice query={status} />
          ) : null}
          {rows.length > 0 ? (
            <MetaStrip>
              Traefik&rsquo;s configuration is rewritten as soon as a host here is
              added, changed or removed, so it starts or stops being served{" "}
              <strong>within a second</strong> — no Deployment needed.
            </MetaStrip>
          ) : null}
          <Card.Body flush>
            <DataTable
              label="Domains of this Application"
              rows={rows}
              getRowId={(domain) => domain.domainId}
              defaultSort={{ id: "host", dir: "asc" }}
              columns={domainColumns({
                // F18's one line on this screen. The switch cannot live on
                // F18's own settings page because nothing enumerates an
                // Organization's domains — the services are enumerable now,
                // which turns that into a fan-out decision rather than a
                // missing route, and either way the row that already holds a
                // `domainId` is where the join is free.
                gate: (domain) => (
                  <DomainGateSwitch
                    domainId={domain.domainId}
                    host={domain.host}
                  />
                ),
                troubled: (domain) => darkened.has(domain.domainId),
                action: (domain) => (
                  <span className="inline-flex gap-1.5">
                    <Button size="xs" onClick={() => onEdit(domain)}>
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="dngr"
                      onClick={() => onRemove(domain)}
                    >
                      Remove
                    </Button>
                  </span>
                ),
              })}
              empty={
                <EmptyState
                  icon="globe"
                  title="No domain points here yet"
                  action={
                    <Button
                      size="sm"
                      variant="pri"
                      onClick={onAdd}
                      disabled={!canAdd}
                    >
                      Add a domain
                    </Button>
                  }
                >
                  Add a domain to reach this Application from the internet. The
                  dialog can generate a working host if you do not own one yet.
                </EmptyState>
              }
            />
          </Card.Body>
        </>
      )}
    </Card>
  );
}
