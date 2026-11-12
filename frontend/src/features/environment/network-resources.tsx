import { useState } from "react";

import { Modal } from "@/components/console/modal";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { EnvironmentNetwork } from "@/lib/api/endpoints/environments";
import { errorMessage } from "@/lib/api/error-message";
import { usePermission } from "@/lib/auth/use-permission";

import {
  CloudResourceTable,
  RebuildStateModal,
  UnreadableStateBanner,
} from "@/components/console/cloud-resource-list";
import {
  NETWORK_REBUILD_REFUSAL,
  useNetworkCloudResources,
  useRebuildNetworkState,
} from "@/lib/api/use-cloud-resources";

/**
 * An Environment network's part of the resource list: **What it made** opens
 * its resource list (`environment: read`), read from its Infrastructure state
 * only when asked, since the card sits in the rail. A state Cloudgate cannot
 * read shows its banner here at once, from the network's own row, with Rebuild
 * from the cloud (`environment: update`), confirmed by the Environment's name.
 */
export function NetworkResources({
  environmentId,
  environmentName,
  network,
}: {
  environmentId: string;
  /** What Rebuild is confirmed with; `null` until the Environment is read. */
  environmentName: string | null;
  network: EnvironmentNetwork;
}) {
  const [listing, setListing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const list = useNetworkCloudResources(
    environmentId,
    network.environmentNetworkId,
    listing,
  );
  const permission = usePermission({ environment: ["update"] });
  const rebuild = useRebuildNetworkState(
    environmentId,
    network.environmentNetworkId,
  );
  const where = `Environment network (${network.region})`;

  return (
    <>
      {!network.stateReadable ? (
        <UnreadableStateBanner
          cloud={network.cloud}
          failure={null}
          allowed={permission.allowed && environmentName !== null}
          refusal={NETWORK_REBUILD_REFUSAL}
          onRebuild={() => setRebuilding(true)}
        />
      ) : null}
      <div>
        <Button type="button" size="sm" onClick={() => setListing(true)}>
          What it made
        </Button>
      </div>

      <Modal open={listing} onOpenChange={setListing} wide>
        <Modal.Header
          title={`What Cloudgate made for the ${where}`}
          description="Read from its Infrastructure state. A setting’s value is never shown."
        />
        <Modal.Body>
          {list.error ? (
            <p className="text-body text-tx-2">{errorMessage(list.error)}</p>
          ) : !list.data ? (
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          ) : !list.data.readable ? (
            <p className="text-body text-bad">{list.data.failure}</p>
          ) : (
            <CloudResourceTable
              list={list.data}
              label={`What the ${where} holds`}
            />
          )}
        </Modal.Body>
      </Modal>

      {environmentName !== null ? (
        <RebuildStateModal
          cloud={network.cloud}
          open={rebuilding}
          onOpenChange={setRebuilding}
          confirmWord={environmentName}
          mismatch="That does not match the Environment’s name."
          onConfirm={async () => {
            await rebuild.mutateAsync(environmentName);
            setRebuilding(false);
            toast.done(`Discarded the state of the ${where}.`, {
              description:
                network.cloud === "gcp"
                  ? "The Environment’s plan is reading Google Cloud, to take back what the names Cloudgate gave find."
                  : "The Environment’s plan is reading AWS, to take back what Cloudgate’s tags find.",
            });
          }}
        />
      ) : null}
    </>
  );
}
