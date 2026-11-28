import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { BoughtServerRow } from "@/lib/api/endpoints/bought-servers";

const api = vi.hoisted(() => ({
  offer: vi.fn(),
  list: vi.fn(),
  finishPaying: vi.fn(),
}));
const NOT_FOUND = "NEXT_NOT_FOUND";

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: "hosted", isPending: false }),
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false }),
}));
vi.mock("@/lib/api/endpoints/bought-servers", () => ({
  boughtServersApi: api,
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ boughtServers: () => Promise.resolve() }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));

const { BoughtServersScreen } = await import("./bought-servers-screen");

const HELSINKI = { city: "Helsinki", country: "FI" };

const WEB: BoughtServerRow = {
  id: "web",
  serverId: "web",
  name: "web-eu-1",
  stage: "ready",
  size: { family: "amd", vcpus: 3, memoryGb: 4, diskGb: 80 },
  location: HELSINKI,
  backups: true,
  monthlyCents: 3400,
};
const EDGE: BoughtServerRow = {
  id: "edge",
  serverId: "edge",
  name: "edge-1",
  stage: "changing",
  size: { family: "arm", vcpus: 2, memoryGb: 4, diskGb: 40 },
  location: { city: "Ashburn, VA", country: "US" },
  backups: false,
  monthlyCents: 700,
};
const WAITING: BoughtServerRow = {
  id: "worker",
  serverId: null,
  name: "worker-2",
  stage: "waiting_for_payment",
  size: { family: "shared", vcpus: 2, memoryGb: 4, diskGb: 40 },
  location: HELSINKI,
  backups: false,
  monthlyCents: 900,
};
const DELETING: BoughtServerRow = {
  id: "old",
  serverId: null,
  name: "old-db",
  stage: "deleting",
  size: { family: "shared", vcpus: 2, memoryGb: 4, diskGb: 40 },
  location: HELSINKI,
  backups: false,
  monthlyCents: 1200,
};

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BoughtServersScreen />
    </QueryClientProvider>,
  );
}

async function rowOf(name: string) {
  const table = await screen.findByRole("table", { name: "Bought Servers" });
  const row = within(table)
    .getAllByRole("row")
    .find((each) => each.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  api.offer.mockResolvedValue({ offered: true });
  api.list.mockResolvedValue([WEB, EDGE, WAITING]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.offer.mockReset();
  api.list.mockReset();
  api.finishPaying.mockReset();
});

describe("BoughtServersScreen", () => {
  it("shows each row's stage as a status pill, with its Location, size, backups and price", async () => {
    renderScreen();

    const web = await rowOf("web-eu-1");
    const pill = web.querySelector('[data-slot="status-pill"]');
    expect(pill?.textContent).toContain("Ready");
    expect(web.textContent).toContain("Helsinki, Finland");
    expect(web.textContent).toContain(
      "Performance · 3 vCPU · 4 GB RAM · 80 GB disk",
    );
    expect(web.textContent).toContain("On");
    expect(web.textContent).toContain("$34/month");

    const edge = await rowOf("edge-1");
    expect(
      edge.querySelector('[data-slot="status-pill"]')?.textContent,
    ).toContain("Changing");
    expect(edge.textContent).toContain("Off");

    const waiting = await rowOf("worker-2");
    expect(
      waiting.querySelector('[data-slot="status-pill"]')?.textContent,
    ).toContain("Waiting for payment");
  });

  it("totals what is on the plan's invoice, leaving out a Server still waiting for payment", async () => {
    renderScreen();

    await screen.findByRole("table", { name: "Bought Servers" });
    expect(document.body.textContent).toContain(
      "2 Bought Servers, $41/month on your plan's invoice. 1 is waiting for payment.",
    );
  });

  it("leaves a Deleting Server out of the count and the total, and shows no price for it", async () => {
    api.list.mockResolvedValue([WEB, EDGE, WAITING, DELETING]);
    renderScreen();

    const old = await rowOf("old-db");
    expect(
      old.querySelector('[data-slot="status-pill"]')?.textContent,
    ).toContain("Deleting");
    // Deletion has already taken it off the subscription.
    expect(old.textContent).not.toContain("$12/month");
    expect(old.textContent).toContain("Not charged");
    expect(document.body.textContent).toContain(
      "2 Bought Servers, $41/month on your plan's invoice. 1 is waiting for payment.",
    );
  });

  it("opens a Server's Bought Server tab from Manage", async () => {
    renderScreen();

    const web = await rowOf("web-eu-1");
    expect(
      within(web).getByRole("link", { name: "Manage" }).getAttribute("href"),
    ).toBe("/servers/web/bought-server");
  });

  it("offers Finish paying, not Manage, on a Server waiting for payment, and sends the browser to pay", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
    });
    api.finishPaying.mockResolvedValue({
      id: "worker",
      stage: "waiting_for_payment",
      payUrl: "https://pay.example/3ds",
    });
    renderScreen();

    const waiting = await rowOf("worker-2");
    expect(within(waiting).queryByRole("link", { name: "Manage" })).toBeNull();
    fireEvent.click(
      within(waiting).getByRole("button", { name: "Finish paying" }),
    );

    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://pay.example/3ds"),
    );
    expect(api.finishPaying).toHaveBeenCalledWith("worker");
  });

  it("says why when Finish paying finds the card refused", async () => {
    api.finishPaying.mockRejectedValue(
      new ApiError(
        402,
        "The payment was refused, so nothing was charged and no Server was bought. Your card has insufficient funds.",
        { code: "BOUGHT_SERVER_PAYMENT_REFUSED" },
      ),
    );
    renderScreen();

    fireEvent.click(
      await screen.findByRole("button", { name: "Finish paying" }),
    );

    expect(
      await screen.findByText(/Your card has insufficient funds/),
    ).toBeTruthy();
  });

  it("offers Buy a Server in the header", async () => {
    renderScreen();

    await screen.findByRole("table", { name: "Bought Servers" });
    expect(
      screen.getByRole("link", { name: "Buy a Server" }).getAttribute("href"),
    ).toBe("/servers/buy");
  });

  it("starts its empty state with Buy a Server while nothing is bought", async () => {
    api.list.mockResolvedValue([]);
    renderScreen();

    const title = await screen.findByRole("heading", {
      name: "No Bought Servers yet",
    });
    const body = title.nextElementSibling?.textContent ?? "";
    expect(body).toMatch(/^Buy a Server to /);
  });
});
