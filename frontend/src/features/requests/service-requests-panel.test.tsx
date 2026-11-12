import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RequestRow,
  ServiceRequestsRead,
} from "@/lib/api/endpoints/monitoring";

const hooks = vi.hoisted(() => ({ useServiceRequestsRead: vi.fn() }));
const address = vi.hoisted(() => ({ search: "" }));
const replace = vi.hoisted(() => vi.fn());

// The system boundary, replaced: the tab's one HTTP read, the session, and
// the router the address lives in.
vi.mock("../monitoring/use-monitoring", async (original) => ({
  ...(await original<typeof import("../monitoring/use-monitoring")>()),
  ...hooks,
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
  useListOrganizations: () => ({
    data: [{ id: "org-1", name: "Hopper Labs" }],
  }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(address.search),
  useRouter: () => ({ replace }),
  usePathname: () => "/applications/app-1/requests",
}));

const { ServiceRequestsPanel } = await import("./service-requests-panel");

function row(fields: Partial<RequestRow>): RequestRow {
  return {
    RequestMethod: "GET",
    RequestProtocol: "HTTP/1.1",
    RequestScheme: "https",
    RequestAddr: "shop.example.com",
    RequestHost: "shop.example.com",
    RequestPath: "/",
    DownstreamStatus: 200,
    DownstreamContentSize: 10,
    Duration: 1_000_000,
    Overhead: 0,
    RetryAttempts: 0,
    ClientHost: "198.51.100.7",
    ClientAddr: "198.51.100.7:5000",
    entryPointName: "websecure",
    StartUTC: "2026-11-06T10:05:00Z",
    StartLocal: "2026-11-06T10:05:00Z",
    time: "2026-11-06T10:05:00Z",
    level: "info",
    ...fields,
  };
}

const READ: ServiceRequestsRead = {
  state: "ok",
  target: { serverId: "srv-a", name: "eu-web-1" },
  canSwitchLogging: false,
  readAt: "2026-11-06T10:30:00.000Z",
  data: [
    row({
      RequestPath: "/reset?token=***",
      service: { serviceId: "app-1", name: "shop" },
    }),
  ],
  totalCount: 1,
  hours: [{ hour: "2026-11-06T10:00:00Z", count: 1 }],
  services: [{ serviceId: "app-1", name: "shop" }],
  noService: false,
  wholeServer: true,
  covers: "service",
  withheldShared: 0,
};

function answer(data: ServiceRequestsRead) {
  hooks.useServiceRequestsRead.mockReturnValue({
    data,
    error: null,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
  });
}

function renderTab() {
  render(
    <ServiceRequestsPanel serviceId="app-1" label="Requests" icon="globe" />,
  );
}

beforeEach(() => {
  address.search = "";
  answer(READ);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ServiceRequestsPanel", () => {
  it("names the Server under the title, and reads the Service by its id alone", () => {
    renderTab();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Requests",
    );
    expect(screen.getByText("on Server eu-web-1")).toBeTruthy();
    const [serviceId, query] = hooks.useServiceRequestsRead.mock.lastCall as [
      string,
      Record<string, unknown>,
    ];
    expect(serviceId).toBe("app-1");
    expect(query).not.toHaveProperty("serverId");
    expect(query).not.toHaveProperty("serviceId");
  });

  it("has no Server picker, no Service filter and no Service column", () => {
    renderTab();

    expect(screen.queryByLabelText("Server")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /filter by service/i }),
    ).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /service/i })).toBeNull();
    // The rest of the table is the page's.
    expect(screen.getByRole("columnheader", { name: /client/i })).toBeTruthy();
    expect(screen.getByText("/reset?token=***")).toBeTruthy();
  });

  it("counts its requests without saying whose", () => {
    renderTab();

    expect(document.body.textContent).toContain("1 of 1 request in the last");
  });

  it("keeps the filters in the tab's own address", () => {
    renderTab();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "cart" },
    });

    const [href] = replace.mock.lastCall as [string];
    expect(href).toBe("/applications/app-1/requests?q=cart");
  });

  it("shows the page's no-lines message in place of the chart and table", () => {
    answer({ ...READ, state: "logging-off", data: [], totalCount: 0 });
    renderTab();

    expect(
      screen.getByRole("heading", {
        name: "Request logging is off on eu-web-1",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Only an owner or admin of Hopper Labs can turn it on."),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("reads a platform-host Service's own lines and names the platform host under the title", () => {
    answer({ ...READ, target: { serverId: null, name: "Platform host" } });
    renderTab();

    expect(screen.getByText("on the platform host")).toBeTruthy();
    expect(screen.getByText("/reset?token=***")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says some requests can't be shown when another Organization uses the same hostname on the platform host", () => {
    answer({
      ...READ,
      target: { serverId: null, name: "Platform host" },
      withheldShared: 3,
    });
    renderTab();

    expect(screen.getByRole("note").textContent).toBe(
      "Some requests to this Service can't be shown because another Organization uses the same hostname on the platform host.",
    );
  });

  it("tells a platform-host Service's reader without the switch to ask the Instance organization's owners or admins", () => {
    answer({
      ...READ,
      target: { serverId: null, name: "Platform host" },
      state: "logging-off",
      data: [],
      totalCount: 0,
    });
    renderTab();

    expect(
      screen.getByText(
        "Only an owner or admin of the Instance organization can turn it on.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says a Cloud account Service has no Requests, and where its requests are logged", () => {
    answer({
      state: "cloud-account",
      service: { serviceId: "app-1", name: "api" },
    });
    renderTab();

    expect(
      screen.getByRole("heading", {
        name: "No Requests for Cloud account Services",
      }),
    ).toBeTruthy();
    expect(document.body.textContent).toMatch(
      /runs in your cloud account, not on a Server with Traefik/,
    );
    expect(document.body.textContent).toMatch(/load balancer or CDN logs/);
    expect(screen.queryByText(/on Server/)).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
