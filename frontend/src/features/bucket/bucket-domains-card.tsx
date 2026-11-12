import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Bucket } from "@/lib/api/endpoints/buckets";
import type { Domain } from "@/lib/api/endpoints/domains";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { DeleteDomainModal } from "@/features/application/domains/delete-domain-modal";
import { domainColumns } from "@/features/application/domains/domain-columns";
import { DomainFormModal } from "@/features/application/domains/domain-form-modal";

import {
  useBucketDomains,
  useCreateBucketDomain,
  useUpdateBucketDomain,
} from "./use-bucket-domains";

/** Garage's S3 API, where every Domain of a bucket routes. */
const GARAGE_S3_PORT = 3900;

/**
 * A Server bucket's Domains: where it answers from the internet, so
 * presigned URLs and browser uploads work as they do on S3. A plan-created
 * bucket starts with a generated one; the operator adds, edits and removes
 * them as any Domain, under the same `domain` rights. The oldest is its
 * `endpoint` Output, and with none left the endpoint is its internal URL.
 */
export function BucketDomainsCard({ bucket }: { bucket: Bucket }) {
  const domains = useBucketDomains(bucket.bucketId);
  const create = useCreateBucketDomain(bucket.bucketId);
  const update = useUpdateBucketDomain(bucket.bucketId);
  const canAdd = usePermission({ domain: ["create"] });
  const canRemove = usePermission({ domain: ["delete"] });

  const [editing, setEditing] = useState<Domain | null>(null);
  const [removing, setRemoving] = useState<Domain | null>(null);
  // Every opening is keyed: the form reads its defaults once (F09's defect 6).
  const [adding, setAdding] = useState(false);
  const [opening, setOpening] = useState(0);

  function openAddDialog() {
    setOpening((n) => n + 1);
    setAdding(true);
  }

  const rows = domains.data ?? [];
  const addButton = (size: "sm" | "xs") => (
    <Button
      variant="pri"
      size={size}
      disabled={!canAdd.allowed}
      title={
        canAdd.allowed ? undefined : "Adding a Domain needs domain: create."
      }
      onClick={openAddDialog}
    >
      <Icon name="plus" size={14} />
      Add a domain
    </Button>
  );

  return (
    <>
      <Card>
        <Card.Header
          title="Domains"
          sub="Where this bucket answers S3 requests from the internet. The oldest is its endpoint, so presigned URLs and browser uploads work."
          headingLevel={2}
          actions={addButton("sm")}
        />
        {domains.error ? (
          <Card.Body>
            <p className="text-body text-tx-2">{errorMessage(domains.error)}</p>
          </Card.Body>
        ) : domains.isPending ? (
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        ) : (
          <Card.Body flush>
            <DataTable
              label={`Domains of ${bucket.name}`}
              rows={rows}
              getRowId={(domain) => domain.domainId}
              defaultSort={{ id: "host", dir: "asc" }}
              columns={domainColumns({
                action: (domain) => (
                  <span className="inline-flex gap-1.5">
                    <Button
                      size="xs"
                      disabled={!canAdd.allowed}
                      onClick={() => setEditing(domain)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="dngr"
                      disabled={!canRemove.allowed}
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
                  title="This bucket has no Domain"
                  action={addButton("sm")}
                >
                  Add a domain to reach it from outside its Server: presigned
                  URLs and browser uploads do not work until it has one.
                </EmptyState>
              }
            />
          </Card.Body>
        )}
      </Card>

      <DomainFormModal
        key={`add-${opening}`}
        appName={bucket.appName}
        serverIp={null}
        serverId={bucket.serverId}
        domain={null}
        open={adding}
        onOpenChange={setAdding}
        create={(input) => create.mutateAsync(input)}
        update={(domainId, input) => update.mutateAsync({ domainId, input })}
        noun="bucket"
        fixedPort={GARAGE_S3_PORT}
      />
      <DomainFormModal
        key={editing?.domainId ?? "none"}
        appName={bucket.appName}
        serverIp={null}
        serverId={bucket.serverId}
        domain={editing}
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        create={(input) => create.mutateAsync(input)}
        update={(domainId, input) => update.mutateAsync({ domainId, input })}
        noun="bucket"
        fixedPort={GARAGE_S3_PORT}
      />
      <DeleteDomainModal
        bucketId={bucket.bucketId}
        domain={removing}
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
      />
    </>
  );
}
