import type {
  Agent,
  AgentConnection,
  AgentKey,
} from "@/lib/api/endpoints/agents";
import type { Mark } from "@/lib/design/status";
import { counted } from "@/lib/format/plural";
import { settingsHref } from "@/lib/settings/sections";

/**
 * What an Agent's row says about it at rest, derived from the listing alone.
 * Pure, so the rules the spec fixes — the status precedence, the 14-day amber —
 * are tested apart from the row that draws them.
 */

export type AgentStatusKey =
  | "suspended"
  | "noValidKey"
  | "reachesNothing"
  | "active";

/**
 * Exactly one status, highest first: Suspended, then No valid key, then
 * Reaches nothing yet, then Active.
 *
 * The order is "what stops it soonest". A suspended Agent is refused before
 * its key is even looked at; an Agent with no live key cannot authenticate, so
 * what it is granted does not matter yet; and an Agent that authenticates but
 * is granted nothing can call only the listing tools and gets empty answers.
 * Showing two of these at once would make an operator work out which one wins,
 * which is the question the status is there to answer.
 */
export const AGENT_STATUS: Record<AgentStatusKey, Mark> = {
  suspended: { glyph: "⊘", tone: "bad", label: "suspended" },
  noValidKey: { glyph: "✕", tone: "bad", label: "no valid key" },
  reachesNothing: { glyph: "○", tone: "warn", label: "reaches nothing yet" },
  active: { glyph: "●", tone: "ok", label: "active" },
};

export function agentStatus(agent: Agent): {
  key: AgentStatusKey;
  mark: Mark;
} {
  const key: AgentStatusKey = agent.suspended
    ? "suspended"
    : !agent.keys.some((each) => !each.expired)
      ? "noValidKey"
      : grantIsEmpty(agent)
        ? "reachesNothing"
        : "active";
  return { key, mark: AGENT_STATUS[key] };
}

export function grantIsEmpty(agent: Agent): boolean {
  return (
    agent.accessedProjects.length === 0 &&
    agent.accessedEnvironments.length === 0 &&
    agent.accessedServices.length === 0
  );
}

/**
 * "2 Projects · 1 Environment · 4 Services", or the empty grant's own sentence:
 * an Agent saved with nothing granted is a state somebody chose, so it reads as
 * one, with the next step in it.
 */
export function accessSummary(agent: Agent): string {
  if (grantIsEmpty(agent)) return REACHES_NOTHING;
  return [
    counted(agent.accessedProjects.length, "Project", "Projects"),
    counted(agent.accessedEnvironments.length, "Environment", "Environments"),
    counted(agent.accessedServices.length, "Service", "Services"),
  ].join(" · ");
}

export const REACHES_NOTHING = "Reaches nothing yet — grant it a Project";

/** Inside this, the next expiry turns amber. */
export const EXPIRY_WARNING_DAYS = 14;
const DAY = 86_400_000;

/**
 * How many keys, and when the next live one lapses.
 *
 * Expired keys count towards `count` — they stay listed until someone removes
 * them — but never towards `nextExpiry`, which is about the key the Agent will
 * lose next, not one it already has.
 */
export function keyFacts(
  agent: Agent,
  now: number = Date.now(),
): { count: number; nextExpiry: string | null; soon: boolean } {
  let next: string | null = null;
  for (const each of agent.keys) {
    if (each.expired || each.expiresAt === null) continue;
    if (next === null || Date.parse(each.expiresAt) < Date.parse(next)) {
      next = each.expiresAt;
    }
  }
  return {
    count: agent.keys.length,
    nextExpiry: next,
    soon: next !== null && Date.parse(next) - now < EXPIRY_WARNING_DAYS * DAY,
  };
}

/**
 * One key's expiry, as its row in the keys list reads it: `expired` (listed
 * as Expired, with Remove), `soon` (inside {@link EXPIRY_WARNING_DAYS}, amber),
 * or `ok`. The same 14 days as the row's next-expiry line, so the key that
 * turns that line amber is amber in the list too.
 */
export function keyExpiry(
  key: AgentKey,
  now: number = Date.now(),
): "expired" | "soon" | "ok" {
  if (key.expired) return "expired";
  if (key.expiresAt === null) return "ok";
  return Date.parse(key.expiresAt) - now < EXPIRY_WARNING_DAYS * DAY
    ? "soon"
    : "ok";
}

/**
 * "claude-code 2.1.0 · revision 2025-06-18" — the client and revision of the
 * last connection, or `null` when it carried neither. The row draws the time
 * beside it, and the *self-reported* label.
 */
export function connectionLabel(connection: AgentConnection): string | null {
  const client = [connection.clientName, connection.clientVersion]
    .filter((part): part is string => part !== null && part !== "")
    .join(" ");
  const revision = connection.revision ? `revision ${connection.revision}` : "";
  const parts = [client, revision].filter((part) => part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The latest use across every key, or `null` if none was ever used. */
export function lastUsed(agent: Agent): string | null {
  let latest: string | null = null;
  for (const each of agent.keys) {
    if (each.lastUsedAt === null) continue;
    if (latest === null || Date.parse(each.lastUsedAt) > Date.parse(latest)) {
      latest = each.lastUsedAt;
    }
  }
  return latest;
}

/**
 * The audit log, filtered to this Agent (`?userId=`). By user id and
 * never by email — the email filter would put the Agent's synthetic address in
 * the URL. `outcome` narrows it further, as the rate-limit line will.
 */
export function agentAuditHref(
  agentId: string,
  outcome?: "succeeded" | "refused" | "failed",
): string {
  const query = new URLSearchParams({ userId: agentId });
  if (outcome) query.set("outcome", outcome);
  return `${settingsHref("audit-log")}?${query.toString()}`;
}
