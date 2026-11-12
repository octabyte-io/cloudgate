// No `"use client"`: a leaf, rendered only by the audit section and its
// detail dialog, which are already inside the boundary.

import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import {
  PLATFORM_ACTOR_ROLE,
  type AuditLogEntry,
} from "@/lib/api/endpoints/audit-logs";
import { AGENT_ROLE_LABELS, isAgentRole } from "@/lib/api/endpoints/roles";

/** Who acted on one row, as the console may show it. */
export type AuditActor =
  | { kind: "agent"; name: string | null; role: string }
  | { kind: "person"; email: string; role: string }
  | { kind: "platform"; name: string; role: string };

/** What the platform goes by when its row carries no name. */
const PLATFORM_NAME = "Cloudgate";

/**
 * A row's actor, read from the row alone.
 *
 * **An Agent is told apart by its role**, because the agent roles are
 * Agent-only — and the role is on the row, so this still works after the
 * Agent is deleted and `userId` has gone null. An Agent's `userEmail` is the
 * synthetic `<id>@agents.cloudgate.invalid` address, which must never render,
 * so it is not even carried out of here: the name written with
 * the row stands in for it, and a row with no name says so rather than
 * falling back to the address.
 *
 * A person's row keeps what the trail has always shown — their address and
 * their role at the time.
 */
export function auditActor(entry: AuditLogEntry): AuditActor {
  // **The platform, when no caller acted**: an expired Requested
  // preview's teardown, for one. Its whole shape says so, as the backend's
  // `actor=platform` filter reads it: no user, no address and its role. The
  // role alone is not enough, because a person on a custom role named
  // `system` before migration 0080 renamed it wrote rows carrying it
  // (`platform-actor.ts`).
  if (
    entry.userRole === PLATFORM_ACTOR_ROLE &&
    entry.userId === null &&
    entry.userEmail === null
  ) {
    return {
      kind: "platform",
      name: entry.userName ?? PLATFORM_NAME,
      role: entry.userRole,
    };
  }
  if (isAgentRole(entry.userRole)) {
    return {
      kind: "agent",
      name: entry.userName,
      role: AGENT_ROLE_LABELS[entry.userRole],
    };
  }
  return {
    kind: "person",
    // Only the platform's rows have no address, and they returned above.
    email: entry.userEmail ?? "",
    role: entry.userRole,
  };
}

/** The words an Agent with no recorded name goes by. */
export const UNNAMED_AGENT = "Unnamed Agent";

/**
 * The words an actor goes by: an Agent's recorded name, a person's address —
 * and `null` for an Agent written with no name, which each caller then says
 * in its own way rather than falling back to the synthetic address.
 */
export function actorName(actor: AuditActor): string | null {
  if (actor.kind === "person") return actor.email;
  return actor.name;
}

/** {@link actorName} as plain text, for a sentence that names the actor. */
export function actorLabel(actor: AuditActor): string {
  return actorName(actor) ?? UNNAMED_AGENT;
}

/**
 * The actor as the trail draws it — one component, because the table's Who
 * cell and the detail dialog's Who row must never disagree about it: a person
 * by address, an Agent by name with its "Agent" marker, and an unnamed Agent
 * as a dash that says so.
 */
export function ActorName({ actor }: { actor: AuditActor }) {
  if (actor.kind === "person") return <>{actor.email}</>;
  if (actor.kind === "platform") {
    return (
      <span className="inline-flex items-center gap-1.5">
        {actor.name}
        <Chip>Platform</Chip>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {actor.name ?? <Dash word={UNNAMED_AGENT} />}
      <Chip variant="brand">Agent</Chip>
    </span>
  );
}
