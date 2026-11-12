import { useState } from "react";

import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import { DeploymentModal } from "@/features/application/deploy/deployment-modal";
import { isGoogleLeftover } from "@/lib/api/endpoints/applications";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import type {
  EnvironmentNetwork,
  EnvironmentNetworkStatus,
} from "@/lib/api/endpoints/environments";
import type { Mark } from "@/lib/design/status";

import { NetworkResources } from "./network-resources";
import { useEnvironment, useEnvironmentNetworks } from "./use-environments";

/** Each network status in a word (ADR-0038). */
const NETWORK_MARK: Record<EnvironmentNetworkStatus, Mark> = {
  creating: { glyph: "◐", tone: "warn", label: "being made" },
  ready: { glyph: "●", tone: "ok", label: "ready" },
  "create-failed": { glyph: "✕", tone: "bad", label: "not made" },
  deleting: { glyph: "◐", tone: "warn", label: "deleting" },
  "delete-incomplete": { glyph: "✕", tone: "bad", label: "delete incomplete" },
};

/**
 * The Environment's networks in Cloud accounts
 * in the rail
 * beside its Services: each one's status, its load balancer's address — on
 * Google Cloud its fixed IP, which a Domain's `A` record points at
 * — and
 * **its idle cost, shown even when no Service runs in it**, since its load
 * balancer bills until the network is removed (US32). Its newest
 * run opens as any Deployment does, log included. While Google holds a
 * removed network's subnet
 * it says so,
 * and when Cloudgate tries again by itself.
 *
 * Renders nothing for an Environment with no network, which is every
 * Environment whose Services run on a Server or the platform host.
 */
export function EnvironmentNetworkCard({
  environmentId,
}: {
  environmentId: string;
}) {
  const networks = useEnvironmentNetworks(environmentId).data ?? [];
  const environmentName = useEnvironment(environmentId).data?.name ?? null;
  const [open, setOpen] = useState<Deployment | null>(null);
  if (networks.length === 0) return null;

  return (
    <Card>
      <Card.Header
        title={
          networks.length === 1 ? "Environment network" : "Environment networks"
        }
        sub="Shared by this Environment’s Services in a Cloud account."
        headingLevel={2}
      />
      <Card.Body>
        <div className="grid gap-4">
          {networks.map((network) => (
            <NetworkFacts
              key={network.environmentNetworkId}
              network={network}
              onOpenRun={setOpen}
              resources={
                <NetworkResources
                  environmentId={environmentId}
                  environmentName={environmentName}
                  network={network}
                />
              }
            />
          ))}
        </div>
      </Card.Body>
      <DeploymentModal
        deployment={open}
        open={open !== null}
        onOpenChange={(next) => (next ? undefined : setOpen(null))}
        noun="Environment network"
      />
    </Card>
  );
}

function NetworkFacts({
  network,
  onOpenRun,
  resources,
}: {
  network: EnvironmentNetwork;
  onOpenRun: (run: Deployment) => void;
  /** Its resource list and an unreadable state's Rebuild. */
  resources: React.ReactNode;
}) {
  const run = network.lastRun;
  return (
    <div className="grid gap-1.5">
      <KVList>
        <KVRow
          label="Where"
          value={`${network.cloudAccountName}, ${network.region}`}
        />
        <KVRow
          label="Status"
          value={<StatusPill mark={NETWORK_MARK[network.status]} />}
        />
        {network.cloud === "gcp" ? (
          <KVRow
            label="Fixed IP"
            value={network.ipAddress ?? "Not made yet"}
            mono={network.ipAddress !== null}
          />
        ) : (
          <KVRow
            label="Load balancer"
            value={network.albDnsName ?? "Not made yet"}
            title={network.albDnsName ?? undefined}
            mono={network.albDnsName !== null}
          />
        )}
        <KVRow label="Idle cost" value={network.idleCost} />
        <KVRow
          label="Services in it"
          value={
            network.serviceCount === 0
              ? "None — it still bills"
              : String(network.serviceCount)
          }
        />
      </KVList>
      {network.leftovers.length > 0 ? (
        <div className="text-meta text-bad">
          <p>Left in the Cloud account by its removal:</p>
          <ul className="ml-4 list-disc">
            {network.leftovers.map((left) =>
              isGoogleLeftover(left) ? (
                <li
                  key={`${left.type}:${left.region}:${left.googleName}`}
                  className="font-mono wrap-anywhere"
                >
                  {left.type} {left.googleName} ({left.region}
                  {left.label ? `, ${left.label}` : ", found by its name"})
                </li>
              ) : (
                <li
                  key={`${left.type}:${left.awsId}`}
                  className="font-mono wrap-anywhere"
                >
                  {left.type} {left.awsId}
                  {left.tag ? ` (${left.tag})` : " (made by AWS)"}
                </li>
              ),
            )}
          </ul>
          {network.subnetHold ? <p>{network.subnetHold}</p> : null}
        </div>
      ) : null}
      {run ? (
        <div className="flex flex-wrap items-center gap-2 text-meta text-tx-2">
          <StatusPill status={run.status} />
          <span className="min-w-0 flex-1 truncate">
            {run.description ?? run.title}
          </span>
          <Button type="button" size="sm" onClick={() => onOpenRun(run)}>
            Open its log
          </Button>
        </div>
      ) : null}
      {resources}
    </div>
  );
}
