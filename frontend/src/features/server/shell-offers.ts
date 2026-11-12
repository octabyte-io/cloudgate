import type { TerminalTarget } from "@/components/console/terminal-target";
import type { TerminalOffer } from "@/components/shell/terminal-offers";
import type { Server } from "@/lib/api/endpoints/servers";

import {
  localShellAddress,
  type LocalShellSession,
} from "./local/local-shell-values";

/**
 * The shells the Server screens put under the Dock's `+`.
 *
 * Each says only what the caller may open, by the rule the gateway applies, so
 * the `+` never lists a row that would be refused on connect.
 */

/** A Server's shell — the target its Terminal tab opens, byte for byte. */
export function serverTerminalTarget(server: Server): TerminalTarget {
  return {
    kind: "server",
    serverId: server.serverId,
    name: server.name,
    address: `${server.username}@${server.ipAddress}:${server.port}`,
  };
}

/**
 * The Server page's offer: its Server, when the caller holds `server: ['read']`
 * — what `/terminal` asks of the caller (`entitledToServerOrThrow`) — and the
 * Server has a key, without which the gateway closes the socket at once.
 */
export function serverShellOffers(
  server: Server,
  verdict: { allowed: boolean },
): TerminalOffer[] {
  if (!verdict.allowed || server.sshKeyId === null) return [];
  return [{ target: serverTerminalTarget(server) }];
}

/**
 * The fleet screen's offer: this host, as the This host card's fields ask for
 * it, to a caller with instance authority only — owner or admin of the
 * instance Organization, which is what the gateway asks before it dials
 * `serverId=local` (`checkInstanceAuthority`, ADR-0013). `authority` is
 * `useInfrastructureHealth()`, the read behind `useInstanceGate` that takes
 * the same authority.
 *
 * **Fails closed, unlike that gate.** `readGate` keeps a control live while
 * its read is pending or has failed, because pressing it asks the backend,
 * which answers. A row under `+` is a claim that the shell is the caller's to
 * open, so it waits until the read has succeeded — a member does not see this
 * host listed for a round trip, nor whenever the read is a 500.
 */
export function hostShellOffers(
  authority: { isSuccess: boolean },
  session: LocalShellSession | null,
): TerminalOffer[] {
  if (!authority.isSuccess || !session) return [];
  return [
    {
      target: {
        kind: "server",
        serverId: "local",
        name: "This host",
        address: localShellAddress(session),
      },
    },
  ];
}
