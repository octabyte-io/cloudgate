import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/lib/api/endpoints/agents";

import type { AgentLifecycle } from "./agent-lifecycle";

/** `usePermission`'s verdict, by statement, as `agents-card.test.tsx` holds it. */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }),
}));

vi.mock("@/lib/api/endpoints/projects", () => ({
  projectsApi: { list: () => Promise.resolve([]) },
}));

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1" }),
}));

const { AgentRow } = await import("./agent-row");

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "k3x9q2",
  memberId: "m_agent",
  name: "loop-bot",
  role: "agentReader",
  createdAt: "2026-09-18T12:00:00.000Z",
  accessedProjects: ["p1"],
  accessedEnvironments: [],
  accessedServices: [],
  keys: [],
  suspended: false,
  createdBy: null,
  lastConnection: null,
  rateLimitedLastHour: 0,
  ...overrides,
});

function show(row: Agent) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ul>{children}</ul>
    </QueryClientProvider>
  );
  const lifecycle: AgentLifecycle = {
    suspend: () => undefined,
    resume: () => undefined,
    changeRole: () => undefined,
    manageAccess: () => undefined,
    addKey: () => undefined,
    removeKey: () => undefined,
    resuming: false,
  };
  return render(
    <AgentRow
      agent={row}
      onConnect={() => undefined}
      onDelete={() => undefined}
      lifecycle={lifecycle}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  refused.current = new Set();
});

afterEach(cleanup);

/**
 * The loop signal on the Agent's row: how often it ran
 * out of budget in the last hour, linked to exactly those refusals.
 */
describe("AgentRow", () => {
  it("says nothing about rate limits before a 429", () => {
    show(agent());

    expect(screen.queryByText(/Rate-limited/)).toBeNull();
  });

  it("counts the last hour's 429s and links to the Agent's refused rows", () => {
    show(agent({ rateLimitedLastHour: 3 }));

    const link = screen.getByRole("link", {
      name: "Rate-limited 3 times in the last hour",
    });
    expect(link.getAttribute("href")).toBe(
      "/settings/audit-log?userId=k3x9q2&outcome=refused",
    );
  });

  it("agrees with a single 429", () => {
    show(agent({ rateLimitedLastHour: 1 }));

    expect(
      screen.getByRole("link", { name: "Rate-limited 1 time in the last hour" }),
    ).toBeDefined();
  });

  it("still says it, unlinked, to a role that cannot read the audit log", () => {
    refused.current = new Set(["auditLog:read"]);
    show(agent({ rateLimitedLastHour: 2 }));

    const line = screen.getByText("Rate-limited 2 times in the last hour");
    expect(line.closest("a")).toBeNull();
  });

  it("is the row a rate-limited Notification links to", () => {
    const { container } = show(agent());

    const row = container.querySelector("li#agent-k3x9q2");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("loop-bot")).toBeDefined();
  });
});
