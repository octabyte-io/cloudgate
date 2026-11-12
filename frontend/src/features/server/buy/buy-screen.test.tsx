import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Component } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { BoughtServerCatalogue } from "@/lib/api/endpoints/bought-servers";

const mode = vi.hoisted(() => ({
  current: { data: "hosted" as "hosted" | "self-hosted", isPending: false },
}));
const zone = vi.hoisted(() => ({ current: "Europe/Berlin" }));
const api = vi.hoisted(() => ({
  offer: vi.fn(),
  catalogue: vi.fn(),
  today: vi.fn(),
  buy: vi.fn(),
}));
const room = vi.hoisted(() => ({
  current: {
    canCreateMoreServers: true,
    code: null as string | null,
    message: null as string | null,
  },
}));
const push = vi.hoisted(() => vi.fn());
const NOT_FOUND = "NEXT_NOT_FOUND";

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => mode.current,
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
}));
vi.mock("@/lib/api/endpoints/bought-servers", () => ({
  boughtServersApi: api,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
  useRouter: () => ({ push }),
}));
vi.mock("@/lib/api/use-billing", () => ({
  useCanCreateServer: () => ({ data: room.current }),
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ boughtServers: () => Promise.resolve() }),
}));
vi.mock("./where-you-are", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./where-you-are")>()),
  browserTimeZone: () => zone.current,
}));

const { BuyScreen } = await import("./buy-screen");

/** A catalogue shaped as the backend answers it; the ids are the provider's codes. */
const CATALOGUE: BoughtServerCatalogue = {
  locations: [
    {
      id: "sin",
      city: "Singapore",
      country: "SG",
      latitude: 1.28,
      longitude: 103.83,
    },
    {
      id: "ash",
      city: "Ashburn, VA",
      country: "US",
      latitude: 39.05,
      longitude: -77.49,
    },
    {
      id: "hel1",
      city: "Helsinki",
      country: "FI",
      latitude: 60.17,
      longitude: 24.94,
    },
    {
      id: "nbg1",
      city: "Nuremberg",
      country: "DE",
      latitude: 49.45,
      longitude: 11.08,
    },
    {
      id: "fsn1",
      city: "Falkenstein",
      country: "DE",
      latitude: 50.48,
      longitude: 12.37,
    },
  ],
  sizes: [
    {
      id: "cx23",
      family: "shared",
      vcpus: 2,
      memoryGb: 4,
      diskGb: 40,
      offers: [
        { locationId: "fsn1", available: false, monthly: 9, backupsMonthly: 2 },
        { locationId: "nbg1", available: true, monthly: 9, backupsMonthly: 2 },
      ],
    },
    {
      id: "cx33",
      family: "shared",
      vcpus: 4,
      memoryGb: 8,
      diskGb: 80,
      offers: [
        { locationId: "fsn1", available: true, monthly: 14, backupsMonthly: 3 },
      ],
    },
    {
      id: "ccx13",
      family: "dedicated",
      vcpus: 2,
      memoryGb: 8,
      diskGb: 80,
      offers: [
        {
          locationId: "fsn1",
          available: true,
          monthly: 62,
          backupsMonthly: 13,
        },
        { locationId: "ash", available: true, monthly: 63, backupsMonthly: 13 },
        {
          locationId: "sin",
          available: false,
          monthly: 78,
          backupsMonthly: 16,
        },
      ],
    },
  ],
  storage: { minGb: 10, maxGb: 10240, perGbMonthly: 0.09204 },
};

class Boundary extends Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <p>caught: {this.state.error}</p>
    ) : (
      this.props.children
    );
  }
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Boundary>
        <BuyScreen />
      </Boundary>
    </QueryClientProvider>,
  );
}

const fetchSpy = vi.fn();

/** The Today box's answer: $15.20 now, to 1 December. */
const TODAY = {
  state: "plan" as const,
  plan: null,
  addOn: null,
  today: 1520,
  monthly: 6200,
  currency: "usd",
  from: Date.UTC(2026, 10, 10, 12) / 1000,
  to: Date.UTC(2026, 11, 1, 12) / 1000,
  prorationDate: 1_794_000_000,
};

/** Falkenstein's 2 vCPU · 8 GB dedicated size, which can be bought there. */
function chooseDedicated() {
  chooseCard("Falkenstein");
  fireEvent.click(screen.getByRole("button", { name: "Dedicated" }));
  fireEvent.click(
    screen.getByRole("radio", { name: "2 vCPU · 8 GB RAM · 80 GB disk" }),
  );
}

function buyButton() {
  return screen.getByRole("button", { name: "Buy" });
}

beforeEach(() => {
  api.offer.mockResolvedValue({ offered: true });
  api.catalogue.mockResolvedValue(CATALOGUE);
  api.today.mockResolvedValue(TODAY);
  api.buy.mockResolvedValue({
    id: "abc",
    stage: "waiting_for_payment",
    payUrl: null,
  });
  // Every request goes through the mocked endpoints module; anything that
  // reached the network instead would land here.
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  api.offer.mockReset();
  api.catalogue.mockReset();
  api.today.mockReset();
  api.buy.mockReset();
  push.mockReset();
  room.current = { canCreateMoreServers: true, code: null, message: null };
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  mode.current = { data: "hosted", isPending: false };
  zone.current = "Europe/Berlin";
});

/** Renders the page; the Location cards' text, in the order they are listed. */
async function cardOrder(): Promise<string[]> {
  renderScreen();
  const list = await screen.findByRole("list", {
    name: "Locations, nearest first",
  });
  return within(list)
    .getAllByRole("button")
    .map((card) => card.textContent ?? "");
}

function chooseCard(city: string) {
  const list = screen.getByRole("list", { name: "Locations, nearest first" });
  fireEvent.click(
    within(list)
      .getAllByRole("button")
      .find((card) => card.textContent?.startsWith(city))!,
  );
}

describe("BuyScreen", () => {
  it("lists Locations nearest first from the time zone, with Closest on the nearest", async () => {
    const order = await cardOrder();

    expect(order[0]).toMatch(/^FalkensteinClosest/);
    expect(order[1]).toMatch(/^Nuremberg/);
    expect(order[4]).toMatch(/^Singapore/);
    expect(order.filter((text) => text.includes("Closest"))).toHaveLength(1);
    expect(order[0]).toMatch(/about \d+ km/);
  });

  it("puts a customer in New York nearest Ashburn", async () => {
    zone.current = "America/New_York";

    const order = await cardOrder();

    expect(order[0]).toMatch(/^Ashburn, VAClosest/);
  });

  it("greys out a size sold out in the chosen Location, saying where", async () => {
    await cardOrder();
    chooseCard("Falkenstein");

    const row = screen.getByText("Unavailable in Falkenstein").closest("tr")!;
    expect(row.hasAttribute("data-unavailable")).toBe(true);
    expect((within(row).getByRole("radio") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(row.textContent).toContain("2 vCPU · 4 GB RAM · 40 GB disk");
    // The size in stock beside it can be picked.
    expect(
      (
        screen.getByRole("radio", {
          name: "4 vCPU · 8 GB RAM · 80 GB disk",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
  });

  it("puts the chosen size's price on each pin, greyed out where it cannot be bought", async () => {
    await cardOrder();
    chooseCard("Falkenstein");
    fireEvent.click(screen.getByRole("button", { name: "Dedicated" }));
    fireEvent.click(
      screen.getByRole("radio", { name: "2 vCPU · 8 GB RAM · 80 GB disk" }),
    );

    const map = screen.getByRole("group", {
      name: "World map of Server locations",
    });
    const off = (name: string) =>
      within(map).getByRole("button", { name }).getAttribute("data-off");
    expect(off("Falkenstein, $62/mo")).toBeNull();
    expect(off("Singapore, Unavailable")).toBe("true");
    expect(off("Helsinki, Not offered")).toBe("true");
  });

  it("totals the Server and its extras in the summary, with the warnings beside them", async () => {
    await cardOrder();
    chooseCard("Falkenstein");
    fireEvent.click(screen.getByRole("button", { name: "Dedicated" }));
    fireEvent.click(
      screen.getByRole("radio", { name: "2 vCPU · 8 GB RAM · 80 GB disk" }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Backups" }));
    fireEvent.change(screen.getByLabelText(/Extra storage/), {
      target: { value: "100" },
    });

    // 62 + 13 + tidy(100 × 0.09204 = 9.204) = 62 + 13 + 10
    expect(screen.getByText("Total per month").nextSibling?.textContent).toBe(
      "$85",
    );
    expect(
      screen.getByText(/Backups don.t include extra storage/),
    ).toBeTruthy();
    expect(screen.getByText(/Extra storage isn.t in backups/)).toBeTruthy();
  });

  it("says what is missing before a size is picked", async () => {
    await cardOrder();
    expect(screen.getByText("Pick a location.")).toBeTruthy();

    chooseCard("Falkenstein");

    expect(screen.getByText("Pick a size.")).toBeTruthy();
  });

  it("asks for the terms box once a size is picked", async () => {
    await cardOrder();
    chooseDedicated();

    expect(buyButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Tick the box to accept the terms.")).toBeTruthy();
  });

  describe("with the Server count full", () => {
    beforeEach(() => {
      // Buy no longer reads the count: the Add-on comes with the Server.
      room.current = {
        canCreateMoreServers: false,
        code: "ALLOWANCE_FULL",
        message: "This Organization has 3 Servers, all its plan allows.",
      };
      api.today.mockResolvedValue({
        ...TODAY,
        addOn: { quantity: 1, monthlyCents: 500 },
      });
    });

    it("adds the Add-on line to the summary, with a note saying why", async () => {
      await cardOrder();
      chooseDedicated();

      expect(
        await screen.findByText("Add-on: room for 1 more Server"),
      ).toBeTruthy();
      expect(screen.getByText("$67")).toBeTruthy();
      expect(
        screen.getByText(
          "Your Server count is full, so an Add-on is added with this one (room for 1 more Server, $5/month each). It is part of today's charge.",
        ),
      ).toBeTruthy();
    });

    it("still lets Buy be pressed", async () => {
      await cardOrder();
      chooseDedicated();
      fireEvent.click(screen.getByRole("checkbox"));

      await waitFor(() =>
        expect(buyButton().getAttribute("aria-disabled")).not.toBe("true"),
      );
      expect(
        screen.queryByText(
          "This Organization has 3 Servers, all its plan allows.",
        ),
      ).toBeNull();
    });
  });

  describe("the Today box in each plan state", () => {
    const TRIAL_END = Date.UTC(2026, 10, 20, 12) / 1000;

    it("in the Free trial, says the Server is charged on its own invoice to the trial's end", async () => {
      api.today.mockResolvedValue({
        ...TODAY,
        state: "trial",
        today: 833,
        to: TRIAL_END,
        addOn: { quantity: 1, monthlyCents: 500 },
      });
      await cardOrder();
      chooseDedicated();

      const box = await screen.findByLabelText("Today");
      expect(box.textContent).toContain("$8.33");
      expect(box.textContent).toContain(
        "The Free trial covers your plan, not the Server, so the Server is charged on its own invoice",
      );
      expect(box.textContent).toMatch(/to 20 November|to November 20/);
      expect(box.textContent).toContain(
        "Then it joins your plan's monthly invoice at $62.00 a month.",
      );
      expect(
        screen.getByText(/Like the plan, it costs nothing until the Free trial ends\./),
      ).toBeTruthy();
      expect(buyButton()).toBeTruthy();
    });

    it("with no plan and the Free trial available, reads Buy and start Free trial, and goes to Checkout", async () => {
      const assigned = { href: "" };
      vi.stubGlobal("location", assigned);
      api.today.mockResolvedValue({
        ...TODAY,
        state: "start-trial",
        today: 6200,
        to: Date.UTC(2026, 11, 10, 12) / 1000,
        plan: { name: "Starter", monthlyCents: 1500, todayCents: 0 },
      });
      api.buy.mockResolvedValue({
        id: "abc",
        stage: "waiting_for_payment",
        payUrl: "https://checkout.stripe.test/c/pay/cs_1#x",
      });
      await cardOrder();
      chooseDedicated();

      const button = await screen.findByRole("button", {
        name: "Buy and start Free trial",
      });
      expect(screen.getByText("Starter plan")).toBeTruthy();
      expect(screen.getByText("$77")).toBeTruthy();
      const box = screen.getByLabelText("Today");
      expect(box.textContent).toContain("$62.00");
      expect(box.textContent).toContain(
        "The trial covers Starter, not the Server, so the Server is charged today",
      );

      fireEvent.click(screen.getByRole("checkbox"));
      await waitFor(() =>
        expect(button.getAttribute("aria-disabled")).not.toBe("true"),
      );
      fireEvent.click(button);

      await waitFor(() =>
        expect(assigned.href).toBe("https://checkout.stripe.test/c/pay/cs_1#x"),
      );
      expect(push).not.toHaveBeenCalled();
    });

    it("with no plan and the Free trial used, says Starter and the Server are both paid today", async () => {
      api.today.mockResolvedValue({
        ...TODAY,
        state: "start-plan",
        today: 7700,
        to: null,
        plan: { name: "Starter", monthlyCents: 1500, todayCents: 1500 },
      });
      await cardOrder();
      chooseDedicated();

      const box = await screen.findByLabelText("Today");
      expect(box.textContent).toContain("$77.00");
      expect(box.textContent).toContain(
        "Starter ($15.00) and the Server are both paid today",
      );
      expect(screen.getByRole("button", { name: "Buy" })).toBeTruthy();
    });
  });

  it("shows today's charge and the dates it covers to the plan's renewal", async () => {
    await cardOrder();
    chooseDedicated();

    const box = await screen.findByLabelText("Today");
    expect(box.textContent).toContain("$15.20");
    expect(box.textContent).toMatch(/to 1 December|to December 1/);
    expect(box.textContent).toContain("Then $62.00 a month more.");
    expect(api.today).toHaveBeenCalledWith({
      serverType: "ccx13",
      location: "fsn1",
      backups: false,
    });
  });

  it("buys with the terms ticked and the Today box's moment, then goes to Servers", async () => {
    await cardOrder();
    chooseDedicated();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(buyButton().getAttribute("aria-disabled")).not.toBe("true"),
    );

    fireEvent.click(buyButton());

    await waitFor(() => expect(push).toHaveBeenCalledWith("/servers"));
    expect(api.buy.mock.calls[0][0]).toEqual({
      serverType: "ccx13",
      location: "fsn1",
      backups: false,
      termsAccepted: true,
      prorationDate: TODAY.prorationDate,
    });
  });

  it("buys backups with the Server, in today's charge, warning what turning them off does", async () => {
    await cardOrder();
    chooseDedicated();
    fireEvent.click(screen.getByRole("switch", { name: "Backups" }));
    fireEvent.click(screen.getByRole("checkbox"));

    expect(
      screen.getByText(
        /Backups don.t include extra storage. Turning backups off later deletes every backup at once./,
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(buyButton().getAttribute("aria-disabled")).not.toBe("true"),
    );
    expect(api.today).toHaveBeenLastCalledWith({
      serverType: "ccx13",
      location: "fsn1",
      backups: true,
    });

    fireEvent.click(buyButton());

    await waitFor(() => expect(push).toHaveBeenCalledWith("/servers"));
    expect(api.buy.mock.calls[0][0]).toMatchObject({
      serverType: "ccx13",
      location: "fsn1",
      backups: true,
    });
  });

  it("buys extra storage with the Server, in today's charge", async () => {
    await cardOrder();
    chooseDedicated();
    fireEvent.change(screen.getByLabelText(/Extra storage/), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() =>
      expect(buyButton().getAttribute("aria-disabled")).not.toBe("true"),
    );
    expect(api.today).toHaveBeenLastCalledWith({
      serverType: "ccx13",
      location: "fsn1",
      backups: false,
      storageGb: 100,
    });

    fireEvent.click(buyButton());

    await waitFor(() => expect(push).toHaveBeenCalledWith("/servers"));
    expect(api.buy.mock.calls[0][0]).toMatchObject({ storageGb: 100 });
  });

  it("keeps Buy off while extra storage is out of range, and says why", async () => {
    await cardOrder();
    chooseDedicated();
    fireEvent.change(screen.getByLabelText(/Extra storage/), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("checkbox"));

    expect(buyButton().getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText(
        "Extra storage is a whole number of GB from 10 to 10,240. Leave it empty for none.",
      ),
    ).toBeTruthy();
  });

  it("says why a refused payment bought nothing", async () => {
    api.buy.mockRejectedValue(
      new ApiError(
        402,
        "The payment was refused, so nothing was charged and no Server was bought. Your card was declined.",
        { code: "BOUGHT_SERVER_PAYMENT_REFUSED" },
      ),
    );
    await cardOrder();
    chooseDedicated();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(buyButton().getAttribute("aria-disabled")).not.toBe("true"),
    );

    fireEvent.click(buyButton());

    expect(
      await screen.findByText(/nothing was charged and no Server was bought/),
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows no provider code and names no provider", async () => {
    await cardOrder();
    chooseCard("Falkenstein");
    fireEvent.click(
      screen.getByRole("radio", { name: "4 vCPU · 8 GB RAM · 80 GB disk" }),
    );
    for (const family of ["Shared", "Shared Arm", "Shared AMD", "Dedicated"]) {
      fireEvent.click(screen.getByRole("button", { name: family }));
      expect(document.body.textContent).not.toMatch(
        /\b(cx|cax|cpx|ccx)\d+|\b(fsn1|nbg1|hel1|ash|sin)\b|hetzner/i,
      );
    }
  });

  it("never sends the position, guessed or asked for", async () => {
    const getCurrentPosition = vi.fn(
      (ok: (position: GeolocationPosition) => void) =>
        ok({
          coords: { latitude: 48.1, longitude: 11.6 },
        } as GeolocationPosition),
    );
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: { getCurrentPosition },
    });

    await cardOrder();
    fireEvent.click(screen.getByRole("button", { name: "Show where I am" }));

    await waitFor(() =>
      expect(screen.getByText(/from your browser/)).toBeTruthy(),
    );
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    // Each read is asked with nothing at all, and nothing else went out.
    for (const call of [...api.offer.mock.calls, ...api.catalogue.mock.calls]) {
      expect(call).toEqual([]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not ask the browser for a location until Show where I am is pressed", async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: { getCurrentPosition },
    });

    await cardOrder();

    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("does not exist on a Self-hosted instance", async () => {
    mode.current = { data: "self-hosted", isPending: false };

    renderScreen();

    expect(await screen.findByText(`caught: ${NOT_FOUND}`)).toBeTruthy();
    expect(api.offer).not.toHaveBeenCalled();
    expect(api.catalogue).not.toHaveBeenCalled();
  });

  it("does not exist while buying is not offered", async () => {
    api.offer.mockResolvedValue({ offered: false });

    renderScreen();

    expect(await screen.findByText(`caught: ${NOT_FOUND}`)).toBeTruthy();
    expect(api.catalogue).not.toHaveBeenCalled();
  });
});
