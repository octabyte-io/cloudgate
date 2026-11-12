import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RequestRow,
  RequestsRead,
  RequestsTargets,
} from "@/lib/api/endpoints/monitoring";

const hooks = vi.hoisted(() => ({
  useRequestTargets: vi.fn(),
  useRequestsRead: vi.fn(),
  useRequestLogging: vi.fn(),
}));
const address = vi.hoisted(() => ({ search: "" }));
const replace = vi.hoisted(() => vi.fn());

// The system boundary, replaced: the two HTTP reads behind the page, the
// session, and the router the address lives in.
vi.mock("../monitoring/use-monitoring", async (original) => ({
  ...(await original<typeof import("../monitoring/use-monitoring")>()),
  ...hooks,
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
  useSession: () => ({ data: { user: { id: "user-1" } } }),
  useListOrganizations: () => ({
    data: [{ id: "org-1", name: "Hopper Labs" }],
  }),
}));
vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: () => ({ allowed: true, pending: false }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(address.search),
  useRouter: () => ({ replace }),
  usePathname: () => "/requests",
}));

const { RequestsScreen } = await import("./requests-screen");

const TARGETS: RequestsTargets = {
  // Not in name order, as nothing promises they arrive in it.
  servers: [
    { serverId: "srv-z", name: "zeta" },
    { serverId: "srv-a", name: "alpha" },
  ],
  platformHost: false,
  cloudAccountServices: false,
};

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

const READ: RequestsRead = {
  state: "ok",
  target: { serverId: "srv-a", name: "alpha" },
  canSwitchLogging: true,
  readAt: "2026-11-06T10:30:00.000Z",
  data: [
    row({
      RequestPath: "/reset?token=***&user=***",
      "request_User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
      service: { serviceId: "app-1", name: "shop" },
    }),
    row({
      RequestHost: undefined,
      RequestPath: "/wp-login.php",
      StartUTC: "2026-11-06T10:06:00Z",
      service: null,
    }),
  ],
  totalCount: 2,
  hours: [{ hour: "2026-11-06T10:00:00Z", count: 2 }],
  services: [
    { serviceId: "app-2", name: "blog" },
    { serviceId: "app-1", name: "shop" },
  ],
  noService: true,
  wholeServer: true,
  covers: "server",
  withheldShared: 0,
};

/** The page answered with this read. */
function answer(fields: Partial<RequestsRead>) {
  hooks.useRequestsRead.mockReturnValue({
    data: { ...READ, ...fields },
    error: null,
    isPending: false,
    isFetching: false,
  });
}

/** The address the page last wrote. */
function written(): URLSearchParams {
  const [href] = replace.mock.lastCall as [string];
  return new URLSearchParams(href.split("?")[1] ?? "");
}

/** Opens the Service filter and returns its options' names. */
function serviceOptions(): string[] {
  fireEvent.click(screen.getByRole("button", { name: /filter by service/i }));
  return screen
    .getAllByRole("checkbox")
    .map((box) => box.closest("label")?.textContent?.trim() ?? "");
}

beforeEach(() => {
  address.search = "";
  localStorage.clear();
  hooks.useRequestTargets.mockReturnValue({
    data: TARGETS,
    error: null,
    isPending: false,
  });
  hooks.useRequestsRead.mockReturnValue({
    data: READ,
    error: null,
    isPending: false,
    isFetching: false,
  });
  hooks.useRequestLogging.mockReturnValue({ data: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The serverId the page asked to read. */
function readServer(): string | undefined {
  const [query] = hooks.useRequestsRead.mock.lastCall as [
    { serverId?: string },
  ];
  return query.serverId;
}

describe("RequestsScreen", () => {
  it("opens on the first Server by name when the address names none and nothing was viewed", () => {
    render(<RequestsScreen />);

    expect(readServer()).toBe("srv-a");
  });

  it("says a Server the address names and the picker does not list is not found or not permitted, and reads nothing", () => {
    // A shared link to a Server this person cannot see, or one since deleted:
    // the same answer for both, so the link reveals nothing.
    address.search = "server=srv-gone";
    render(<RequestsScreen />);

    expect(screen.getByText("Server not found or not permitted")).toBeTruthy();
    const [, enabled] = hooks.useRequestsRead.mock.lastCall as [
      unknown,
      boolean,
    ];
    expect(enabled).toBe(false);
    // The picker stays, to choose a Server this person can read.
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("falls back to the first Server by name when the Server last viewed here is no longer listed", () => {
    localStorage.setItem(
      "cloudgate.user-1.requests-server.org-1",
      JSON.stringify("srv-gone"),
    );
    render(<RequestsScreen />);

    expect(readServer()).toBe("srv-a");
    expect(screen.queryByText("Server not found or not permitted")).toBeNull();
  });

  it("opens on the Server the address names", () => {
    address.search = "server=srv-z";
    render(<RequestsScreen />);

    expect(readServer()).toBe("srv-z");
  });

  it("shows each line's Service, and a No Service chip for a line that matched none", () => {
    render(<RequestsScreen />);

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows.some((each) => each.textContent?.includes("shop"))).toBe(true);
    expect(within(table).getByText("No Service")).toBeTruthy();
    expect(within(table).queryByText("Router")).toBeNull();
  });

  it("shows query values as *** with their names kept", () => {
    render(<RequestsScreen />);

    expect(screen.getByText("/reset?token=***&user=***")).toBeTruthy();
  });

  it("shows the client's IP with its User-Agent on a second line", () => {
    render(<RequestsScreen />);

    const agent = screen.getByText("Mozilla/5.0 (X11; Linux x86_64)");
    expect(agent.parentElement?.textContent).toContain("198.51.100.7");
  });

  it("says which Server the lines were read from, and when", () => {
    render(<RequestsScreen />);

    expect(document.body.textContent).toContain("Read from alpha at");
  });

  describe("the platform host, for an Organization with a Service there", () => {
    beforeEach(() => {
      hooks.useRequestTargets.mockReturnValue({
        data: { servers: [], platformHost: true, cloudAccountServices: false },
        error: null,
        isPending: false,
      });
      answer({
        target: { serverId: null, name: "Platform host" },
        canSwitchLogging: false,
        services: [{ serviceId: "app-1", name: "shop" }],
        noService: false,
        wholeServer: false,
        covers: "your-services",
      });
    });

    it("reads the platform host with a Service filter of only the caller's Services", () => {
      render(<RequestsScreen />);

      expect(readServer()).toBeUndefined();
      expect(serviceOptions()).toEqual(["All yours", "shop"]);
    });

    it("sends the chosen Services with the platform host's read", () => {
      address.search = "server=platform-host&service=app-1";
      render(<RequestsScreen />);

      const [query] = hooks.useRequestsRead.mock.lastCall as [
        { serverId?: string; serviceId?: string[] },
      ];
      expect(query.serverId).toBeUndefined();
      expect(query.serviceId).toEqual(["app-1"]);
    });

    it("offers no logging switch, and says to ask the Instance organization's owners or admins when logging is off", () => {
      answer({
        target: { serverId: null, name: "Platform host" },
        canSwitchLogging: false,
        state: "logging-off",
        data: [],
        totalCount: 0,
      });
      render(<RequestsScreen />);

      expect(hooks.useRequestLogging).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          "Only an owner or admin of the Instance organization can turn it on.",
        ),
      ).toBeTruthy();
    });

    it("says some requests to your Services can't be shown when a hostname is shared", () => {
      answer({
        target: { serverId: null, name: "Platform host" },
        canSwitchLogging: false,
        covers: "your-services",
        withheldShared: 2,
      });
      render(<RequestsScreen />);

      expect(screen.getByRole("note").textContent).toContain(
        "Some requests to your Services can't be shown",
      );
    });
  });

  describe("the Service filter", () => {
    it("offers All, each Service, then No Service to a caller who sees the whole Server", () => {
      render(<RequestsScreen />);

      expect(serviceOptions()).toEqual(["All", "blog", "shop", "No Service"]);
    });

    it("offers All yours, and no No Service, to a member who sees only some Services", () => {
      answer({
        services: [{ serviceId: "app-1", name: "shop" }],
        noService: false,
        wholeServer: false,
        covers: "your-services",
      });
      render(<RequestsScreen />);

      expect(serviceOptions()).toEqual(["All yours", "shop"]);
    });

    it("says the totals are to your Services when the caller sees only some", () => {
      answer({ covers: "your-services" });
      render(<RequestsScreen />);

      expect(document.body.textContent).toContain(
        "2 of 2 requests to your Services",
      );
    });

    it("says the totals are to the chosen Services when Services were picked", () => {
      address.search = "service=app-1";
      answer({ covers: "chosen-services" });
      render(<RequestsScreen />);

      expect(document.body.textContent).toContain(
        "2 of 2 requests to the chosen Services",
      );
    });

    it("reads the Services and No Service the address names", () => {
      address.search = "server=srv-a&service=app-1&service=app-2&noService=1";
      render(<RequestsScreen />);

      const [query] = hooks.useRequestsRead.mock.lastCall as [
        { serviceId?: string[]; noService?: boolean },
      ];
      expect(query.serviceId).toEqual(["app-1", "app-2"]);
      expect(query.noService).toBe(true);
    });

    it("writes a picked Service into the address, and All clears it", () => {
      address.search = "server=srv-a&noService=1";
      render(<RequestsScreen />);

      serviceOptions();
      fireEvent.click(screen.getByRole("checkbox", { name: "shop" }));
      const picked = written();
      expect(picked.getAll("service")).toEqual(["app-1"]);
      expect(picked.get("noService")).toBe("1");
      expect(picked.get("server")).toBe("srv-a");

      fireEvent.click(screen.getByRole("checkbox", { name: "All" }));
      expect(written().toString()).toBe("server=srv-a");
    });
  });
});
