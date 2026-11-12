import { describe, expect, it } from "vitest";

import type { Agent, AgentKey } from "@/lib/api/endpoints/agents";

import {
  accessSummary,
  agentAuditHref,
  agentStatus,
  connectionLabel,
  keyExpiry,
  keyFacts,
  lastUsed,
} from "./agent-facts";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

const key = (overrides: Partial<AgentKey> = {}): AgentKey => ({
  id: "k1",
  start: "abcdef",
  createdAt: at(-10),
  lastUsedAt: null,
  expiresAt: at(80),
  expired: false,
  ...overrides,
});

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "agt1",
  memberId: "m1",
  name: "deploy-bot",
  role: "agentReader",
  createdAt: at(-10),
  accessedProjects: ["p1"],
  accessedEnvironments: ["e1"],
  accessedServices: ["s1"],
  keys: [key()],
  suspended: false,
  createdBy: null,
  lastConnection: null,
  rateLimitedLastHour: 0,
  ...overrides,
});

const NOTHING = {
  accessedProjects: [],
  accessedEnvironments: [],
  accessedServices: [],
};

describe("agentStatus", () => {
  it("reads active when it holds a live key and a grant and is not suspended", () => {
    expect(agentStatus(agent()).key).toBe("active");
  });

  it("reads reaches nothing yet for an empty grant", () => {
    expect(agentStatus(agent(NOTHING)).key).toBe("reachesNothing");
  });

  it("puts no valid key above an empty grant, and counts no key at all as none valid", () => {
    const expired = [key({ expired: true, expiresAt: at(-1) })];
    expect(agentStatus(agent({ ...NOTHING, keys: expired })).key).toBe(
      "noValidKey",
    );
    expect(agentStatus(agent({ keys: [] })).key).toBe("noValidKey");
  });

  it("puts suspended above every other status", () => {
    const expired = [key({ expired: true, expiresAt: at(-1) })];
    expect(
      agentStatus(agent({ ...NOTHING, keys: expired, suspended: true })).key,
    ).toBe("suspended");
  });

  it("renders every status as a word, never a glyph alone", () => {
    for (const shape of [
      agent(),
      agent(NOTHING),
      agent({ keys: [] }),
      agent({ suspended: true }),
    ]) {
      expect(agentStatus(shape).mark.label).toMatch(/[a-z]{3}/);
    }
  });
});

describe("accessSummary", () => {
  it("counts each column with a noun that agrees", () => {
    expect(
      accessSummary(
        agent({
          accessedProjects: ["p1", "p2"],
          accessedEnvironments: ["e1"],
          accessedServices: ["s1", "s2", "s3", "s4"],
        }),
      ),
    ).toBe("2 Projects · 1 Environment · 4 Services");
  });

  it("reads an empty grant as a deliberate state with its next step", () => {
    expect(accessSummary(agent(NOTHING))).toBe(
      "Reaches nothing yet — grant it a Project",
    );
  });
});

describe("keyFacts", () => {
  it("names the soonest expiry among live keys and ignores expired ones", () => {
    const facts = keyFacts(
      agent({
        keys: [
          key({ id: "a", expiresAt: at(80) }),
          key({ id: "b", expiresAt: at(20) }),
          key({ id: "c", expiresAt: at(-3), expired: true }),
        ],
      }),
      NOW,
    );
    expect(facts.count).toBe(3);
    expect(facts.nextExpiry).toBe(at(20));
    expect(facts.soon).toBe(false);
  });

  it("turns amber inside 14 days and not a day before", () => {
    expect(keyFacts(agent({ keys: [key({ expiresAt: at(13.9) })] }), NOW).soon).toBe(true);
    expect(keyFacts(agent({ keys: [key({ expiresAt: at(14.1) })] }), NOW).soon).toBe(false);
  });

  it("has no next expiry when no key is live", () => {
    const facts = keyFacts(
      agent({ keys: [key({ expired: true, expiresAt: at(-1) })] }),
      NOW,
    );
    expect(facts.nextExpiry).toBeNull();
    expect(facts.soon).toBe(false);
  });
});

describe("lastUsed", () => {
  it("is the latest use across every key", () => {
    expect(
      lastUsed(
        agent({
          keys: [
            key({ id: "a", lastUsedAt: at(-5) }),
            key({ id: "b", lastUsedAt: at(-1) }),
            key({ id: "c", lastUsedAt: null }),
          ],
        }),
      ),
    ).toBe(at(-1));
  });

  it("is null for an Agent whose keys were never used", () => {
    expect(lastUsed(agent())).toBeNull();
  });
});

describe("agentAuditHref", () => {
  it("opens the audit log filtered to the Agent's user id", () => {
    expect(agentAuditHref("k3x9q2")).toBe("/settings/audit-log?userId=k3x9q2");
  });

  it("narrows to one outcome when asked", () => {
    expect(agentAuditHref("k3x9q2", "refused")).toBe(
      "/settings/audit-log?userId=k3x9q2&outcome=refused",
    );
  });
});

describe("keyExpiry", () => {
  it("reads an expired key as expired, whatever its date says", () => {
    expect(keyExpiry(key({ expired: true, expiresAt: at(-1) }), NOW)).toBe(
      "expired",
    );
  });

  it("turns a live key amber inside 14 days and not a day before", () => {
    expect(keyExpiry(key({ expiresAt: at(13.9) }), NOW)).toBe("soon");
    expect(keyExpiry(key({ expiresAt: at(14.1) }), NOW)).toBe("ok");
  });
});

describe("connectionLabel", () => {
  it("names the client, its version and the revision it was served at", () => {
    expect(
      connectionLabel({
        at: at(0),
        clientName: "claude-code",
        clientVersion: "2.1.0",
        revision: "2025-06-18",
      }),
    ).toBe("claude-code 2.1.0 · revision 2025-06-18");
  });

  it("leaves out what the client did not say, and is null when it said nothing", () => {
    expect(
      connectionLabel({
        at: at(0),
        clientName: "codex",
        clientVersion: null,
        revision: null,
      }),
    ).toBe("codex");
    expect(
      connectionLabel({
        at: at(0),
        clientName: null,
        clientVersion: null,
        revision: null,
      }),
    ).toBeNull();
  });
});
