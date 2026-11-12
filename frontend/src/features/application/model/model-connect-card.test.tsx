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
import type {
  AiModel,
  ApplicationDetail,
} from "@/lib/api/endpoints/applications";

/** `usePermission`'s verdict, by statement, as `agents-card.test.tsx` holds it. */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "owner",
  }),
}));

let listed: Agent[];
const create = vi.fn();
vi.mock("@/lib/api/endpoints/agents", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/agents")>()),
  agentsApi: {
    list: () => Promise.resolve(listed),
    create: (...args: unknown[]) => create(...args),
  },
}));

vi.mock("@/lib/api/endpoints/projects", () => ({
  projectsApi: {
    list: () =>
      Promise.resolve([
        { projectId: "p1", name: "Checkout", description: null },
      ]),
  },
}));

vi.mock("@/lib/api/endpoints/environments", () => ({
  environmentsApi: {
    listByProject: () =>
      Promise.resolve([
        {
          environmentId: "e1",
          name: "production",
          projectId: "p1",
          description: null,
        },
      ]),
    findOne: () =>
      Promise.resolve({
        environmentId: "e1",
        name: "production",
        projectId: "p1",
        services: [
          {
            serviceType: "application",
            serviceId: "app-1",
            name: "chat",
            appName: "chat-a1b2c3",
            status: "done",
            serverId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
  },
}));

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1" }),
}));

vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ membership: vi.fn() }),
}));

const { ModelConnectCard } = await import("./model-connect-card");

const ENDPOINT = "https://cloud.example.test/ai/app-1/v1";
const KEY = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl";

const FACET: AiModel = {
  runtime: "ollama",
  model: "smollm2:135m",
  imageTag: "0.12.6",
  pin: "0.12.6",
  offPin: false,
  hasHfToken: false,
  endpoint: ENDPOINT,
};

const APPLICATION = {
  applicationId: "app-1",
  environmentId: "e1",
  environment: { environmentId: "e1", project: { projectId: "p1" } },
} as unknown as ApplicationDetail;

const agent = (overrides: Partial<Agent>): Agent => ({
  id: "u1",
  memberId: "m1",
  name: "chat-bot",
  role: "agentCaller",
  createdAt: "2026-10-01T00:00:00.000Z",
  accessedProjects: ["p1"],
  accessedEnvironments: ["e1"],
  accessedServices: ["app-1"],
  keys: [],
  suspended: false,
  createdBy: null,
  lastConnection: null,
  rateLimitedLastHour: 0,
  ...overrides,
});

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mount(facet: AiModel = FACET) {
  render(<ModelConnectCard application={APPLICATION} facet={facet} />, {
    wrapper: Wrapper,
  });
}

const snippetWell = () => screen.getByLabelText("OpenAI SDK snippet");

beforeEach(() => {
  refused.current = new Set();
  listed = [];
  create
    .mockReset()
    .mockImplementation(
      (input: {
        name: string;
        role: Agent["role"];
        grant: { accessedServices: string[] };
      }) =>
        Promise.resolve({
          agent: agent({
            id: "new",
            name: input.name,
            role: input.role,
            accessedServices: input.grant.accessedServices,
          }),
          key: KEY,
        }),
    );
});

afterEach(cleanup);

/**
 * The Model tab's client wiring: the endpoint and a snippet with a
 * placeholder for the key, "Create a caller Agent" under `member: ['create']`,
 * and the Agents that can call the model under `member: ['read']`.
 */
describe("ModelConnectCard", () => {
  it("shows the endpoint with a copy button, and a snippet holding it and the placeholder", () => {
    mount();

    expect(screen.getByText(ENDPOINT)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Copy the endpoint" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Copy the OpenAI SDK snippet" }),
    ).toBeDefined();
    const text = snippetWell().textContent ?? "";
    expect(text).toContain(`baseURL: "${ENDPOINT}"`);
    expect(text).toContain('apiKey: "<agent key>"');
  });

  it("says there is no endpoint, and offers no snippet, while the platform host URL is unset", () => {
    mount({ ...FACET, endpoint: null });

    expect(screen.getByText(/No endpoint yet/)).toBeDefined();
    expect(screen.queryByLabelText("OpenAI SDK snippet")).toBeNull();
  });

  it("hides Create a caller Agent without member: create", () => {
    refused.current = new Set(["member:create"]);
    mount();
    expect(
      screen.queryByRole("button", { name: "Create a caller Agent" }),
    ).toBeNull();
  });

  it("creates a Caller granted this AI model, and shows its key once with the snippet, never the key in it", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Create a caller Agent" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getByRole("button", { name: /^Caller/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() =>
      expect(
        within(dialog)
          .getByRole("checkbox", { name: "chat chat-a1b2c3" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );

    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
      target: { value: "chat-bot" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create Agent" }),
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      name: "chat-bot",
      role: "agentCaller",
      grant: {
        accessedProjects: ["p1"],
        accessedEnvironments: ["e1"],
        accessedServices: ["app-1"],
      },
    });

    await screen.findByText(/call AI models as/);
    expect(screen.queryByText(/MCP endpoint/)).toBeNull();
    const wells = screen.getAllByLabelText("OpenAI SDK snippet");
    for (const well of wells) expect(well.textContent).not.toContain(KEY);
  });

  it("lists exactly the Agents that can call this AI model", async () => {
    listed = [
      agent({ id: "a", name: "chat-bot" }),
      agent({ id: "b", name: "paused-bot", suspended: true }),
      agent({ id: "c", name: "other-model", accessedServices: ["app-2"] }),
      agent({ id: "d", name: "deploy-bot", role: "agentOperator" }),
    ];
    mount();

    const section = await screen.findByRole("region", {
      name: "Agents that can call this AI model",
    });
    await waitFor(() =>
      expect(within(section).getAllByRole("listitem")).toHaveLength(2),
    );
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["chat-bot", "paused-botSuspended"]);
  });

  it("hides the callers from a Member who cannot read members", () => {
    refused.current = new Set(["member:read"]);
    listed = [agent({})];
    mount();
    expect(
      screen.queryByRole("region", {
        name: "Agents that can call this AI model",
      }),
    ).toBeNull();
  });
});
