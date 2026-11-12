import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent, AgentKey } from "@/lib/api/endpoints/agents";

let listed: Agent[];
const create = vi.fn();

/** `usePermission`'s verdict, by statement, as `members-card.test.tsx` holds it. */
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

vi.mock("@/lib/api/endpoints/agents", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/agents")>()),
  agentsApi: {
    list: () => Promise.resolve(listed),
    create: (...args: unknown[]) => create(...args),
    remove: vi.fn(),
  },
}));

vi.mock("@/lib/api/endpoints/projects", () => ({
  projectsApi: { list: () => Promise.resolve([]) },
}));

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1" }),
}));

vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ membership: vi.fn() }),
}));

const { AgentsCard } = await import("./agents-card");

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const key = (overrides: Partial<AgentKey> = {}): AgentKey => ({
  id: "key1",
  start: "AbCdEf",
  createdAt: inDays(-3),
  lastUsedAt: null,
  expiresAt: inDays(87),
  expired: false,
  ...overrides,
});

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "k3x9q2",
  memberId: "m_agent",
  name: "deploy-bot",
  role: "agentOperator",
  createdAt: inDays(-3),
  accessedProjects: ["p1", "p2"],
  accessedEnvironments: ["e1"],
  accessedServices: ["s1", "s2", "s3", "s4"],
  keys: [key()],
  suspended: false,
  createdBy: { name: "Katherine Johnson", email: "katherine@example.test" },
  lastConnection: null,
  rateLimitedLastHour: 0,
  ...overrides,
});

const KEY = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl";

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<AgentsCard />, { wrapper });
}

async function rowOf(name: string) {
  const title = await screen.findByText(name);
  return title.closest("li")!;
}

beforeEach(() => {
  listed = [agent()];
  refused.current = new Set();
  create.mockReset().mockResolvedValue({ agent: agent(), key: KEY });
});

afterEach(cleanup);

/**
 * The Agents section at rest.
 */
describe("AgentsCard", () => {
  it("reads an empty grant as Reaches nothing yet, with its next step", async () => {
    listed = [
      agent({ accessedProjects: [], accessedEnvironments: [], accessedServices: [] }),
    ];
    show();

    const row = await rowOf("deploy-bot");
    expect(
      within(row).getByText("Reaches nothing yet — grant it a Project"),
    ).toBeDefined();
    expect(within(row).getByText("reaches nothing yet")).toBeDefined();
  });

  it("shows one status, the highest one that applies", async () => {
    listed = [
      agent({
        id: "a1",
        name: "suspended-bot",
        suspended: true,
        accessedProjects: [],
        accessedEnvironments: [],
        accessedServices: [],
        keys: [key({ expired: true, expiresAt: inDays(-1) })],
      }),
      agent({
        id: "a2",
        name: "keyless-bot",
        accessedProjects: [],
        accessedEnvironments: [],
        accessedServices: [],
        keys: [key({ expired: true, expiresAt: inDays(-1) })],
      }),
      agent({ id: "a3", name: "live-bot" }),
    ];
    show();

    const pills = async (name: string) =>
      [
        ...(await rowOf(name)).querySelectorAll("[data-slot=status-pill]"),
      ].map((pill) => pill.textContent?.replace(/^\W+/u, ""));

    expect(await pills("suspended-bot")).toEqual(["suspended"]);
    expect(await pills("keyless-bot")).toEqual(["no valid key"]);
    expect(await pills("live-bot")).toEqual(["active"]);
  });

  it("names the role, what it allows, the access summary, the keys, the creator and the trail", async () => {
    show();
    const row = await rowOf("deploy-bot");

    expect(within(row).getByText("Operator")).toBeDefined();
    expect(within(row).getByText(/deploy, start, stop and cancel/)).toBeDefined();
    expect(
      within(row).getByText("2 Projects · 1 Environment · 4 Services"),
    ).toBeDefined();
    expect(within(row).getByText(/^1 key · next expires/)).toBeDefined();
    expect(within(row).getByText(/by Katherine Johnson/)).toBeDefined();
    expect(within(row).getAllByText("Never used").length).toBeGreaterThan(0);
    expect(
      within(row)
        .getByRole("link", { name: /audit log/ })
        .getAttribute("href"),
    ).toBe("/settings/audit-log?userId=k3x9q2");
  });

  it("turns the next expiry amber inside 14 days", async () => {
    listed = [agent({ keys: [key({ expiresAt: inDays(10) })] })];
    show();
    const row = await rowOf("deploy-bot");

    const when = within(row)
      .getByText(/^1 key · next expires/)
      .querySelector("time")!;
    expect(when.className).toContain("text-warn");
  });

  it("leaves an expiry more than 14 days out in the ordinary color", async () => {
    listed = [agent({ keys: [key({ expiresAt: inDays(20) })] })];
    show();
    const row = await rowOf("deploy-bot");

    const when = within(row)
      .getByText(/^1 key · next expires/)
      .querySelector("time")!;
    expect(when.className).not.toContain("text-warn");
  });

  it("never renders an Agent's address, even when a response carries one", async () => {
    listed = [
      {
        ...agent(),
        email: "k3x9q2@agents.cloudgate.invalid",
      } as Agent,
    ];
    show();
    await rowOf("deploy-bot");

    expect(document.body.textContent).not.toContain("agents.cloudgate.invalid");
  });

  it("turns Create an Agent and Delete off for a role without the statements, with roleRefusal's reason", async () => {
    refused.current = new Set(["member:create", "member:delete"]);
    show();
    const row = await rowOf("deploy-bot");

    const createButton = screen.getAllByRole("button", {
      name: "Create an Agent",
    })[0];
    expect(createButton.getAttribute("aria-disabled")).toBe("true");
    expect(createButton.getAttribute("title")).toBe(
      "Your role in this Organization cannot create an Agent. Ask an owner or an admin to do it, or to change your role.",
    );
    const del = within(row).getByRole("button", { name: "Delete" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.getAttribute("title")).toBe(
      "Your role in this Organization cannot delete an Agent. Ask an owner or an admin to do it, or to change your role.",
    );

    fireEvent.click(createButton);
    expect(screen.queryByText("Create an Agent", { selector: "h2" })).toBeNull();
  });

  it("tells a role that cannot read the audit log so, instead of linking to a refusal", async () => {
    refused.current = new Set(["auditLog:read"]);
    show();
    const row = await rowOf("deploy-bot");

    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).getByText(/your role cannot read/)).toBeDefined();
  });

  it("shows a new Agent's key once, and not again after the dialog closes", async () => {
    show();
    await rowOf("deploy-bot");

    fireEvent.click(
      screen.getAllByRole("button", { name: "Create an Agent" })[0],
    );
    fireEvent.change(await screen.findByRole("textbox", { name: /^Name/ }), {
      target: { value: "deploy-bot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(screen.getByText(KEY)).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    await waitFor(() => expect(screen.queryByText(KEY)).toBeNull());

    // Opening the dialog again is a new form, not the old answer.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Create an Agent" })[0],
    );
    expect(await screen.findByRole("textbox", { name: /^Name/ })).toBeDefined();
    expect(screen.queryByText(KEY)).toBeNull();
  });
});
