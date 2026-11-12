import { useState } from "react";

import { Card } from "@/components/console/card";
import { Skeleton } from "@/components/console/skeleton";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import type { Domain } from "@/lib/api/endpoints/domains";
import { errorMessage } from "@/lib/api/error-message";
import { useCloudAccounts } from "@/lib/api/use-cloud-accounts";

import { CloudRemoveDomainModal } from "@/features/application/domains/cloud-domain-modals";
import { CloudDomainsCard } from "@/features/application/domains/cloud-domains-card";

import { useComposeServices } from "../use-compose";
import { StackVmDomainFormModal } from "./stack-vm-domain-modal";
import {
  useComposeDomains,
  useCreateComposeDomain,
  useUpdateComposeDomain,
} from "./use-compose-domains";

/**
 * **The Domains of a stack on its Stack VM** (ADR-0070, #1371): the cloud
 * Domain card, as a cloud Service's, each Domain with the two DNS records
 * to add and its certificate's status, and the Stack VM's own dialog, which
 * asks for a host of your own, the service and its port, and never offers a
 * generated host.
 *
 * Which cloud the stack is in decides the words (ACM or Certificate
 * Manager, a CNAME or an A record): read from its Cloud account, or from a
 * Domain's record when the account list is not readable.
 */
export function StackVmDomains({ compose }: { compose: ComposeDetail }) {
  const domains = useComposeDomains(compose.composeId);
  const create = useCreateComposeDomain(compose.composeId);
  const update = useUpdateComposeDomain(compose.composeId);
  const services = useComposeServices(compose.composeId);
  const accounts = useCloudAccounts();

  const [editing, setEditing] = useState<Domain | null>(null);
  const [removing, setRemoving] = useState<Domain | null>(null);
  const [adding, setAdding] = useState(false);
  const [opening, setOpening] = useState(0);

  const rows = domains.data ?? [];
  const account = accounts.data?.find(
    (one) => one.cloudAccountId === compose.cloudAccountId,
  );
  const google = account
    ? account.cloud === "gcp"
    : rows.some((one) => one.cloud?.servedBy === "fixed-ip");
  const serviceChoice = {
    names: services.error ? undefined : services.data,
    pending: services.isPending,
  };
  const parent = { composeId: compose.composeId };

  if (domains.error || domains.isPending) {
    return (
      <Card>
        <Card.Header title="Domains" headingLevel={2} />
        <Card.Body>
          {domains.error ? (
            <p className="text-body text-tx-2">{errorMessage(domains.error)}</p>
          ) : (
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          )}
        </Card.Body>
      </Card>
    );
  }

  return (
    <>
      <CloudDomainsCard
        parent={parent}
        domains={rows}
        cloudRun={google}
        stackVm
        onAdd={() => {
          setOpening((n) => n + 1);
          setAdding(true);
        }}
        onEdit={setEditing}
        onRemove={setRemoving}
      />
      <StackVmDomainFormModal
        key={`add-${opening}`}
        domain={null}
        google={google}
        services={serviceChoice}
        open={adding}
        onOpenChange={setAdding}
        create={(input) => create.mutateAsync(input)}
        update={(domainId, input) => update.mutateAsync({ domainId, input })}
      />
      <StackVmDomainFormModal
        key={editing?.domainId ?? "none"}
        domain={editing}
        google={google}
        services={serviceChoice}
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        create={(input) => create.mutateAsync(input)}
        update={(domainId, input) => update.mutateAsync({ domainId, input })}
      />
      <CloudRemoveDomainModal
        parent={parent}
        domain={removing}
        cloudRun={google}
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
      />
    </>
  );
}
