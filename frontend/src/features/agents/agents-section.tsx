"use client";

import { AgentsCard } from "./agents-card";

/**
 * The Agents settings section. One card today; it is a section of its
 * own rather than a card on Members because an Agent is not a person, and the
 * Members card leaves Agents out and points here.
 */
export function AgentsSection() {
  return <AgentsCard />;
}
