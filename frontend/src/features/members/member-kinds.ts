import type { Member } from "@/lib/api/endpoints/organizations";
import { isAgentRole } from "@/lib/api/endpoints/roles";

/**
 * People and Agents, out of one member list.
 *
 * `GET /organizations/members` answers every member row, and an Agent is one
 * (ADR-0023) — with its synthetic `<id>@agents.cloudgate.invalid` address on
 * it, which must never render. The role is enough to tell them apart: the two
 * agent roles are held only by Agents and an Agent holds nothing else, which
 * the one writer of `member.role` enforces on the backend. So this needs no
 * field the listing does not already carry.
 *
 * Every person-shaped surface over the member list goes through here — the
 * Members card and a team's add-member picker — so that no action meant for
 * a person is ever offered on an Agent.
 */
export function splitMembers<T extends Pick<Member, "role">>(
  rows: readonly T[],
): { people: T[]; agentCount: number } {
  const people = rows.filter((row) => !isAgentRole(row.role));
  return { people, agentCount: rows.length - people.length };
}
