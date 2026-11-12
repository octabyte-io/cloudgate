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

import { ApiError } from "@/lib/api/api-error";
import type {
  OperatorBoughtServer,
  OperatorBoughtServers,
  RepricePreview,
} from "@/lib/api/endpoints/operator";

const api = vi.hoisted(() => ({
  boughtServers: vi.fn(),
  boughtServerSettings: vi.fn(),
  setBoughtServerSettings: vi.fn(),
  previewReprice: vi.fn(),
  reprice: vi.fn(),
}));
const invalidated = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/endpoints/operator", () => ({ operatorApi: api }));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ operatorBoughtServers: invalidated }),
}));

const { BoughtServersSection } = await import("./bought-servers-section");

afterEach(() => {
  cleanup();
  for (const fn of Object.values(api)) fn.mockReset();
  invalidated.mockReset();
});

const WEB: OperatorBoughtServer = {
  id: "bs-web",
  name: "web-1",
  organization: { id: "org-hopper", name: "Hopper Labs" },
  serverType: "cpx22",
  location: "hel1",
  stage: "ready",
  monthlyCents: 2200,
  providerServerId: 4242,
  margin: null,
  belowFloor: false,
  createdAt: "2026-11-01T09:00:00.000Z",
  poweredOff: null,
};
const DB: OperatorBoughtServer = {
  ...WEB,
  id: "bs-db",
  name: "db-1",
  monthlyCents: 2500,
};
const LISTING: OperatorBoughtServers = {
  exchangeRate: null,
  costsRead: true,
  marginFloorPercent: 10,
  servers: [WEB, DB],
};

const RISE: RepricePreview = {
  id: "bs-web",
  name: "web-1",
  organization: { id: "org-hopper", name: "Hopper Labs" },
  stage: "ready",
  status: "rise",
  oldMonthlyCents: 2200,
  newMonthlyCents: 2500,
  startsAt: "2026-12-10T09:00:00.000Z",
  lines: [{ kind: "server", oldMonthlyCents: 2200, newMonthlyCents: 2500 }],
};
const UNCHANGED: RepricePreview = {
  ...RISE,
  id: "bs-db",
  name: "db-1",
  status: "unchanged",
  oldMonthlyCents: 2500,
  startsAt: null,
  lines: [],
};

function renderSection() {
  api.boughtServers.mockResolvedValue(LISTING);
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

async function chooseAll() {
  await screen.findByRole("table", { name: "Bought Servers on this instance" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select web-1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select db-1" }));
}

/**
 * The Operator's reprice (#1400): choose Bought Servers, preview each one's
 * old and new price, and confirm exactly what the preview showed.
 */
describe("RepriceModal", () => {
  it("previews each chosen Bought Server's old and new price and when it applies", async () => {
    api.previewReprice.mockResolvedValue([RISE, UNCHANGED]);
    renderSection();
    await chooseAll();

    fireEvent.click(screen.getByRole("button", { name: "Reprice chosen (2)" }));

    const preview = await screen.findByRole("table", {
      name: "The reprice of the chosen Bought Servers",
    });
    expect(api.previewReprice).toHaveBeenCalledWith(["bs-web", "bs-db"]);
    const web = within(preview).getByText("web-1").closest("tr")!;
    expect(web.textContent).toContain("$22.00");
    expect(web.textContent).toContain("$25.00");
    expect(web.textContent).toContain("Rise");
    const db = within(preview).getByText("db-1").closest("tr")!;
    expect(db.textContent).toContain("Already at the list price");
  });

  it("confirms only the Bought Servers with a new price, at the price previewed", async () => {
    api.previewReprice.mockResolvedValue([RISE, UNCHANGED]);
    api.reprice.mockResolvedValue([RISE]);
    renderSection();
    await chooseAll();
    fireEvent.click(screen.getByRole("button", { name: "Reprice chosen (2)" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Reprice 1 Bought Server" }),
    );

    await waitFor(() =>
      expect(api.reprice).toHaveBeenCalledWith([
        { id: "bs-web", newMonthlyCents: 2500 },
      ]),
    );
    await waitFor(() => expect(invalidated).toHaveBeenCalled());
  });

  it("says why a confirm was refused and asks for the preview again", async () => {
    api.previewReprice.mockResolvedValue([RISE]);
    api.reprice.mockRejectedValue(
      new ApiError(
        409,
        "The price of web-1 changed since the preview: preview again",
        { code: "PRICES_CHANGED" },
      ),
    );
    renderSection();
    await chooseAll();
    fireEvent.click(screen.getByRole("button", { name: "Reprice chosen (2)" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Reprice 1 Bought Server" }),
    );

    expect(
      await screen.findByText(/The price of web-1 changed since the preview/),
    ).toBeTruthy();
    await waitFor(() => expect(api.previewReprice).toHaveBeenCalledTimes(2));
  });

  it("offers no reprice until a Bought Server is chosen", async () => {
    renderSection();
    await screen.findByRole("table", {
      name: "Bought Servers on this instance",
    });

    fireEvent.click(screen.getByRole("button", { name: "Reprice chosen (0)" }));

    expect(api.previewReprice).not.toHaveBeenCalled();
  });
});
