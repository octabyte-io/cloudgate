import { DnsChallengeCard } from "@/components/console/dns-challenge-card";
import type { Server } from "@/lib/api/endpoints/servers";
import { useDnsChallenge } from "@/lib/api/use-dns-challenge";
import { readGate } from "@/lib/auth/use-permission";

/**
 * This Server's DNS-01 setup, the per-machine card the platform host
 * has on its Traefik screen.
 *
 * **The gate is the read beside the write**, `usePermission`'s rule's case 2:
 * both `/settings/traefik/dns-challenge` routes take `traefikTargetAuthority`,
 * whose Server branch is owner-or-admin plus access to this Server — a check
 * no statement names, so no `usePermission` call could say it. The card reads
 * the same query, so this costs no request.
 */
export function DnsChallengeServerCard({ server }: { server: Server }) {
  const gate = readGate(useDnsChallenge(server.serverId));
  return <DnsChallengeCard serverId={server.serverId} gate={gate} />;
}
