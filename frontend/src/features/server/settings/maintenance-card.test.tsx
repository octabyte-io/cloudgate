import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Start and End maintenance on a Server's Settings tab (spec #1420), with the
 * network as the one boundary: `fetch` answers the session and role reads,
 * which run through the real auth client and `usePermission`, the Server row
 * through the real API client and `useServer`, and the two maintenance routes,
 * which flip the row the next read returns. Nothing of ours is mocked.
 */

// jsdom has no `matchMedia`, and sonner's `Toaster` asks it for the colour
// scheme. A browser API, so it is the thing stubbed.
vi.stubGlobal(
  "matchMedia",
  (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList,
);

const SERVER_ID = "srv-1";
const SINCE = "2026-11-12T15:00:00.000Z";

/**
 * What the stubbed backend holds; reset per test.
 *
 * **The caller is always the custom role `operator`, and only its grants
 * change.** better-auth keeps the active member role in a module-level atom
 * that outlives a test, so a role *name* set in one test would still be the
 * answer in the next; a custom role's grants are read through react-query,
 * and every mount brings a fresh client.
 */
let world: { serverGrants: string[]; maintenanceSince: string | null };
const posts: string[] = [];

function serverRow() {
  return {
    serverId: SERVER_ID,
    name: "edge-1",
    ipAddress: "203.0.113.42",
    port: 22,
    username: "root",
    serverStatus: "active",
    serverType: "deploy",
    reachCheckedAt: null,
    reachOk: null,
    maintenanceSince: world.maintenanceSince,
    maintenanceStartedBy: world.maintenanceSince ? "user-1" : null,
    boughtServer: null,
    createdAt: "2026-09-17T10:00:00.000Z",
  };
}

/** The vocabulary as `GET /custom-roles/statements` serves it, cut to `server`. */
const VOCABULARY = {
  statements: { server: ["read", "create", "delete"] },
  staticRoles: {
    owner: { server: ["read", "create", "delete"] },
    admin: { server: ["read", "create", "delete"] },
    member: { server: ["read"] },
  },
  enterpriseOnlyResources: [],
  internalResources: [],
};

function answer(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const path = new URL(url, "http://console.test").pathname;
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );

  if (path.endsWith("/get-session")) {
    return json({
      session: { id: "session-1", activeOrganizationId: "org-1" },
      user: { id: "user-1", email: "operator@example.test" },
    });
  }
  if (path.endsWith("/organization/get-active-member-role")) {
    return json({ role: "operator" });
  }
  if (path.endsWith("/custom-roles/statements")) return json(VOCABULARY);
  if (path.endsWith("/custom-roles")) {
    return json([
      {
        role: "operator",
        permissions: { server: world.serverGrants },
        createdAt: "2026-09-01T10:00:00.000Z",
        ids: ["role-1"],
        memberCount: 1,
      },
    ]);
  }
  if (method === "POST" && path.endsWith(`/servers/${SERVER_ID}/start-maintenance`)) {
    posts.push("start");
    world.maintenanceSince = SINCE;
    return json(serverRow());
  }
  if (method === "POST" && path.endsWith(`/servers/${SERVER_ID}/end-maintenance`)) {
    posts.push("end");
    world.maintenanceSince = null;
    return json(serverRow());
  }
  if (method === "GET" && path.endsWith(`/servers/${SERVER_ID}`)) {
    return json(serverRow());
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

// Before anything that builds the auth client is imported: `createAuthClient`
// captures `fetch` as its module evaluates.
vi.stubGlobal("fetch", vi.fn(answer));

const { MaintenanceCard } = await import("./maintenance-card");
const { MaintenanceNotice } = await import("../maintenance-notice");
const { SERVER_UPDATE_REFUSAL, useServer } = await import("../use-server");
const { Toaster } = await import("@/components/console/toast");

/** The Settings tab's slice of a Server page: the notice every tab shows, and the card. */
function ServerPage() {
  const { data: server } = useServer(SERVER_ID);
  if (!server) return null;
  return (
    <>
      <MaintenanceNotice server={server} />
      <MaintenanceCard server={server} />
    </>
  );
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ServerPage />
      <Toaster />
    </QueryClientProvider>,
  );
}

/** Off as the console's Button draws it: `disabled`, or focusable and `aria-disabled`. */
const isOff = (button: HTMLElement) =>
  button.hasAttribute("disabled") ||
  button.getAttribute("aria-disabled") === "true";

const notice = () => document.querySelector('[data-slot="maintenance-notice"]');

beforeEach(() => {
  world = { serverGrants: ["read", "create"], maintenanceSince: null };
  posts.length = 0;
});

afterEach(cleanup);

describe("MaintenanceCard", () => {
  it("asks in a dialog naming the Server before it starts maintenance, then the page shows the notice", async () => {
    mount();

    fireEvent.click(
      await screen.findByRole("button", { name: "Start maintenance" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Start maintenance on edge-1?");
    expect(posts).toEqual([]);
    expect(notice()).toBeNull();

    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Start maintenance",
    )!;
    fireEvent.click(confirm);

    await waitFor(() => expect(notice()).not.toBeNull());
    expect(posts).toEqual(["start"]);
    expect(notice()?.textContent).toContain(
      "Nothing new will start on this Server.",
    );
  });

  it("ends maintenance, and the notice goes", async () => {
    world.maintenanceSince = SINCE;
    mount();
    await waitFor(() => expect(notice()).not.toBeNull());

    fireEvent.click(
      await screen.findByRole("button", { name: "End maintenance" }),
    );

    await waitFor(() => expect(notice()).toBeNull());
    expect(posts).toEqual(["end"]);
    expect(
      await screen.findByRole("button", { name: "Start maintenance" }),
    ).toBeDefined();
  });

  it("offers neither control to a role without server: create, and says why as Forget host key does", async () => {
    world.serverGrants = ["read"];
    mount();

    const start = await screen.findByRole("button", {
      name: "Start maintenance",
    });
    await screen.findByText(SERVER_UPDATE_REFUSAL);
    expect(isOff(start)).toBe(true);
    fireEvent.click(start);
    expect(screen.queryByRole("dialog")).toBeNull();

    cleanup();
    world.maintenanceSince = SINCE;
    mount();

    const end = await screen.findByRole("button", { name: "End maintenance" });
    await screen.findByText(SERVER_UPDATE_REFUSAL);
    expect(isOff(end)).toBe(true);
    fireEvent.click(end);
    expect(posts).toEqual([]);
  });
});
