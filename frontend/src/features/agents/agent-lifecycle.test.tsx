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

/**
 * An Agent's row after creation: its keys, Add key, Revoke and Remove,
 * Suspend and Resume, Change role, Manage access, and the self-reported last
 * connection — with every write off, and `roleRefusal`'s reason on it, for a
 * role without the statement its route declares.
 */

let listed: Agent[];
const api = {
  suspend: vi.fn(),
  resume: vi.fn(),
  addKey: vi.fn(),
  removeKey: vi.fn(),
};
const updateMemberRole = vi.fn();

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
    create: vi.fn(),
    remove: vi.fn(),
    suspend: (...args: unknown[]) => api.suspend(...args),
    resume: (...args: unknown[]) => api.resume(...args),
    addKey: (...args: unknown[]) => api.addKey(...args),
    removeKey: (...args: unknown[]) => api.removeKey(...args),
  },
}));

vi.mock("@/lib/api/endpoints/organizations", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/organizations")>()),
  organizationsApi: {
    updateMemberRole: (...args: unknown[]) => updateMemberRole(...args),
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
const inDays = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString();

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
  accessedProjects: ["p1"],
  accessedEnvironments: [],
  accessedServices: [],
  keys: [key()],
  suspended: false,
  createdBy: null,
  lastConnection: null,
  rateLimitedLastHour: 0,
  ...overrides,
});

const KEY = "ZyXwVuTsRqPoNmLkJiHgFeDcBaZyXwVuTsRqPoNmLkJiHgFeDcBaZyXwVuTsRqPo";

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

function keyLines(row: HTMLElement) {
  return within(within(row).getByRole("list", { name: /keys$/ })).getAllByRole(
    "listitem",
  );
}

const refusal = (action: string) =>
  `Your role in this Organization cannot ${action}. Ask an owner or an admin to do it, or to change your role.`;

beforeEach(() => {
  listed = [agent()];
  refused.current = new Set();
  for (const fn of Object.values(api)) fn.mockReset();
  updateMemberRole.mockReset().mockResolvedValue({});
});

afterEach(cleanup);

describe("an Agent's keys", () => {
  it("lists each key by prefix, created, last used and expiry, with Revoke", async () => {
    listed = [
      agent({
        keys: [
          key({ id: "k1", start: "AbCdEf", lastUsedAt: inDays(-2) }),
          key({ id: "k2", start: "QwErTy" }),
        ],
      }),
    ];
    show();
    const [first, second] = keyLines(await rowOf("deploy-bot"));

    expect(within(first).getByText("AbCdEf…")).toBeDefined();
    expect(first.textContent).toMatch(/Created .*ago/);
    expect(first.textContent).toMatch(/Last used .*ago/);
    expect(first.textContent).toMatch(/Expires \w/);
    expect(within(first).getByRole("button", { name: "Revoke" })).toBeDefined();
    expect(second.textContent).toContain("Never used");
  });

  it("keeps an expired key listed as Expired, with Remove instead of Revoke", async () => {
    listed = [
      agent({
        keys: [
          key({
            id: "old",
            start: "OlDkEy",
            expired: true,
            expiresAt: inDays(-2),
          }),
          key({ id: "new", start: "NeWkEy" }),
        ],
      }),
    ];
    show();
    const [old, live] = keyLines(await rowOf("deploy-bot"));

    expect(old.textContent).toMatch(/Expired .*ago/);
    expect(within(old).getByRole("button", { name: "Remove" })).toBeDefined();
    expect(within(old).queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(within(live).getByRole("button", { name: "Revoke" })).toBeDefined();
  });

  it("turns a key amber inside 14 days, and the row's next expiry with it", async () => {
    listed = [
      agent({
        keys: [
          key({ id: "soon", start: "SoOnKy", expiresAt: inDays(10) }),
          key({ id: "late", start: "LaTeKy", expiresAt: inDays(60) }),
        ],
      }),
    ];
    show();
    const row = await rowOf("deploy-bot");
    const [soon, late] = keyLines(row);

    const expiryOf = (line: HTMLElement) =>
      line.querySelector("[data-expiry]")!;
    expect(expiryOf(soon).className).toContain("text-warn");
    expect(expiryOf(late).className).not.toContain("text-warn");
    expect(
      within(row)
        .getByText(/^2 keys · next expires/)
        .querySelector("time")!.className,
    ).toContain("text-warn");
  });

  it("reveals an added key once, and Revoke then removes the old one", async () => {
    api.addKey.mockResolvedValue({ agent: agent(), key: KEY });
    api.removeKey.mockResolvedValue(agent());
    show();
    const row = await rowOf("deploy-bot");

    fireEvent.click(within(row).getByRole("button", { name: "Add key" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add key" }));
    await waitFor(() => expect(screen.getByText(KEY)).toBeDefined());
    expect(api.addKey).toHaveBeenCalledWith("k3x9q2", 90);

    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    await waitFor(() => expect(screen.queryByText(KEY)).toBeNull());

    fireEvent.click(within(row).getByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke key" }));
    await waitFor(() =>
      expect(api.removeKey).toHaveBeenCalledWith("k3x9q2", "key1"),
    );
  });
});

describe("Suspend and Resume", () => {
  it("suspends after a confirmation that promises keys, role and access stay", async () => {
    api.suspend.mockResolvedValue(agent({ suspended: true }));
    show();
    const row = await rowOf("deploy-bot");

    fireEvent.click(within(row).getByRole("button", { name: "Suspend" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/keys, role and access stay/);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Suspend Agent" }),
    );
    await waitFor(() => expect(api.suspend).toHaveBeenCalledWith("k3x9q2"));
  });

  it("offers Resume on a suspended Agent, and resumes it without a dialog", async () => {
    api.resume.mockResolvedValue(agent());
    listed = [agent({ suspended: true })];
    show();
    const row = await rowOf("deploy-bot");

    expect(within(row).queryByRole("button", { name: "Suspend" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.resume).toHaveBeenCalledWith("k3x9q2"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Change role", () => {
  it("offers only Reader, Operator and Caller, and writes through the member-role route", async () => {
    show();
    const row = await rowOf("deploy-bot");

    fireEvent.click(within(row).getByRole("button", { name: "Change role" }));
    const dialog = await screen.findByRole("dialog");
    const choices = within(within(dialog).getByRole("group", { name: "Role" }))
      .getAllByRole("button")
      .map((choice) => choice.textContent);
    expect(choices).toHaveLength(3);
    expect(choices[0]).toMatch(/^Reader/);
    expect(choices[1]).toMatch(/^Operator/);
    expect(choices[2]).toMatch(/^Caller/);
    expect(dialog.textContent).not.toMatch(/\b(Admin|Member|Owner)\b/);

    fireEvent.click(within(dialog).getByRole("button", { name: /^Reader/ }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Change role" }),
    );
    await waitFor(() =>
      expect(updateMemberRole).toHaveBeenCalledWith("m_agent", "agentReader"),
    );
  });
});

describe("last connected", () => {
  it("names the client and revision it reported, labelled self-reported", async () => {
    listed = [
      agent({
        lastConnection: {
          at: inDays(-0.1),
          clientName: "claude-code",
          clientVersion: "2.1.0",
          revision: "2025-06-18",
        },
      }),
    ];
    show();
    const row = await rowOf("deploy-bot");

    const line = within(row).getByText(/claude-code 2\.1\.0/);
    expect(line.textContent).toContain("revision 2025-06-18");
    expect(line.textContent).toContain("(self-reported)");
  });

  it("says no client has connected yet before one has", async () => {
    show();
    const row = await rowOf("deploy-bot");
    expect(within(row).getByText("No client has connected yet")).toBeDefined();
  });
});

describe("a role without member: update", () => {
  it("turns every lifecycle write off with roleRefusal's reason, and pressing one opens nothing", async () => {
    refused.current = new Set(["member:update"]);
    listed = [
      agent({
        keys: [
          key({ id: "old", expired: true, expiresAt: inDays(-2) }),
          key({ id: "new" }),
        ],
      }),
    ];
    show();
    const row = await rowOf("deploy-bot");

    const expectations: Array<[string, string]> = [
      ["Suspend", refusal("suspend an Agent")],
      ["Change role", refusal("change an Agent’s role")],
      ["Manage access", refusal("change what an Agent can reach")],
      ["Add key", refusal("add a key to an Agent")],
      ["Revoke", refusal("revoke an Agent’s key")],
      ["Remove", refusal("remove an Agent’s key")],
    ];
    for (const [name, title] of expectations) {
      const button = within(row).getByRole("button", { name });
      expect([name, button.getAttribute("aria-disabled")]).toEqual([
        name,
        "true",
      ]);
      expect([name, button.getAttribute("title")]).toEqual([name, title]);
      fireEvent.click(button);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.suspend).not.toHaveBeenCalled();
    expect(api.removeKey).not.toHaveBeenCalled();
  });

  it("turns Resume off too, on a suspended Agent", async () => {
    refused.current = new Set(["member:update"]);
    listed = [agent({ suspended: true })];
    show();
    const row = await rowOf("deploy-bot");

    const resume = within(row).getByRole("button", { name: "Resume" });
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    expect(resume.getAttribute("title")).toBe(refusal("resume an Agent"));
    fireEvent.click(resume);
    expect(api.resume).not.toHaveBeenCalled();
  });
});
