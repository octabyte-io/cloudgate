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

import type { Agent } from "@/lib/api/endpoints/agents";

const create = vi.fn();

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "owner" }),
}));

vi.mock("@/lib/api/endpoints/agents", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/agents")>()),
  agentsApi: {
    list: () => Promise.resolve([AGENT]),
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

const AGENT: Agent = {
  id: "k3x9q2",
  memberId: "m_agent",
  name: "deploy-bot",
  role: "agentReader",
  createdAt: "2026-09-18T12:00:00.000Z",
  accessedProjects: [],
  accessedEnvironments: [],
  accessedServices: [],
  keys: [
    {
      id: "key1",
      start: "AbCdEf",
      createdAt: "2026-09-18T12:00:00.000Z",
      lastUsedAt: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
      expired: false,
    },
  ],
  suspended: false,
  createdBy: null,
  lastConnection: null,
  rateLimitedLastHour: 0,
};

const KEY = "QzWxEcRvTbYnUmIkOlPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFgHjKlZxCvBnMqWe";

/** jsdom's origin, which is what the console reads the endpoint off. */
const ENDPOINT = `${window.location.origin}/mcp`;

const CLIENTS = [
  "Claude Code",
  "VS Code",
  "Cursor",
  "Codex CLI",
  "Any other client",
];

const writeText = vi.fn();

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<AgentsCard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/**
 * Every client's tab, opened in turn: the config text it renders, and what its
 * copy button puts on the clipboard.
 */
async function everySnippet(scope: HTMLElement) {
  const seen: { client: string; text: string; copied: string }[] = [];
  for (const client of CLIENTS) {
    fireEvent.click(within(scope).getByRole("tab", { name: client }));
    const well = within(scope).getByLabelText(`${client} config`, {
      selector: "pre",
    });
    writeText.mockClear();
    fireEvent.click(
      within(scope).getByRole("button", { name: `Copy the ${client} config` }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    seen.push({
      client,
      text: well.textContent ?? "",
      copied: writeText.mock.calls[0][0] as string,
    });
  }
  return seen;
}

beforeEach(() => {
  create.mockReset().mockResolvedValue({ agent: AGENT, key: KEY });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

/**
 * Connecting an Agent: the
 * same snippets at the reveal and behind the row's Connect action, and the
 * key in neither.
 */
describe("Connect an Agent", () => {
  it("shows every client's config under the revealed key, none of it holding the key", async () => {
    show();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Create an Agent" }))[0],
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
      target: { value: "deploy-bot" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    // The key is shown, once, where the reveal shows it.
    await waitFor(() => expect(within(dialog).getByText(KEY)).toBeDefined());

    const seen = await everySnippet(dialog);
    expect(seen.map((s) => s.client)).toEqual(CLIENTS);
    for (const { client, text, copied } of seen) {
      expect(text, client).toContain(ENDPOINT);
      expect(text, client).toMatch(
        /CLOUDGATE_AGENT_KEY|<agent key>|\$\{input:cloudgate-agent-key\}/,
      );
      expect(text, client).not.toContain(KEY);
      // The well drops a file's final newline; the clipboard keeps it.
      expect(copied.trimEnd(), client).toBe(text);
    }
  });

  it("says at the reveal that a deploy to a queued Service returns the queued Deployment", async () => {
    show();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Create an Agent" }))[0],
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
      target: { value: "deploy-bot" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    expect(
      await within(dialog).findByText(
        "Deploys to a Service already queued return the queued Deployment.",
      ),
    ).toBeDefined();
  });

  it("opens the same snippets from the row's Connect action, with no key anywhere in them", async () => {
    show();
    const row = (await screen.findByText("deploy-bot")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Connect" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Connect deploy-bot")).toBeDefined();
    const seen = await everySnippet(dialog);
    expect(seen.map((s) => s.client)).toEqual(CLIENTS);
    for (const { client, text } of seen) {
      expect(text, client).toContain(ENDPOINT);
      expect(text, client).not.toMatch(/[A-Za-z]{64}/);
    }
  });

  it("says a lost key cannot be recovered and points at Add key", async () => {
    show();
    const row = (await screen.findByText("deploy-bot")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Connect" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/can’t be recovered/);
    expect(dialog.textContent).toMatch(/Add key/);
  });
});
