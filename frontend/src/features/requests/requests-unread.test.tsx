import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RequestsRead,
  RequestsReadState,
  RequestsTargets,
} from "@/lib/api/endpoints/monitoring";

const hooks = vi.hoisted(() => ({
  useRequestTargets: vi.fn(),
  useRequestsRead: vi.fn(),
  useRequestLogging: vi.fn(),
}));
const address = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
const gate = vi.hoisted(() => ({ allowed: true }));

// The system boundary, replaced: the two HTTP reads behind the page, the
// session and the Organization's name, the role read behind Add a Server, and
// the router the address lives in.
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
  usePermission: () => ({ allowed: gate.allowed, pending: false }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(address.search),
  useRouter: () => ({ replace: address.replace }),
  usePathname: () => "/requests",
}));

const { RequestsScreen } = await import("./requests-screen");

const TARGETS: RequestsTargets = {
  servers: [
    { serverId: "srv-a", name: "alpha" },
    { serverId: "srv-z", name: "zeta" },
  ],
  platformHost: false,
  cloudAccountServices: false,
};

const refetch = vi.fn();

/** A read of alpha that found nothing, in `state`, for this caller. */
function answered(state: RequestsReadState, canSwitchLogging: boolean) {
  const read: RequestsRead = {
    state,
    target: { serverId: "srv-a", name: "alpha" },
    canSwitchLogging,
    readAt: "2026-11-06T10:30:00.000Z",
    data: [],
    totalCount: 0,
    hours: [],
    services: [],
    noService: false,
    wholeServer: true,
    covers: "server",
    withheldShared: 0,
  };
  hooks.useRequestsRead.mockReturnValue({
    data: read,
    error: null,
    isPending: false,
    isFetching: false,
    refetch,
  });
}

beforeEach(() => {
  address.search = "";
  gate.allowed = true;
  localStorage.clear();
  hooks.useRequestTargets.mockReturnValue({
    data: TARGETS,
    error: null,
    isPending: false,
  });
  hooks.useRequestLogging.mockReturnValue({ data: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The one centred message, found by its title. */
function message(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  return heading.parentElement as HTMLElement;
}

/** Every button and link the message offers, by its words. */
function actions(title: string): string[] {
  const within_ = within(message(title));
  return [
    ...within_.queryAllByRole("button"),
    ...within_.queryAllByRole("link"),
  ].map((each) => each.textContent?.trim() ?? "");
}

const OWNER = true;
const MEMBER = false;

describe("RequestsScreen, when a read has nothing to show", () => {
  it("says it can't reach the Server, that nothing older is kept, and offers Try again and Server status", () => {
    answered("unreachable", MEMBER);
    render(<RequestsScreen />);

    const box = message("Can't reach alpha");
    expect(box.textContent).toContain("Cloudgate keeps nothing");
    expect(actions("Can't reach alpha").sort()).toEqual([
      "Server status",
      "Try again",
    ]);
    expect(
      within(box).getByRole("link", { name: "Server status" }),
    ).toHaveProperty(
      "href",
      expect.stringMatching(/\/servers\/srv-a\/infrastructure$/),
    );

    fireEvent.click(within(box).getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("sends an owner or admin to the Request logging card when logging is off", () => {
    answered("logging-off", OWNER);
    render(<RequestsScreen />);

    const box = message("Request logging is off on alpha");
    expect(actions("Request logging is off on alpha")).toEqual([
      "Open alpha settings",
    ]);
    expect(
      within(box).getByRole("link", { name: "Open alpha settings" }),
    ).toHaveProperty(
      "href",
      expect.stringMatching(/\/servers\/srv-a\/settings#request-logging$/),
    );
  });

  it("tells another member only an owner or admin can turn logging on, with no button", () => {
    answered("logging-off", MEMBER);
    render(<RequestsScreen />);

    const box = message("Request logging is off on alpha");
    expect(box.textContent).toContain(
      "Only an owner or admin of Hopper Labs can turn it on",
    );
    expect(actions("Request logging is off on alpha")).toEqual([]);
  });

  it("links an owner or admin to the settings card while Traefik waits for a restart, and offers no Restart", () => {
    answered("awaiting-restart", OWNER);
    render(<RequestsScreen />);

    const box = message("Waiting for Traefik to restart on alpha");
    expect(actions("Waiting for Traefik to restart on alpha")).toEqual([
      "Open alpha settings",
    ]);
    expect(
      within(box).getByRole("link", { name: "Open alpha settings" }),
    ).toHaveProperty(
      "href",
      expect.stringMatching(/\/servers\/srv-a\/settings#request-logging$/),
    );
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
  });

  it("tells another member to ask an owner or admin while Traefik waits for a restart", () => {
    answered("awaiting-restart", MEMBER);
    render(<RequestsScreen />);

    const box = message("Waiting for Traefik to restart on alpha");
    expect(box.textContent).toContain("Ask an owner or admin of Hopper Labs");
    expect(actions("Waiting for Traefik to restart on alpha")).toEqual([]);
  });

  it.each([OWNER, MEMBER])(
    "says no requests have arrived since Traefik started (owner or admin: %s)",
    (role) => {
      answered("empty", role);
      render(<RequestsScreen />);

      const box = message("No requests yet on alpha");
      expect(box.textContent).toContain(
        "Nothing has arrived since Traefik started",
      );
      expect(actions("No requests yet on alpha")).toEqual([]);
    },
  );

  it.each([OWNER, MEMBER])(
    "says the read was stopped after 10 seconds and offers the last 15 minutes and Try again (owner or admin: %s)",
    (role) => {
      answered("too-slow", role);
      render(<RequestsScreen />);

      const box = message("Reading alpha took too long");
      expect(box.textContent).toContain("stopped after 10 seconds");
      expect(actions("Reading alpha took too long")).toEqual([
        "Try the last 15 minutes",
        "Try again",
      ]);

      fireEvent.click(
        within(box).getByRole("button", { name: "Try the last 15 minutes" }),
      );
      expect(address.replace).toHaveBeenCalledWith(
        "/requests?range=15m",
        expect.anything(),
      );
      fireEvent.click(within(box).getByRole("button", { name: "Try again" }));
      expect(refetch).toHaveBeenCalledOnce();
    },
  );

  it.each<[RequestsReadState, boolean]>([
    ["unreachable", OWNER],
    ["unreachable", MEMBER],
    ["logging-off", OWNER],
    ["logging-off", MEMBER],
    ["awaiting-restart", OWNER],
    ["awaiting-restart", MEMBER],
    ["empty", OWNER],
    ["empty", MEMBER],
    ["too-slow", OWNER],
    ["too-slow", MEMBER],
  ])(
    "in %s (owner or admin: %s), replaces the chart and the table, greys the filters and keeps the picker live",
    (state, role) => {
      answered(state, role);
      render(<RequestsScreen />);

      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.queryByText("Requests per hour")).toBeNull();

      const filters = screen.getByRole("group", { name: "Filters" });
      expect((filters as HTMLFieldSetElement).disabled).toBe(true);
      const controls = filters.querySelectorAll("button, input");
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control.matches(":disabled")).toBe(true);
      }

      const picker = document.getElementById("requests-server");
      expect(picker).not.toBeNull();
      expect(picker?.matches(":disabled")).toBe(false);
      expect(filters.contains(picker)).toBe(false);
    },
  );

  it("leaves the filters live on an ok read", () => {
    hooks.useRequestsRead.mockReturnValue({
      data: {
        state: "ok",
        target: { serverId: "srv-a", name: "alpha" },
        canSwitchLogging: true,
        readAt: "2026-11-06T10:30:00.000Z",
        data: [],
        totalCount: 0,
        hours: [],
        services: [],
        noService: false,
        wholeServer: true,
        covers: "server",
        withheldShared: 0,
      } satisfies RequestsRead,
      error: null,
      isPending: false,
      isFetching: false,
      refetch,
    });
    render(<RequestsScreen />);

    const filters = screen.getByRole("group", { name: "Filters" });
    expect((filters as HTMLFieldSetElement).disabled).toBe(false);
  });
});

describe("RequestsScreen, with no Servers", () => {
  function noServers(cloudAccountServices: boolean) {
    hooks.useRequestTargets.mockReturnValue({
      data: { servers: [], platformHost: false, cloudAccountServices },
      error: null,
      isPending: false,
    });
    hooks.useRequestsRead.mockReturnValue({
      data: undefined,
      error: null,
      isPending: true,
      isFetching: false,
      refetch,
    });
  }

  it("says what the page is for and gives an owner or admin Add a Server", () => {
    noServers(false);
    render(<RequestsScreen />);

    const box = message("No Servers yet");
    expect(box.textContent).toContain(
      "Requests shows the traffic your Services receive on your own Servers.",
    );
    expect(
      within(box).getByRole("link", { name: "Add a Server" }),
    ).toHaveProperty("href", expect.stringMatching(/\/servers$/));
    expect(box.textContent).not.toContain("load balancer");
  });

  it("gives another member no Add a Server", () => {
    noServers(false);
    gate.allowed = false;
    render(<RequestsScreen />);

    expect(actions("No Servers yet")).toEqual([]);
  });

  it("points an Organization with Cloud account Services to its cloud's own load balancer or CDN logs", () => {
    noServers(true);
    render(<RequestsScreen />);

    const box = message("No Servers yet");
    expect(box.textContent).toContain("Cloud account");
    expect(box.textContent).toContain("load balancer or CDN logs");
  });
});
