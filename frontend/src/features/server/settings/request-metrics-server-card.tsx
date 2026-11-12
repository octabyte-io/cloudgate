import { RequestMetricsCard } from "@/components/console/request-metrics-card";
import type { Server } from "@/lib/api/endpoints/servers";
import { useDnsChallenge } from "@/lib/api/use-dns-challenge";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { readGate } from "@/lib/auth/use-permission";

/**
 * This Server's Enable request metrics (ADR-0027), beside its DNS-01
 * card — the other Traefik control a Server has, since it has no Traefik
 * screen of its own.
 *
 * **The gate is the DNS-01 read**, `usePermission`'s rule's case 2: it takes
 * `traefikTargetAuthority`, the same gate the restart and this route take, and
 * the card beside this one already reads it, so it costs no request. The state
 * is the Server row's `requestMetricsEnabled`.
 */
export function RequestMetricsServerCard({ server }: { server: Server }) {
  const gate = readGate(useDnsChallenge(server.serverId));
  const invalidate = useInvalidate();
  return (
    <RequestMetricsCard
      serverId={server.serverId}
      enabled={server.requestMetricsEnabled}
      gate={gate}
      onEnabled={() => invalidate.server(server.serverId)}
    />
  );
}
