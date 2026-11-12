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

import { ApiError } from "@/lib/api/api-error";

const create = vi.fn();
const listByProject = vi.fn();
const findOne = vi.fn();

vi.mock("@/lib/api/endpoints/agents", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/agents")>()),
  agentsApi: { create: (...args: unknown[]) => create(...args) },
}));

vi.mock("@/lib/api/endpoints/environments", () => ({
  environmentsApi: {
    listByProject: (...args: unknown[]) => listByProject(...args),
    findOne: (...args: unknown[]) => findOne(...args),
  },
}));

vi.mock("@/lib/api/endpoints/projects", () => ({
  projectsApi: { list: () => Promise.resolve(PROJECTS) },
}));

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1" }),
}));

vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ membership: vi.fn() }),
}));

const { CreateAgentModal } = await import("./create-agent-modal");
const { LOG_MASK_NOTICE } = await import("./log-mask-notice");

/** What the signed-in person's own `GET /projects` answers. */
const PROJECTS = [
  { projectId: "p1", name: "Checkout", description: null },
  { projectId: "p2", name: "Billing", description: null },
];

const KEY = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function open(onOpenChange = vi.fn(), connect?: () => ReactNode) {
  render(
    <CreateAgentModal open onOpenChange={onOpenChange} connect={connect} />,
    { wrapper: Wrapper },
  );
  return onOpenChange;
}

const box = (name: string) => screen.getByRole("checkbox", { name });
const ticked = (name: string) =>
  box(name).getAttribute("aria-checked") === "true";

function named(name: string) {
  fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), {
    target: { value: name },
  });
}

beforeEach(() => {
  create.mockReset().mockImplementation((input: { name: string }) =>
    Promise.resolve({
      agent: { id: "k3x9q2", name: input.name, keys: [] },
      key: KEY,
    }),
  );
  listByProject.mockReset().mockImplementation((projectId: string) =>
    Promise.resolve(
      projectId === "p1"
        ? [
            {
              environmentId: "e1",
              name: "production",
              projectId: "p1",
              description: null,
            },
          ]
        : [],
    ),
  );
  // The caller's own `GET /environments/:id`, which `PermissionService` has
  // already narrowed to what they may see: one Service of the Environment's
  // two. The other exists, and is not in any answer the dialog reads.
  findOne.mockReset().mockResolvedValue({
    environmentId: "e1",
    name: "production",
    projectId: "p1",
    services: [
      {
        serviceType: "application",
        serviceId: "s1",
        name: "web",
        appName: "web-a1b2c3",
        status: "done",
        serverId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
});

afterEach(cleanup);

/**
 * The create dialog: one request carrying name, role,
 * grant and expiry, then the key, once.
 */
describe("CreateAgentModal", () => {
  it("starts on Reader, with nothing granted and a 90-day first key", async () => {
    open();

    const reader = screen.getByRole("button", { name: /^Reader/ });
    const operator = screen.getByRole("button", { name: /^Operator/ });
    expect(reader.getAttribute("aria-pressed")).toBe("true");
    expect(operator.getAttribute("aria-pressed")).toBe("false");
    // Each role says what it hands out, in one line.
    expect(reader.textContent).toMatch(/changes nothing/);
    expect(operator.textContent).toMatch(/deploys, starts, stops and cancels/);

    await waitFor(() => expect(box("Checkout")).toBeDefined());
    expect(ticked("Checkout")).toBe(false);
    expect(ticked("Billing")).toBe(false);
    expect(screen.getByRole("combobox").textContent).toMatch(/90 days/);
  });

  it("offers 30, 90 and 365 days for the first key, and never Never", async () => {
    open();

    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() =>
      expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "In 30 days",
      "In 90 days",
      "In a year",
    ]);
  });

  it("always tells the creator what the log mask does not cover", () => {
    open();
    expect(screen.getByText(LOG_MASK_NOTICE)).toBeDefined();
    expect(LOG_MASK_NOTICE).toBe(
      "This Agent can read the build and run logs of what you grant. Cloudgate masks the secrets it stores, not what a build prints.",
    );
  });

  it("saves an Agent with nothing granted, and sends every column", async () => {
    open();
    named("deploy-bot");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toEqual({
      name: "deploy-bot",
      role: "agentReader",
      grant: {
        accessedProjects: [],
        accessedEnvironments: [],
        accessedServices: [],
      },
      keyExpiresInDays: 90,
    });
  });

  it("lists only the Services the creator's own reads return, and sends what was ticked", async () => {
    open();
    await waitFor(() => expect(box("Checkout")).toBeDefined());
    fireEvent.click(box("Checkout"));
    await waitFor(() => expect(box("production")).toBeDefined());
    fireEvent.click(box("production"));
    await waitFor(() => expect(box("web web-a1b2c3")).toBeDefined());

    const services = within(
      screen.getByRole("region", { name: "Services" }),
    ).getAllByRole("checkbox");
    expect(services.map((each) => each.closest("li")?.textContent)).toEqual([
      "web web-a1b2c3Application",
    ]);

    fireEvent.click(box("web web-a1b2c3"));
    fireEvent.click(screen.getByRole("button", { name: /^Operator/ }));
    named("deploy-bot");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      role: "agentOperator",
      grant: {
        accessedProjects: ["p1"],
        accessedEnvironments: ["e1"],
        accessedServices: ["s1"],
      },
    });
  });

  it("offers Reader, Operator and Caller, and sends agentCaller when Caller is picked", async () => {
    open();

    const roles = within(screen.getByRole("group", { name: "Role" }))
      .getAllByRole("button")
      .map((each) => each.textContent);
    expect(roles).toEqual([
      expect.stringMatching(/^Reader/),
      expect.stringMatching(/^Operator/),
      expect.stringMatching(/^Caller/),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Caller/ }));
    named("chat-frontend");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      name: "chat-frontend",
      role: "agentCaller",
    });
  });

  it("shows the key once, beside the connect slot, and closes on I have copied it", async () => {
    const onOpenChange = open(vi.fn(), () => <p>client config goes here</p>);
    named("deploy-bot");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(screen.getByText(KEY)).toBeDefined());
    expect(screen.getByText("deploy-bot’s first key")).toBeDefined();
    expect(screen.getByText("client config goes here")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Copy the agent key" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not close the key's reveal on Escape", async () => {
    const onOpenChange = open(vi.fn());
    named("deploy-bot");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(screen.getByText(KEY)).toBeDefined());

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText(KEY)).toBeDefined();
  });

  it("keeps the form, and says why, when the create is refused", async () => {
    create.mockReset().mockRejectedValue(new Error("boom"));
    open();
    named("deploy-bot");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "Create Agent" })).toBeDefined();
  });

  it("puts a refusal of the name beside the Name field, not above the buttons", async () => {
    create.mockReset().mockRejectedValue(
      new ApiError(400, "Validation failed", {
        issues: [{ path: "name", message: "name is already an Agent's" }],
      }),
    );
    open();
    named("deploy-bot");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const input = screen.getByRole("textbox", { name: /^Name/ });
    await waitFor(() =>
      expect(input.getAttribute("aria-invalid")).toBe("true"),
    );
    const described = (input.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toMatch(/Name is already an Agent's\./);
  });
});
