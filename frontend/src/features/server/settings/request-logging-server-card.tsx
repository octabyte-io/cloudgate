import type { Server } from "@/lib/api/endpoints/servers";
import { useDnsChallenge } from "@/lib/api/use-dns-challenge";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { readGate } from "@/lib/auth/use-permission";

import { useServerRequestLogging } from "../use-server";
import { RequestLoggingCard } from "./request-logging-card";

/**
 * This Server's Request logging card, beside Request metrics.
 *
 * **The gate is the DNS-01 read**, as for Request metrics beside it: the
 * switch takes `traefikTargetAuthority`, the same gate that read takes, and
 * the card above already reads it, so it costs no request. The state is
 * `GET /settings/traefik/requests` for this Server; a Server with no
 * `traefik.yml` reads as off, and the switch then answers its 404.
 */
export function RequestLoggingServerCard({ server }: { server: Server }) {
  const gate = readGate(useDnsChallenge(server.serverId));
  const state = useServerRequestLogging(server.serverId);
  const invalidate = useInvalidate();
  return (
    <RequestLoggingCard
      serverId={server.serverId}
      enabled={state.data?.enabled}
      readError={state.error}
      gate={gate}
      onChanged={() => invalidate.serverRequestLogging(server.serverId)}
    />
  );
}
