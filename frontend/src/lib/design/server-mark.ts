import type { Server } from "@/lib/api/endpoints/servers";

import { STATUS, type Mark } from "./status";

/**
 * What a Server wears beside its name.
 *
 * **Not `serverStatus` drawn as health.** That column is written only by cloud
 * billing (`BillingService`, the Stripe webhook), so on a self-hosted instance
 * it is `active` for ever and no console control sets it — and every Server,
 * including one at an address that has never answered, wore a green "active"
 * pill on the list, its masthead, Overview, home, the fleet aside and
 * `/monitoring`. An operator reads green as healthy.
 *
 * What the pill says now is the stored outcome of Cloudgate's last attempt to
 * reach the machine: Check now, the readiness read, or a setup run.
 * And the billing flag is drawn only when it says something, which is
 * `inactive` — which only Cloudgate Cloud ever writes, so off cloud the flag
 * never appears. It wins over the reach mark when present, because a Server
 * whose subscription lapsed is the fact an operator needs first.
 *
 * Every mark carries its word, per `status.ts` rule 2.
 */
export const SERVER_REACH = {
  reachable: { glyph: "●", tone: "ok", label: "reachable" },
  unreachable: { glyph: "✕", tone: "bad", label: "not reachable" },
  unchecked: { glyph: "○", tone: "mute", label: "not checked" },
} satisfies Record<string, Mark>;

export type ServerReach = keyof typeof SERVER_REACH;

/**
 * A Server in **Maintenance** (spec #1420). Here beside the reach marks, not
 * in `STATUS`, because it is no enum value: the Server row carries it as
 * `maintenanceSince`. `warn`, since new work on it is refused until someone
 * ends it. The glyph is `⊘`, the vocabulary's mark for a state an operator
 * chose (`stopped`, `cancelled`), rather than `held`'s `◐`, which says a
 * build is half done and waiting; the tone and the word tell it from those.
 */
export const SERVER_MAINTENANCE = {
  glyph: "⊘",
  tone: "warn",
  label: "in maintenance",
} satisfies Mark;

type ReachFields = Pick<Server, "reachCheckedAt" | "reachOk">;

/** Where the last attempt to reach this Server left it. */
export function serverReach(server: ReachFields): ServerReach {
  if (!server.reachCheckedAt) return "unchecked";
  return server.reachOk === true ? "reachable" : "unreachable";
}

/**
 * The mark to draw beside a Server's name. A Server in Maintenance says so
 * over its reach (spec #1420): a deploy to it is refused whatever the reach.
 * `maintenanceSince` is optional because a Service read's nested `server` is
 * a projection that may not carry it.
 */
export function serverMark(
  server: ReachFields &
    Pick<Server, "serverStatus"> &
    Partial<Pick<Server, "maintenanceSince">>,
): Mark {
  if (server.serverStatus === "inactive") return STATUS.inactive;
  if (server.maintenanceSince) return SERVER_MAINTENANCE;
  return SERVER_REACH[serverReach(server)];
}

/** How many of these Servers each reach outcome holds, for a count line. */
export function reachCounts(
  servers: readonly ReachFields[],
): Record<ServerReach, number> {
  const counts: Record<ServerReach, number> = {
    reachable: 0,
    unreachable: 0,
    unchecked: 0,
  };
  for (const server of servers) counts[serverReach(server)] += 1;
  return counts;
}

/**
 * "2 reachable · 1 not reachable", leaving out the outcomes nobody holds. The
 * count of Servers a home tile or the fleet aside puts under its figure.
 */
export function reachSummary(counts: Record<ServerReach, number>): string {
  const parts = (Object.keys(SERVER_REACH) as ServerReach[])
    .filter((reach) => counts[reach] > 0)
    .map((reach) => `${counts[reach]} ${SERVER_REACH[reach].label}`);
  return parts.length === 0 ? "none yet" : parts.join(" · ");
}
