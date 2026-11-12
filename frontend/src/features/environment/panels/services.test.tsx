import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentService } from "@/lib/api/endpoints/environments";
import type { ServiceHealthRow } from "@/lib/api/endpoints/service-health";
import type { PanelProps } from "@/lib/shell/tab-registry";

/**
 * The Environment's Services table and its Health column, with `fetch`
 * as the boundary: the Environment read and the health batch are real
 * requests through the real API client and hooks, so what is counted is what
 * the browser would send. The point is the count — one health request for
 * the whole table, never one per row.
 */

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
  useActiveMemberRole: () => ({ data: { role: "owner" } }),
}));
const canCreate = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({
    allowed: canCreate.allowed,
    pending: false,
    role: canCreate.allowed ? "owner" : "member",
  }),
}));
// The aside and the create dialogs read their own things; this is the table.
vi.mock("../environment-facts-card", () => ({
  EnvironmentFactsCard: () => null,
}));
vi.mock("../environment-network-card", () => ({
  EnvironmentNetworkCard: () => null,
}));
vi.mock("../pending-setups-card", () => ({
  PendingSetupsCard: () => null,
}));
vi.mock("@/features/application/create/create-ai-model-modal", () => ({
  CreateAiModelModal: () => null,
}));
vi.mock("@/features/application/create/create-application-modal", () => ({
  CreateApplicationModal: () => null,
}));
vi.mock("@/features/compose/create/create-compose-modal", () => ({
  CreateComposeModal: () => null,
}));
vi.mock("@/features/database/create/create-database-modal", () => ({
  CreateDatabaseModal: () => null,
}));
vi.mock("@/features/integrations/ai/draft-service-modal", () => ({
  DraftServiceModal: () => null,
}));

const { default: Panel } = await import("./services");

const service = (
  serviceId: string,
  name: string,
  serviceType: EnvironmentService["serviceType"] = "application",
): EnvironmentService => ({
  serviceType,
  serviceId,
  name,
  appName: `shop-${name}`,
  configName: name,
  description: null,
  status: "done",
  serverId: null,
  createdAt: "2026-09-01T10:00:00.000Z",
});

const SERVICES = [
  service("app-1", "api"),
  service("app-2", "web"),
  service("cmp-1", "stack", "compose"),
  service("pg-1", "db", "postgres"),
  service("app-3", "worker"),
];

const row = (
  serviceId: string,
  serviceType: ServiceHealthRow["serviceType"],
  state: ServiceHealthRow["state"],
): ServiceHealthRow => ({
  serviceType,
  serviceId,
  state,
  openIncident: state === "incident",
  openIncidents: state === "incident" ? 1 : 0,
  openSince: state === "incident" ? "2026-09-25T10:00:00.000Z" : null,
});

const HEALTH = [
  row("app-1", "application", "incident"),
  row("app-2", "application", "up"),
  row("cmp-1", "compose", "pending"),
  row("pg-1", "postgres", "unchecked"),
  row("app-3", "application", "down"),
];

const spendFigures = (prompt: number, completion: number) => ({
  promptTokens: { reported: prompt, estimated: 0 },
  completionTokens: { reported: completion, estimated: 0 },
  calls: { ok: 1, runtimeError: 0, clientAborted: 0, refused: 0 },
});

/** `GET /environments/env-1/token-spend`'s answer; `null` answers 404. */
const spend = vi.hoisted(() => ({ aiModels: [] as unknown[] | null }));

const fetchSpy = vi.fn();

function answer(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input), "http://console.test").pathname;
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  if (path.endsWith("/environments/env-1/token-spend") && spend.aiModels) {
    return json({
      from: "2026-09-17",
      to: "2026-10-16",
      total: spendFigures(1200, 34),
      days: [],
      aiModels: spend.aiModels,
    });
  }
  if (path.endsWith("/environments/env-1/health")) {
    return json({ environmentId: "env-1", services: HEALTH });
  }
  if (path.endsWith("/environments/env-1")) {
    return json({
      environmentId: "env-1",
      projectId: "p-1",
      name: "production",
      description: null,
      env: "",
      createdAt: "2026-09-01T10:00:00.000Z",
      services: SERVICES,
    });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

beforeEach(() => {
  canCreate.allowed = true;
  spend.aiModels = [];
  fetchSpy.mockReset().mockImplementation(answer);
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Panel
        {...({
          id: "env-1",
          label: "Services",
          icon: "box",
        } as unknown as PanelProps)}
      />
    </QueryClientProvider>,
  );
}

const requested = () =>
  fetchSpy.mock.calls.map(
    ([input]) => new URL(String(input), "http://console.test").pathname,
  );

describe("Environment Services table, Health column", () => {
  it("fills every row's Health from one request, and asks nothing per row", async () => {
    mount();

    const table = await screen.findByRole("table");
    // Every row has its state once the batch lands.
    await within(table).findByText("Incident open");
    for (const word of ["up", "not probed yet", "not checked", "down"]) {
      expect(within(table).getByText(word)).toBeTruthy();
    }

    const paths = requested();
    expect(paths.filter((path) => path.endsWith("/health"))).toEqual([
      expect.stringMatching(/\/environments\/env-1\/health$/),
    ]);
    expect(paths.some((path) => path.includes("/service-health/"))).toBe(false);
    // The Environment read, the health batch and the spend total, and
    // nothing else.
    expect(paths).toHaveLength(3);
  });

  it("puts the Health column beside Status", async () => {
    mount();

    const table = await screen.findByRole("table");
    const heads = within(table)
      .getAllByRole("columnheader")
      .map((head) => head.textContent?.trim());
    const status = heads.indexOf("Status");
    expect(status).toBeGreaterThanOrEqual(0);
    expect(heads[status + 1]).toBe("Health");
  });
});

describe("Add an AI model", () => {
  it("is a fifth create button for a role holding service create", async () => {
    mount();

    await screen.findByRole("table");
    const button = screen.getByRole("button", { name: /Add an AI model/ });
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("is hidden for a role without service create", async () => {
    canCreate.allowed = false;
    mount();

    await screen.findByRole("table");
    expect(
      screen.queryByRole("button", { name: /Add an AI model/ }),
    ).toBeNull();
    // The four it sits beside stay, turned off with the reason.
    expect(
      screen
        .getByRole("button", { name: /Add an Application/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

describe("Environment Services table, Token spend column", () => {
  it("gives each AI model its 30-day figure from the one spend request", async () => {
    spend.aiModels = [
      { applicationId: "app-1", name: "api", total: spendFigures(1200, 34) },
    ];
    mount();

    const table = await screen.findByRole("table");
    await within(table).findByText("1,234 tokens");
    const heads = within(table)
      .getAllByRole("columnheader")
      .map((head) => head.textContent?.trim());
    expect(heads).toContain("Token spend, 30 days");
    expect(requested().filter((path) => path.endsWith("/token-spend"))).toEqual(
      [expect.stringMatching(/\/environments\/env-1\/token-spend$/)],
    );
  });

  it("has no Token spend column when the reader can read no AI model here", async () => {
    mount();

    const table = await screen.findByRole("table");
    await within(table).findByText("Incident open");
    const heads = within(table)
      .getAllByRole("columnheader")
      .map((head) => head.textContent?.trim());
    expect(heads).not.toContain("Token spend, 30 days");
  });

  it("has no Token spend column when the spend read is refused", async () => {
    spend.aiModels = null;
    mount();

    const table = await screen.findByRole("table");
    await within(table).findByText("Incident open");
    expect(within(table).queryByText("Token spend, 30 days")).toBeNull();
  });
});
