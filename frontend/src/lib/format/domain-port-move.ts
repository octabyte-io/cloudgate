import type { DomainPortMove } from "@/lib/api/endpoints/applications";

import { counted } from "./plural";

/**
 * What an Application's port change did to its Domains, in one sentence:
 * "2 Domains moved to port 3900; api.example.com stays on 8080."
 *
 * Shared by the port setting's save and an Apply's change line, which
 * report the same move (ADR-0068, #1339), so the two cannot word it apart.
 * A Domain left on another port is named, never only counted: it is the one
 * a person may still have to look at.
 */
export function domainPortMoveSentence(move: DomainPortMove): string {
  const moved =
    move.moved.length === 0
      ? `No Domain was on port ${move.from}`
      : `${counted(move.moved.length, "Domain", "Domains")} moved to port ${move.to}`;
  if (move.left.length === 0) return `${moved}.`;
  const left = move.left
    .map(
      (one, index) =>
        `${one.host}${index === 0 ? " stays" : ""} on ${one.port === null ? "no port" : one.port}`,
    )
    .join(", ");
  return `${moved}; ${left}.`;
}
