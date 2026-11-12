import { api } from "../client";
import type { MemberEntitlements } from "./organizations";
import type { AgentRole } from "./roles";

/**
 * `agents/agents.controller.ts` — the Agents of the active Organization
 * (ADR-0023).
 *
 * An Agent is a Member that is not a person, so changing its role or its grant
 * is not here: the member routes on `organizationsApi` do that, against the
 * Agent's `memberId`.
 *
 * **What the listing leaves out is part of its contract.** No address — an
 * Agent's `<id>@agents.cloudgate.invalid` exists only because `user.email` is
 * `NOT NULL`, and showing it would make an Agent look like a person. No key
 * `permissions` or `metadata` — whoever holds a key can write its `metadata`.
 * Neither is typed here, so no screen can reach for them.
 */

/** One of an Agent's keys. Never the key itself. */
export interface AgentKey {
  id: string;
  /** The key's first characters, to tell keys apart. */
  start: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** Cloudgate's expiry. Every Agent key has one (30, 90 or 365 days). */
  expiresAt: string | null;
  /** Past `expiresAt`. An expired key stays listed until it is removed. */
  expired: boolean;
}

/**
 * Who created an Agent, as its `create` audit row recorded them — so still
 * right after they leave. Only a person creates an Agent, so `email` is a
 * person's. `name` is null only on a row older than the column.
 */
export interface AgentCreator {
  name: string | null;
  email: string;
}

/**
 * What an Agent's MCP client last said about itself on `initialize`, off
 * whichever of its keys connected last. **Self-reported** — the
 * endpoint records the client's claim and nothing decides on it — so every
 * screen that shows it says so.
 */
export interface AgentConnection {
  at: string;
  clientName: string | null;
  clientVersion: string | null;
  /** The MCP protocol revision the endpoint served it at. */
  revision: string | null;
}

export interface Agent {
  /** The Agent's user id — what `DELETE /agents/:id` and the audit filter take. */
  id: string;
  /** Its member row — what the role and entitlement routes take. */
  memberId: string;
  name: string;
  role: AgentRole;
  createdAt: string;
  accessedProjects: string[];
  accessedEnvironments: string[];
  accessedServices: string[];
  keys: AgentKey[];
  /** A ban on its user is in force — Suspend. */
  suspended: boolean;
  createdBy: AgentCreator | null;
  /** `null` until a client has connected with one of its keys. */
  lastConnection: AgentConnection | null;
  /** Its 429s in the last hour, from its rate-limit audit rows. */
  rateLimitedLastHour: number;
}

/** A key's lifetimes, first or added. There is no "never". */
export const AGENT_KEY_EXPIRY_DAYS = [30, 90, 365] as const;

export type AgentKeyExpiryDays = (typeof AGENT_KEY_EXPIRY_DAYS)[number];

export const DEFAULT_AGENT_KEY_EXPIRY_DAYS: AgentKeyExpiryDays = 90;

export interface CreateAgentInput {
  name: string;
  role: AgentRole;
  grant: MemberEntitlements;
  keyExpiresInDays: AgentKeyExpiryDays;
}

/** The Agent, and its first key — the only time the key is ever answered. */
export interface CreatedAgent {
  agent: Agent;
  key: string;
}

export const agentsApi = {
  /** Readable by any member of the Organization, as the Members list is. */
  list: () => api.get<Agent[]>("/agents"),

  /** Owner or admin. Always mints the first key. */
  create: (input: CreateAgentInput) => api.post<CreatedAgent>("/agents", input),

  /**
   * Owner or admin. Removes the Agent's user, member row and every key; its
   * audit rows stay. A person's id, or another Organization's Agent, is 404.
   */
  remove: (agentId: string) => api.delete<unknown>(`/agents/${agentId}`),

  /**
   * Owner or admin. Its next `/mcp` call is refused; keys, role and grant
   * stay, so Resume puts it back as it was.
   */
  suspend: (agentId: string) =>
    api.post<Agent>(`/agents/${agentId}/suspend`, {}),

  resume: (agentId: string) => api.post<Agent>(`/agents/${agentId}/resume`, {}),

  /** Owner or admin. Answers the new key — the only time it is ever shown. */
  addKey: (agentId: string, expiresInDays: AgentKeyExpiryDays) =>
    api.post<CreatedAgent>(`/agents/${agentId}/keys`, { expiresInDays }),

  /**
   * Owner or admin. Revoke on a live key — its next call is refused — and
   * Remove on an expired one; the row goes either way.
   */
  removeKey: (agentId: string, keyId: string) =>
    api.delete<Agent>(`/agents/${agentId}/keys/${keyId}`),
};
