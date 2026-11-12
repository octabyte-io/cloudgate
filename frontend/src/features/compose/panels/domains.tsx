"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { runsOnStackVm, type ComposeDetail } from "@/lib/api/endpoints/compose";
import type { Domain } from "@/lib/api/endpoints/domains";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { DeleteDomainModal } from "@/features/application/domains/delete-domain-modal";
import { DomainFormModal } from "@/features/application/domains/domain-form-modal";
import { domainColumns } from "@/features/application/domains/domain-columns";

import { ComposeFactsCard } from "../compose-facts-card";
import { ComposePanel } from "../compose-panel";
import { StackVmDomains } from "../domains/stack-vm-domains";
import {
  useComposeDomains,
  useCreateComposeDomain,
  useUpdateComposeDomain,
} from "../domains/use-compose-domains";
import { useComposeServices } from "../use-compose";

/**
 * The hosts this stack answers on — and, unlike an Application's, **which service
 * inside it** each one reaches.
 *
 * That extra column is the whole difference, and it is not cosmetic: a compose
 * domain with no `serviceName` makes the *deploy* throw before it writes anything
 * (`addDomainsToComposeSpec`), and one naming a service the file does not
 * declare does the same. So the service is a column here, it is a required field
 * in the dialog, and the Converted tab checks both against the file where it can
 * read it.
 *
 * Everything else is F09's, imported: the dialog (which takes its two writes as
 * props so one dialog serves both), the columns, the delete confirmation and the
 * DNS helper inside it. The reference's per-row **Status** column is absent for
 * F09's reason — nothing records whether Traefik is serving a host.
 */
export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      aside={(row) => <ComposeFactsCard compose={row} />}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`Where ${row.name} answers from the internet, and which service in its compose file each host routes into.`}
        />
      )}
    >
      {(row) =>
        // A stack on its Stack VM: its Domains are the cloud's (#1371).
        runsOnStackVm(row) ? (
          <StackVmDomains compose={row} />
        ) : (
          <Body compose={row} />
        )
      }
    </ComposePanel>
  );
}

function Body({ compose }: { compose: ComposeDetail }) {
  const domains = useComposeDomains(compose.composeId);
  const create = useCreateComposeDomain(compose.composeId);
  const update = useUpdateComposeDomain(compose.composeId);
  const services = useComposeServices(compose.composeId);

  const [editing, setEditing] = useState<Domain | null>(null);
  const [removing, setRemoving] = useState<Domain | null>(null);
  // Every opening is keyed — `useApiForm` reads `defaultValues` once, so a dialog
  // that stays mounted across a close keeps what was typed into it (F09's defect 6).
  const [adding, setAdding] = useState(false);
  const [opening, setOpening] = useState(0);

  function openAddDialog() {
    setOpening((n) => n + 1);
    setAdding(true);
  }

  const rows = domains.data ?? [];
  const serverIp = compose.server?.ipAddress ?? null;
  /**
   * The service list for the dialog's picker.
   *
   * `undefined` when the read failed, which is the normal state for a git-sourced
   * stack that has never been deployed — the route reads the file out of the clone.
   * The dialog falls back to a text field there rather than an empty picker.
   */
  const serviceChoice = {
    names: services.error ? undefined : services.data,
    pending: services.isPending,
  };

  return (
    <>
      <Card>
        <Card.Header
          title="Domains"
          sub={
            rows.length > 0
              ? `${rows.length} ${rows.length === 1 ? "host" : "hosts"} configured.`
              : undefined
          }
          headingLevel={2}
          actions={
            <Button variant="pri" size="sm" onClick={openAddDialog}>
              <Icon name="plus" size={14} />
              Add a domain
            </Button>
          }
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
            {rows.length > 0 ? (
              <MetaStrip>
                Traefik reads these as <strong>labels on the containers</strong>,
                written into the compose file when the stack is deployed — so a
                host added or changed here starts or stops being served on the next
                Deployment. The Converted tab says exactly what gets added.
              </MetaStrip>
            ) : null}
            <Card.Body flush>
              <DataTable
                label={`Domains of ${compose.name}`}
                rows={rows}
                getRowId={(domain) => domain.domainId}
                defaultSort={{ id: "host", dir: "asc" }}
                columns={domainColumns({
                  service: (domain) => domain.serviceName,
                  action: (domain) => (
                    <span className="inline-flex gap-1.5">
                      <Button size="xs" onClick={() => setEditing(domain)}>
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="dngr"
                        onClick={() => setRemoving(domain)}
                      >
                        Remove
                      </Button>
                    </span>
                  ),
                })}
                empty={
                  <EmptyState
                    icon="globe"
                    title="No domain points at this stack yet"
                    action={
                      <Button size="sm" variant="pri" onClick={openAddDialog}>
                        Add a domain
                      </Button>
                    }
                  >
                    Add a domain to reach this stack from the internet. The
                    dialog can generate a working host if you do not own one yet.
                  </EmptyState>
                }
              />
            </Card.Body>
          </>
        )}
      </Card>

      <DomainFormModal
        key={`add-${opening}`}
        appName={compose.appName}
        serverIp={serverIp}
        serverId={compose.serverId}
        domain={null}
        open={adding}
        onOpenChange={setAdding}
        create={(input) => create.mutateAsync(input)}
        update={(domainId, input) => update.mutateAsync({ domainId, input })}
        service={serviceChoice}
        noun="stack"
      />
      <DomainFormModal
        key={editing?.domainId ?? "none"}
        appName={compose.appName}
        serverIp={serverIp}
        serverId={compose.serverId}
        domain={editing}
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        create={(input) => create.mutateAsync(input)}
        update={(domainId, input) => update.mutateAsync({ domainId, input })}
        service={serviceChoice}
        noun="stack"
      />
      <DeleteDomainModal
        composeId={compose.composeId}
        domain={removing}
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
      />
    </>
  );
}
