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

import type {
  BoughtServerSettings,
  OperatorBoughtServer,
  OperatorBoughtServers,
} from "@/lib/api/endpoints/operator";

const api = vi.hoisted(() => ({
  boughtServers: vi.fn(),
  boughtServerSettings: vi.fn(),
  setBoughtServerSettings: vi.fn(),
}));
const invalidated = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/endpoints/operator", () => ({ operatorApi: api }));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ operatorBoughtServers: invalidated }),
}));

const { BoughtServersSection } = await import("./bought-servers-section");

afterEach(() => {
  cleanup();
  api.boughtServers.mockReset();
  api.boughtServerSettings.mockReset();
  api.setBoughtServerSettings.mockReset();
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
  margin: { costCents: 1971, marginCents: 529, marginPercent: 21.2 },
  belowFloor: false,
  poweredOff: null,
  createdAt: "2026-11-01T09:00:00.000Z",
};

const DB: OperatorBoughtServer = {
  ...WEB,
  id: "bs-db",
  name: "db-1",
  organization: { id: "org-wu", name: "Wu Contracting" },
  monthlyCents: 3200,
  providerServerId: 4243,
  margin: { costCents: 3017, marginCents: 183, marginPercent: 5.7 },
  belowFloor: true,
};

const LISTING: OperatorBoughtServers = {
  exchangeRate: { usdPerEur: 1.16, on: "2026-11-10" },
  costsRead: true,
  marginFloorPercent: 10,
  servers: [WEB, DB],
};

const SETTINGS: BoughtServerSettings = {
  markupPercent: 20,
  marginFloorPercent: 10,
  reverseDnsDomain: "servers.octabyte.test",
};

function renderSection(
  listing: OperatorBoughtServers = LISTING,
  settings: BoughtServerSettings = SETTINGS,
) {
  api.boughtServers.mockResolvedValue(listing);
  api.boughtServerSettings.mockResolvedValue(settings);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BoughtServersSection />
    </QueryClientProvider>,
  );
}

async function table() {
  return screen.findByRole("table", {
    name: "Bought Servers on this instance",
  });
}

function rowOf(container: HTMLElement, name: string): HTMLElement {
  const cell = within(container).getByText(name);
  return cell.closest("tr") as HTMLElement;
}

/**
 * The Operator page's Bought Servers section (#1399): every Bought Server's
 * account facts with its real margin at the day's rate, flagged and
 * filterable under the margin floor, and the Server markup and floor.
 */
describe("BoughtServersSection", () => {
  it("lists each Bought Server's facts and its margin at the day's rate", async () => {
    renderSection();

    const list = await table();
    const web = rowOf(list, "web-1");
    expect(web.textContent).toContain("Hopper Labs");
    expect(web.textContent).toContain("cpx22");
    expect(web.textContent).toContain("hel1");
    expect(web.textContent).toContain("Ready");
    expect(web.textContent).toContain("$25.00");
    expect(web.textContent).toContain("4242");
    expect(web.textContent).toContain("$5.29 · 21.2%");
    expect(web.textContent).not.toContain("Below floor");

    expect(
      screen.getByText(/Margins at 1\.16 USD per EUR, the ECB reference rate/),
    ).toBeTruthy();
  });

  it("flags a Bought Server under the margin floor", async () => {
    renderSection();

    const db = rowOf(await table(), "db-1");
    expect(within(db).getByText("Below floor")).toBeTruthy();
  });

  it("filters the list to those under the floor", async () => {
    renderSection();
    await table();

    fireEvent.click(screen.getByRole("button", { name: "Below floor (1)" }));

    const list = await table();
    expect(within(list).queryByText("web-1")).toBeNull();
    expect(within(list).getByText("db-1")).toBeTruthy();
  });

  it("says no margin is shown while the day's rate cannot be read", async () => {
    renderSection({
      ...LISTING,
      exchangeRate: null,
      servers: [{ ...WEB, margin: null }],
    });

    const web = rowOf(await table(), "web-1");
    expect(web.textContent).toContain("—");
    expect(
      screen.getByText(
        "The day's exchange rate cannot be read right now, so no margin is shown.",
      ),
    ).toBeTruthy();
  });

  it("shows the Server markup and the margin floor as stored", async () => {
    renderSection();

    expect(
      (
        (await screen.findByLabelText(
          "Server markup, in percent",
        )) as HTMLInputElement
      ).value,
    ).toBe("20");
    expect(
      (screen.getByLabelText("Margin floor, in percent") as HTMLInputElement)
        .value,
    ).toBe("10");
    expect(screen.getByText(/new purchases and new lines only/)).toBeTruthy();
  });

  it("saves a new markup and floor", async () => {
    api.setBoughtServerSettings.mockResolvedValue({
      ...SETTINGS,
      markupPercent: 25,
      marginFloorPercent: 12,
    });
    renderSection();

    fireEvent.change(
      await screen.findByLabelText("Server markup, in percent"),
      { target: { value: "25" } },
    );
    fireEvent.change(screen.getByLabelText("Margin floor, in percent"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(api.setBoughtServerSettings).toHaveBeenCalledWith({
        markupPercent: 25,
        marginFloorPercent: 12,
      }),
    );
    await waitFor(() => expect(invalidated).toHaveBeenCalled());
  });

  it("refuses a floor over 100% before asking the backend", async () => {
    renderSection();

    fireEvent.change(await screen.findByLabelText("Margin floor, in percent"), {
      target: { value: "150" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("At most 100%")).toBeTruthy();
    expect(api.setBoughtServerSettings).not.toHaveBeenCalled();
  });

  it("warns while the reverse-DNS domain is unset", async () => {
    renderSection(LISTING, { ...SETTINGS, reverseDnsDomain: null });

    expect(
      await screen.findByText(/The reverse-DNS domain is not set/),
    ).toBeTruthy();
  });

  it("does not warn once the reverse-DNS domain is set", async () => {
    renderSection();

    await screen.findByLabelText("Server markup, in percent");
    expect(screen.queryByText(/The reverse-DNS domain is not set/)).toBeNull();
  });
});
