import Link from "next/link";
import { useEffect, useRef } from "react";

import type { Agent } from "@/lib/api/endpoints/agents";
import { TONE_TEXT } from "@/lib/design/status";
import { counted } from "@/lib/format/plural";

import { agentAuditHref } from "./agent-facts";

/**
 * The loop signal on an Agent's row.
 *
 * The line counts the Agent's 429s in the last hour — its `refused` /
 * `rate-limit` audit rows, counted by `GET /agents` — and links to its refused
 * rows in the audit log, where each one names the tool it was calling. Absent
 * at zero: a quiet Agent has nothing to say here.
 */
export function RateLimitedLine({
  agent,
  canReadTrail,
}: {
  agent: Agent;
  canReadTrail: boolean;
}) {
  const times = agent.rateLimitedLastHour;
  if (times === 0) return null;
  const text = `Rate-limited ${counted(times, "time", "times")} in the last hour`;

  return (
    <p className={`text-meta ${TONE_TEXT.warn}`}>
      {canReadTrail ? (
        <Link
          href={agentAuditHref(agent.id, "refused")}
          className="underline-offset-2 hover:underline"
        >
          {text}
        </Link>
      ) : (
        text
      )}
    </p>
  );
}

/**
 * The id of an Agent's row, which the "Agent rate limited" Notification links
 * to as `/settings/agents#agent-<id>` (the backend's `agentRowAnchor`, which
 * `backend/test/notifications/agent-row-link.spec.ts` holds to this one).
 */
export function agentRowAnchor(agentId: string): string {
  return `agent-${agentId}`;
}

/**
 * Brings the row into view when the page was opened on its anchor. The list
 * arrives after the page does, so the browser's own jump to the fragment has
 * already found nothing by the time the row exists.
 */
export function useScrollToAnchor<T extends HTMLElement>(anchor: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (window.location.hash === `#${anchor}`) {
      ref.current?.scrollIntoView({ block: "center" });
    }
  }, [anchor]);
  return ref;
}
