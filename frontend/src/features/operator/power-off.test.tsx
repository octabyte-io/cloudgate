import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OperatorBoughtServer } from "@/lib/api/endpoints/operator";

const api = vi.hoisted(() => ({
  boughtServers: vi.fn(),
  boughtServerSettings: vi.fn(),
  setBoughtServerSettings: vi.fn(),
}));
const abuseApi = vi.hoisted(() => ({
  reports: vi.fn(),
  forward: vi.fn(),
  close: vi.fn(),
  powerOff: vi.fn(),
  powerOn: vi.fn(),
}));
const invalidated = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/endpoints/operator", () => ({ operatorApi: api }));
vi.mock("@/lib/api/endpoints/operator-abuse", () => ({
  operatorAbuseApi: abuseApi,
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({
    operatorBoughtServers: invalidated,
    operatorPower: invalidated,
  }),
}));

const { BoughtServersSection } = await import("./bought-servers-section");

afterEach(() => {
  cleanup();
  abuseApi.powerOff.mockReset();
  abuseApi.powerOn.mockReset();
  invalidated.mockReset();
});

const WEB: OperatorBoughtServer = {
  id: "bs-web",
  name: "web-1",
  organization: { id: "org-hopper", name: "Hopper Labs" },
  serverType: "cpx22",
  location: "hel1",
  stage: "ready",
  monthlyCents: 2500,
  providerServerId: 4242,
  margin: null,
  belowFloor: false,
  poweredOff: null,
  createdAt: "2026-11-01T09:00:00.000Z",
};

function renderSection(servers: OperatorBoughtServer[]) {
  api.boughtServers.mockResolvedValue({
    exchangeRate: null,
    costsRead: true,
    marginFloorPercent: 10,
    servers,
  });
  api.boughtServerSettings.mockResolvedValue({
    markupPercent: 20,
    marginFloorPercent: 10,
    reverseDnsDomain: "servers.octabyte.test",
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BoughtServersSection />
    </QueryClientProvider>,
  );
}

async function rowOf(name: string): Promise<HTMLElement> {
  const table = await screen.findByRole("table", {
    name: "Bought Servers on this instance",
  });
  return within(table).getByText(name).closest("tr") as HTMLElement;
}

/**
 * The Bought Servers table's Power column (#1401): Power off with a
 * required reason, and Power on for one an Operator powered off.
 */
describe("powerColumn", () => {
  it("powers a Bought Server off with the reason typed, and asks for one first", async () => {
    abuseApi.powerOff.mockResolvedValue({
      poweredOffAt: "2026-11-10T09:00:00.000Z",
      reason: "Port scan",
    });
    renderSection([WEB]);

    fireEvent.click(
      within(await rowOf("web-1")).getByRole("button", { name: "Power off" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("the customer cannot");
    const confirm = within(dialog).getByRole("button", { name: "Power off" });
    fireEvent.click(confirm);
    expect(
      await within(dialog).findByText("Give the reason the customer will see"),
    ).toBeDefined();
    expect(abuseApi.powerOff).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: " Port scan " },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(abuseApi.powerOff).toHaveBeenCalledWith("bs-web", "Port scan"),
    );
    await waitFor(() => expect(invalidated).toHaveBeenCalled());
  });

  it("shows one an Operator powered off, and powers it back on", async () => {
    abuseApi.powerOn.mockResolvedValue(undefined);
    renderSection([
      {
        ...WEB,
        poweredOff: { at: "2026-11-10T09:00:00.000Z", reason: "Port scan" },
      },
    ]);

    const row = await rowOf("web-1");
    expect(row.textContent).toContain("Powered off");
    expect(within(row).queryByRole("button", { name: "Power off" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Power on" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Powered off for: Port scan");
    fireEvent.click(within(dialog).getByRole("button", { name: "Power on" }));

    await waitFor(() =>
      expect(abuseApi.powerOn).toHaveBeenCalledWith("bs-web"),
    );
  });

  it("offers nothing for a Bought Server with no running machine", async () => {
    renderSection([{ ...WEB, stage: "deleted" }]);

    const row = await rowOf("web-1");
    expect(within(row).queryByRole("button", { name: /Power/ })).toBeNull();
  });
});
